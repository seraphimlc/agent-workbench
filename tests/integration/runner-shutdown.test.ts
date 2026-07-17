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
import type {
  RunnerBinding,
  RunnerRequest,
} from '../../packages/protocol/src/runner.js';
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
import { Scheduler, type Claim } from '../../services/daemon/src/runtime/scheduler.js';
import { SessionService } from '../../services/daemon/src/runtime/session-service.js';
import { DaemonServer } from '../../services/daemon/src/server.js';

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

type BlockingModelAdapter = {
  call(input: { readonly signal: AbortSignal }): Promise<never>;
};

type RunnerSupervisorModule = {
  createRunnerExecutionDriver(options: {
    readonly dataDir: string;
    readonly runnerEntryPoint: string;
    readonly modelAdapter: unknown;
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

type DriverWithSupervisor = ExecutionDriver & {
  supervisor: {
    createBinding(claim: Claim): RunnerBinding;
    start(binding: RunnerBinding): Promise<unknown>;
  };
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

class ConcurrentBlockedAdapter implements BlockingModelAdapter {
  private readonly startedBarrier = deferred<void>();
  private callCount = 0;

  get started(): Promise<void> {
    return this.startedBarrier.promise;
  }

  async call(input: { readonly signal: AbortSignal }): Promise<never> {
    this.callCount += 1;
    if (this.callCount === 2) this.startedBarrier.resolve(undefined);
    return await new Promise<never>((_resolve, reject) => {
      input.signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { code: 'MODEL_STREAM_INTERRUPTED' })),
        { once: true },
      );
    });
  }
}

const runnerRequest = (
  binding: RunnerBinding,
  method: 'runner.ready' | 'model.call' | 'turn.complete',
  payload: Record<string, unknown>,
): RunnerRequest =>
  ({
    kind: 'request',
    protocolVersion: 1,
    requestId: `${binding.runnerInstanceId}-${method}`,
    traceId: `${binding.runnerInstanceId}-trace`,
    sessionId: binding.sessionId,
    turnId: binding.turnId,
    method,
    payload,
  }) as RunnerRequest;

class DeferredRunnerExecution {
  private readonly completionBarrier = deferred<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>();
  private readonly terminalCommittedBarrier = deferred<void>();
  private readonly requests: RunnerRequest[];
  private nextRequestResolve: ((request: RunnerRequest) => void) | undefined;

  readonly ready = Promise.resolve();
  readonly completion = this.completionBarrier.promise;
  readonly terminalCommitted = this.terminalCommittedBarrier.promise;

  constructor(private readonly binding: RunnerBinding) {
    this.requests = [runnerRequest(binding, 'runner.ready', {})];
  }

  nextRequest(): Promise<RunnerRequest> {
    const next = this.requests.shift();
    if (next) return Promise.resolve(next);
    return new Promise<RunnerRequest>((resolvePromise) => {
      this.nextRequestResolve = resolvePromise;
    });
  }

  respond(response: unknown): void {
    const method =
      typeof response === 'object' && response !== null && 'method' in response
        ? response.method
        : undefined;
    if (method === 'model.call') {
      const result =
        typeof response === 'object' && response !== null && 'result' in response
          ? response.result
          : undefined;
      const modelAttemptId =
        typeof result === 'object' && result !== null && 'modelAttemptId' in result
          ? result.modelAttemptId
          : undefined;
      if (typeof modelAttemptId === 'string') {
        this.enqueue(runnerRequest(this.binding, 'turn.complete', { modelAttemptId }));
      }
    }
    if (method === 'turn.complete') this.terminalCommittedBarrier.resolve(undefined);
  }

  beginCompletion(): void {
    this.enqueue(runnerRequest(this.binding, 'model.call', { messages: [] }));
  }

  releaseCompletion(): void {
    this.completionBarrier.resolve({ code: 0, signal: null });
  }

  fence(): void {}

  closeDaemonInput(): void {}

  kill(): void {
    this.releaseCompletion();
  }

  private enqueue(request: RunnerRequest): void {
    const resolvePromise = this.nextRequestResolve;
    this.nextRequestResolve = undefined;
    if (resolvePromise) {
      resolvePromise(request);
    } else {
      this.requests.push(request);
    }
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

  it('starts two distinct claims through the production Driver before either run settles', async () => {
    const { createRunnerExecutionDriver } = await loadSupervisor();
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const workspacePath = join(runtime.rootDir, 'concurrent-driver-workspace');
    mkdirSync(workspacePath);
    const sessions = new SessionService(database);
    const workspace = sessions.registerWorkspace(
      { path: workspacePath },
      'concurrent-driver-workspace',
    );
    sessions.createSession(
      {
        workspaceId: workspace.workspaceId,
        title: 'First driver execution',
        prompt: 'Run with the second execution',
      },
      'concurrent-driver-first',
    );
    sessions.createSession(
      {
        workspaceId: workspace.workspaceId,
        title: 'Second driver execution',
        prompt: 'Run with the first execution',
      },
      'concurrent-driver-second',
    );
    const scheduler = new Scheduler(database, { daemonEpoch: 'concurrent-driver-daemon' });
    const first = scheduler.claimNext();
    const second = scheduler.claimNext();
    database.close();
    if (!first || !second) throw new Error('Expected two concurrent claims');

    const adapter = new ConcurrentBlockedAdapter();
    const executionDriver = createRunnerExecutionDriver({
      dataDir: runtime.dataDir,
      runnerEntryPoint,
      modelAdapter: adapter,
      provider: {
        endpoint: 'https://provider.example.test/v1/chat/completions',
        modelId: 'concurrent-driver-model',
        apiKey: 'concurrent-driver-key',
      },
    });

    try {
      const [firstRun, secondRun] = await Promise.all([
        executionDriver.start(first),
        executionDriver.start(second),
      ]);
      await adapter.started;

      expect(firstRun).toBeDefined();
      expect(secondRun).toBeDefined();
    } finally {
      await executionDriver.shutdown();
    }
  });

  it('isolates one concurrent start failure while the other run remains live', async () => {
    const { createRunnerExecutionDriver } = await loadSupervisor();
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const workspacePath = join(runtime.rootDir, 'isolated-start-failure-workspace');
    mkdirSync(workspacePath);
    const sessions = new SessionService(database);
    const workspace = sessions.registerWorkspace(
      { path: workspacePath },
      'isolated-start-failure-workspace',
    );
    sessions.createSession(
      {
        workspaceId: workspace.workspaceId,
        title: 'Rejected driver execution',
        prompt: 'Fail launch marker only',
      },
      'isolated-start-failure-first',
    );
    sessions.createSession(
      {
        workspaceId: workspace.workspaceId,
        title: 'Live driver execution',
        prompt: 'Remain live after the other start fails',
      },
      'isolated-start-failure-second',
    );
    const scheduler = new Scheduler(database, { daemonEpoch: 'isolated-start-failure-daemon' });
    const first = scheduler.claimNext();
    const second = scheduler.claimNext();
    database.close();
    if (!first || !second) throw new Error('Expected two concurrent claims');

    const adapter = new BlockedAdapter();
    const executionDriver = createRunnerExecutionDriver({
      dataDir: runtime.dataDir,
      runnerEntryPoint,
      modelAdapter: adapter,
      provider: {
        endpoint: 'https://provider.example.test/v1/chat/completions',
        modelId: 'isolated-start-failure-model',
        apiKey: 'isolated-start-failure-key',
      },
    });

    try {
      const rejected = executionDriver.start({ ...first, leaseId: 'missing-lease' });
      const live = executionDriver.start(second);

      await expect(rejected).rejects.toMatchObject({
        code: 'RUNNER_LAUNCH_MARKER_PERSIST_FAILED',
      });
      const liveRun = await live;
      await adapter.started;
      expect(liveRun).toBeDefined();
    } finally {
      await executionDriver.shutdown();
    }
  });

  it('keeps a slot-reusing run registered after an older completion settles late', async () => {
    const { createRunnerExecutionDriver } = await loadSupervisor();
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const workspacePath = join(runtime.rootDir, 'late-completion-workspace');
    mkdirSync(workspacePath);
    const sessions = new SessionService(database);
    const workspace = sessions.registerWorkspace(
      { path: workspacePath },
      'late-completion-workspace',
    );
    for (const [title, clientRequestId] of [
      ['Delayed completion', 'late-completion-first'],
      ['Other slot occupant', 'late-completion-second'],
      ['Slot reuser', 'late-completion-third'],
    ] as const) {
      sessions.createSession(
        { workspaceId: workspace.workspaceId, title, prompt: title },
        clientRequestId,
      );
    }
    const scheduler = new Scheduler(database, { daemonEpoch: 'late-completion-daemon' });
    const first = scheduler.claimNext();
    const occupiedSecondSlot = scheduler.claimNext();
    if (!first || !occupiedSecondSlot) throw new Error('Expected two occupied slots');

    const executions = new Map<string, DeferredRunnerExecution>();
    let runnerOrdinal = 0;
    const executionDriver = createRunnerExecutionDriver({
      dataDir: runtime.dataDir,
      runnerEntryPoint,
      modelAdapter: {
        call: async () => ({
          finishReason: 'stop' as const,
          content: 'done',
          toolCalls: [],
          providerRequestId: 'deferred-runner',
          usage: null,
        }),
      },
      provider: {
        endpoint: 'https://provider.example.test/v1/chat/completions',
        modelId: 'late-completion-model',
        apiKey: 'late-completion-key',
      },
    }) as DriverWithSupervisor;
    Object.defineProperty(executionDriver, 'supervisor', {
      value: {
        createBinding: (claim: Claim): RunnerBinding => {
          runnerOrdinal += 1;
          return {
            runnerInstanceId: `deferred-runner-${String(runnerOrdinal)}`,
            capability: 'deferred-capability',
            daemonEpoch: claim.daemonEpoch,
            sessionId: claim.sessionId,
            turnId: claim.turnId,
            leaseId: claim.leaseId,
            leaseEpoch: claim.leaseEpoch,
            executionFence: claim.executionFence,
          };
        },
        start: async (binding: RunnerBinding) => {
          const execution = new DeferredRunnerExecution(binding);
          executions.set(binding.turnId, execution);
          return execution;
        },
      },
    });

    try {
      await executionDriver.start(first);
      const firstExecution = executions.get(first.turnId);
      if (!firstExecution) throw new Error('Expected first deferred execution');
      firstExecution.beginCompletion();
      await firstExecution.terminalCommitted;

      const reuser = scheduler.claimNext();
      if (!reuser) throw new Error('Expected a claim for the released first slot');
      expect(reuser.slotNo).toBe(first.slotNo);
      expect(reuser.turnId).not.toBe(first.turnId);
      const reuserRun = await executionDriver.start(reuser);
      const reuserExecution = executions.get(reuser.turnId);
      if (!reuserExecution) throw new Error('Expected slot-reusing deferred execution');

      firstExecution.releaseCompletion();
      await Promise.resolve();
      await expect(executionDriver.start(reuser)).rejects.toMatchObject({
        code: 'RUNNER_START_REJECTED',
      });

      reuserExecution.beginCompletion();
      await reuserExecution.terminalCommitted;
      reuserExecution.releaseCompletion();
      await reuserRun.completion;
    } finally {
      await executionDriver.shutdown();
      database.close();
    }
  });

  it('quiesces, fences, aborts, reaps, and interrupts every active Runner before closing SQLite and the lock', async () => {
    await loadSupervisor();
    const { createRunnerExecutionDriver } = await loadSupervisor();
    runtime = createTempRuntime();
    const phases: string[] = [];
    const adapter = new ConcurrentBlockedAdapter();
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
        ).toEqual({ count: 2 });
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM model_attempts WHERE status = 'interrupted'")
            .get(),
        ).toEqual({ count: 2 });
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
    const secondSessionResponse = await client.sendRequest(
      mutationRequest(
        client,
        'session.create',
        {
          workspaceId: workspace.workspaceId,
          title: 'Second Shutdown Runner',
          prompt: 'Block alongside the first streamed model request',
        },
        'shutdown-session-second',
      ),
    );
    if (!secondSessionResponse.ok) {
      throw new Error('second session.create failed');
    }
    const secondCreated = SessionCreateResultSchema.parse(secondSessionResponse.result);
    await adapter.started;

    await server.stop();
    server = undefined;
    expect(closed).toBe(true);
    expect(phases).toEqual([
      'coordinator.quiesced',
      'runner.fenced',
      'runner.fenced',
      'model.abort_requested',
      'model.abort_requested',
      'runner.reaped',
      'runner.reaped',
      'turn.interrupted_committed',
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
        inspection.prepare('SELECT status FROM turns WHERE id = ?').get(secondCreated.turnId),
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
