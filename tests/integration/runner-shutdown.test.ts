import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SessionCreateResultSchema,
  WorkspaceRegisterResultSchema,
  type RpcRequestEnvelope,
} from '../../packages/protocol/src/index.js';
import {
  connectRpcClient,
  type RpcClient,
} from '../../packages/testkit/src/rpc-client.js';
import {
  createTempRuntime,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import { openRuntimeDatabase } from '../../services/daemon/src/db/database.js';
import type {
  ExecutionDriver,
  ExecutionRun,
} from '../../services/daemon/src/runtime/execution-coordinator.js';
import { Scheduler } from '../../services/daemon/src/runtime/scheduler.js';
import { SessionService } from '../../services/daemon/src/runtime/session-service.js';
import { DaemonServer } from '../../services/daemon/src/server.js';

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

type BlockingModelAdapter = {
  readonly started: Promise<void>;
  call(input: { readonly signal: AbortSignal }): Promise<never>;
};

type RunnerSupervisorModule = {
  createRunnerExecutionDriver(options: {
    readonly dataDir: string;
    readonly runnerEntryPoint: string;
    readonly modelAdapter: BlockingModelAdapter;
    readonly provider: {
      readonly endpoint: string;
      readonly modelId: string;
      readonly apiKey: string;
    };
    readonly hooks?: {
      readonly onPhase: (phase: string) => void;
    };
  }): ExecutionDriver;
};

const MODULE_PATH = '../../services/daemon/src/runtime/runner-supervisor.js';
const runnerEntryPoint = fileURLToPath(
  new URL('../../runtimes/session-runner/src/index.ts', import.meta.url),
);
const BOOTSTRAP_SECRET = Buffer.alloc(32, 0x73);

const loadSupervisor = async (): Promise<RunnerSupervisorModule> =>
  (await import(MODULE_PATH)) as unknown as RunnerSupervisorModule;

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

class BlockedAdapter implements BlockingModelAdapter {
  private readonly startedBarrier = deferred<void>();
  readonly started = this.startedBarrier.promise;

  async call(input: { readonly signal: AbortSignal }): Promise<never> {
    this.startedBarrier.resolve(undefined);
    return await new Promise<never>((_resolve, reject) => {
      input.signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { code: 'MODEL_STREAM_INTERRUPTED' })),
        { once: true },
      );
    });
  }
}

const mutationRequest = (
  client: RpcClient,
  method: 'workspace.register' | 'session.create',
  payload: unknown,
  clientRequestId: string,
  sessionId: string | null = null,
): RpcRequestEnvelope => ({
  ...client.createRequest(method, payload),
  sessionId,
  clientRequestId,
});

describe('Daemon shutdown with an active Runner', () => {
  let runtime: TempRuntime | undefined;
  let server: DaemonServer | undefined;
  let client: RpcClient | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
    await server?.stop().catch(() => undefined);
    server = undefined;
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('awaits and cancels a same-tick pending start before shutdown settles', async () => {
    const { createRunnerExecutionDriver } = await loadSupervisor();
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const workspacePath = join(runtime.rootDir, 'pending-start-workspace');
    mkdirSync(workspacePath);
    const service = new SessionService(database);
    const workspace = service.registerWorkspace(
      { path: workspacePath },
      'pending-start-workspace',
    );
    const created = service.createSession(
      {
        workspaceId: workspace.workspaceId,
        title: 'Pending start shutdown',
        prompt: 'Do not survive shutdown',
      },
      'pending-start-session',
    );
    const claim = new Scheduler(database, {
      daemonEpoch: 'pending-start-daemon',
    }).claimNext();
    database.close();
    if (!claim) throw new Error('Expected pending-start claim');

    let modelCallCount = 0;
    const adapter: BlockingModelAdapter = {
      started: Promise.resolve(),
      call: async () => {
        modelCallCount += 1;
        throw Object.assign(new Error('model call must not survive shutdown'), {
          code: 'MODEL_CALL_AFTER_SHUTDOWN',
        });
      },
    };
    const executionDriver = createRunnerExecutionDriver({
      dataDir: runtime.dataDir,
      runnerEntryPoint,
      modelAdapter: adapter,
      provider: {
        endpoint: 'https://provider.example.test/v1/chat/completions',
        modelId: 'pending-start-model',
        apiKey: 'pending-start-key',
      },
    });
    let startSettled = false;
    let returnedRun: ExecutionRun | undefined;
    const startOutcome = executionDriver.start(claim).then(
      (execution) => {
        returnedRun = execution;
        startSettled = true;
        return { status: 'resolved' as const };
      },
      (error: unknown) => {
        startSettled = true;
        return { status: 'rejected' as const, error };
      },
    );
    const shutdown = executionDriver.shutdown();

    await shutdown;
    const shutdownObservedStartSettled = startSettled;
    const outcome = await startOutcome;
    await returnedRun?.completion;

    expect(shutdownObservedStartSettled).toBe(true);
    expect(outcome).toEqual({ status: 'resolved' });
    expect(returnedRun).toBeDefined();
    expect(modelCallCount).toBe(0);
    const inspection = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    try {
      expect(
        inspection.prepare('SELECT status FROM turns WHERE id = ?').get(created.turnId),
      ).toEqual({ status: 'interrupted' });
      const lease = inspection
        .prepare('SELECT status, pid FROM runner_leases WHERE id = ?')
        .get(claim.leaseId) as { readonly status: string; readonly pid: number | null };
      expect(lease.status).toBe('expired');
      if (lease.pid !== null) {
        expect(() => process.kill(lease.pid as number, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        );
      }
    } finally {
      inspection.close();
    }
  });

  it('quiesces, fences, aborts, reaps, atomically interrupts, then closes SQLite and the lock', async () => {
    await loadSupervisor();
    const { createRunnerExecutionDriver } = await loadSupervisor();
    runtime = createTempRuntime();
    const phases: string[] = [];
    const adapter = new BlockedAdapter();
    const executionDriver = createRunnerExecutionDriver({
      dataDir: runtime.dataDir,
      runnerEntryPoint,
      modelAdapter: adapter,
      provider: {
        endpoint: 'https://provider.example.test/v1/chat/completions',
        modelId: 'shutdown-model',
        apiKey: 'shutdown-provider-key',
      },
      hooks: { onPhase: (phase) => phases.push(phase) },
    });
    let closed = false;
    server = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: BOOTSTRAP_SECRET,
      executionDriver,
      closeDatabase: (database: Database.Database) => {
        phases.push('database.close');
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM turns WHERE status = 'running'").get(),
        ).toEqual({ count: 0 });
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM model_calls WHERE status = 'running'")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM model_attempts WHERE status = 'running'")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM model_calls WHERE status = 'interrupted'").get(),
        ).toEqual({ count: 1 });
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM model_attempts WHERE status = 'interrupted'")
            .get(),
        ).toEqual({ count: 1 });
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM session_events WHERE type = 'model.failed'").get(),
        ).toEqual({ count: 0 });
        database.close();
        closed = true;
      },
    });
    await server.start();
    client = await connectRpcClient(runtime.socketPath);
    const auth = await client.authenticate(BOOTSTRAP_SECRET);
    if (!auth.ok) {
      throw new Error('Authentication failed');
    }
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const workspaceResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: workspacePath },
        'shutdown-workspace',
      ),
    );
    if (!workspaceResponse.ok) {
      throw new Error('workspace.register failed');
    }
    const workspace = WorkspaceRegisterResultSchema.parse(workspaceResponse.result);
    const sessionResponse = await client.sendRequest(
      mutationRequest(
        client,
        'session.create',
        {
          workspaceId: workspace.workspaceId,
          title: 'Shutdown Runner',
          prompt: 'Block in a streamed model request',
        },
        'shutdown-session',
      ),
    );
    if (!sessionResponse.ok) {
      throw new Error('session.create failed');
    }
    const created = SessionCreateResultSchema.parse(sessionResponse.result);
    await adapter.started;

    await server.stop();
    server = undefined;
    expect(closed).toBe(true);
    expect(phases).toEqual([
      'coordinator.quiesced',
      'runner.fenced',
      'model.abort_requested',
      'runner.reaped',
      'turn.interrupted_committed',
      'database.close',
      'runtime_lock.released',
    ]);

    const inspection = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    try {
      expect(
        inspection.prepare('SELECT status FROM turns WHERE id = ?').get(created.turnId),
      ).toEqual({ status: 'interrupted' });
      expect(
        inspection
          .prepare("SELECT COUNT(*) AS count FROM model_calls WHERE status = 'running'")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        inspection
          .prepare("SELECT COUNT(*) AS count FROM model_attempts WHERE status = 'running'")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        inspection
          .prepare(
            `SELECT type FROM session_events
             WHERE turn_id = ? AND type IN (
               'model.attempt_interrupted', 'model.interrupted', 'model.failed'
             ) ORDER BY seq`,
          )
          .all(created.turnId),
      ).toEqual([
        { type: 'model.attempt_interrupted' },
        { type: 'model.interrupted' },
      ]);
      expect(inspection.pragma('foreign_key_check')).toEqual([]);
    } finally {
      inspection.close();
    }
  });
});
