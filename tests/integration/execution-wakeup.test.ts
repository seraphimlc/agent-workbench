import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
import {
  acquireRuntimeDatabase,
  openRuntimeDatabase,
} from '../../services/daemon/src/db/database.js';
import type {
  ExecutionDriver,
  ExecutionRun,
} from '../../services/daemon/src/runtime/execution-coordinator.js';
import type { Claim } from '../../services/daemon/src/runtime/scheduler.js';
import { SessionService } from '../../services/daemon/src/runtime/session-service.js';
import { DaemonServer } from '../../services/daemon/src/server.js';
import { afterEach, describe, expect, it } from 'vitest';

const BOOTSTRAP_SECRET = Buffer.alloc(32, 0x61);

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

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

const waitFor = async (
  predicate: () => boolean,
  diagnostic: string,
): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${diagnostic}`);
    }
    await new Promise<void>((resolvePromise) => {
      setImmediate(resolvePromise);
    });
  }
};

const settleScheduledWork = async (): Promise<void> => {
  await new Promise<void>((resolvePromise) => {
    setImmediate(() => setImmediate(resolvePromise));
  });
};

const mutationRequest = (
  client: RpcClient,
  method: 'workspace.register' | 'session.create' | 'turn.enqueue',
  payload: unknown,
  clientRequestId: string,
  sessionId: string | null = null,
): RpcRequestEnvelope => ({
  ...client.createRequest(method, payload),
  sessionId,
  clientRequestId,
});

const authenticate = async (
  runtime: TempRuntime,
): Promise<RpcClient> => {
  const client = await connectRpcClient(runtime.socketPath);
  const response = await client.authenticate(BOOTSTRAP_SECRET);
  if (!response.ok) {
    throw new Error('Test client authentication failed');
  }
  return client;
};

type DriverStart = {
  readonly claim: Claim;
  readonly completion: Deferred<void>;
};

class RecordingDriver implements ExecutionDriver {
  readonly starts: DriverStart[] = [];
  readonly failuresBeforeReady: boolean[] = [];
  shutdownCalls = 0;

  constructor(failuresBeforeReady: readonly boolean[] = []) {
    this.failuresBeforeReady.push(...failuresBeforeReady);
  }

  async start(claim: Claim): Promise<ExecutionRun> {
    if (this.failuresBeforeReady.shift() === true) {
      throw new Error('injected pre-READY failure');
    }
    const completion = deferred<void>();
    this.starts.push({ claim, completion });
    return { completion: completion.promise };
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    for (const start of this.starts) {
      start.completion.resolve(undefined);
    }
    await settleScheduledWork();
  }
}

describe('Daemon execution wakeups', () => {
  let runtime: TempRuntime | undefined;
  let server: DaemonServer | undefined;
  const clients: RpcClient[] = [];

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(async (client) => await client.close()));
    await server?.stop().catch(() => undefined);
    server = undefined;
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('claims persisted work only after the first authenticated control client', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'persisted-workspace');
    mkdirSync(workspacePath);
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const persisted = new SessionService(database);
    const workspace = persisted.registerWorkspace(
      { path: workspacePath },
      'persisted-workspace',
    );
    const created = persisted.createSession(
      {
        workspaceId: workspace.workspaceId,
        title: 'Persisted queue',
        prompt: 'Claim after auth',
      },
      'persisted-session',
    );
    database.close();
    const driver = new RecordingDriver();
    server = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: BOOTSTRAP_SECRET,
      executionDriver: driver,
    });
    await server.start();

    const client = await connectRpcClient(runtime.socketPath);
    clients.push(client);
    await client.waitForChallenge();
    await settleScheduledWork();
    expect(driver.starts).toEqual([]);

    const auth = await client.authenticate(BOOTSTRAP_SECRET);
    expect(auth.ok).toBe(true);
    await waitFor(() => driver.starts.length === 1, 'persisted Turn claim after auth');
    expect(driver.starts[0]?.claim.turnId).toBe(created.turnId);
    expect(driver.starts[0]?.claim.executionFence).toBe(1);
  });

  it('wakes only after committed session.create and turn.enqueue mutations', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'rpc-workspace');
    mkdirSync(workspacePath);
    const driver = new RecordingDriver([true]);
    server = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: BOOTSTRAP_SECRET,
      executionDriver: driver,
    });
    await server.start();
    const client = await authenticate(runtime);
    clients.push(client);

    const workspaceResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: workspacePath },
        'wakeup-workspace',
      ),
    );
    if (!workspaceResponse.ok) {
      throw new Error('workspace.register failed');
    }
    const workspace = WorkspaceRegisterResultSchema.parse(workspaceResponse.result);
    await settleScheduledWork();
    expect(driver.starts).toEqual([]);

    const sessionResponse = await client.sendRequest(
      mutationRequest(
        client,
        'session.create',
        {
          workspaceId: workspace.workspaceId,
          title: 'Committed wake',
          prompt: 'First start fails',
        },
        'wakeup-session',
      ),
    );
    if (!sessionResponse.ok) {
      throw new Error('session.create failed');
    }
    const created = SessionCreateResultSchema.parse(sessionResponse.result);
    const inspection = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    try {
      await waitFor(
        () =>
          (
            inspection
              .prepare('SELECT status FROM turns WHERE id = ?')
              .get(created.turnId) as { readonly status: string }
          ).status === 'failed',
        'atomic RUNNER_START_FAILED terminalization',
      );
      expect(
        inspection
          .prepare('SELECT status, error_code, execution_fence FROM turns WHERE id = ?')
          .get(created.turnId),
      ).toEqual({
        status: 'failed',
        error_code: 'RUNNER_START_FAILED',
        execution_fence: 2,
      });
      expect(inspection.prepare('SELECT state, owner_turn_id FROM scheduler_slots').get()).toEqual({
        state: 'free',
        owner_turn_id: null,
      });

      const enqueueResponse = await client.sendRequest(
        mutationRequest(
          client,
          'turn.enqueue',
          { sessionId: created.sessionId, prompt: 'Second start remains active' },
          'wakeup-enqueue',
          created.sessionId,
        ),
      );
      if (!enqueueResponse.ok) {
        throw new Error('turn.enqueue failed');
      }
      const queuedTurnId = (enqueueResponse.result as { readonly turnId: string }).turnId;
      await waitFor(() => driver.starts.length === 1, 'turn.enqueue execution wake');
      expect(driver.starts[0]?.claim.turnId).toBe(queuedTurnId);
    } finally {
      inspection.close();
    }
  });

  it('keeps queued Turns untouched when no execution dependencies are injected', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'no-dependencies-workspace');
    mkdirSync(workspacePath);
    server = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    await server.start();
    const client = await authenticate(runtime);
    clients.push(client);
    const workspaceResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: workspacePath },
        'no-dependencies-workspace',
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
          title: 'No execution dependencies',
          prompt: 'Stay queued',
        },
        'no-dependencies-session',
      ),
    );
    if (!sessionResponse.ok) {
      throw new Error('session.create failed');
    }
    const created = SessionCreateResultSchema.parse(sessionResponse.result);
    await settleScheduledWork();

    const inspection = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    try {
      expect(
        inspection
          .prepare('SELECT status, execution_fence FROM turns WHERE id = ?')
          .get(created.turnId),
      ).toEqual({ status: 'queued', execution_fence: 0 });
      expect(inspection.prepare('SELECT state FROM scheduler_slots').get()).toEqual({
        state: 'free',
      });
    } finally {
      inspection.close();
    }
  });

  it('orders cleanup as connections, driver, socket, database, then owner lock', async () => {
    runtime = createTempRuntime();
    const cleanupOrder: string[] = [];
    const clientReference: { current?: RpcClient } = {};
    let acquiredDatabase: ReturnType<typeof acquireRuntimeDatabase> | undefined;
    const driver: ExecutionDriver = {
      start: async () => {
        throw new Error('No work expected');
      },
      shutdown: async () => {
        await clientReference.current?.waitForClose();
        cleanupOrder.push('connections');
        expect(acquiredDatabase?.open).toBe(true);
        cleanupOrder.push('driver');
      },
    };
    server = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: BOOTSTRAP_SECRET,
      executionDriver: driver,
      acquireDatabase: (options) => {
        acquiredDatabase = acquireRuntimeDatabase(options);
        return acquiredDatabase;
      },
      closeDatabase: (database) => {
        expect(cleanupOrder).toEqual(['connections', 'driver']);
        expect(existsSync(runtime?.socketPath ?? '')).toBe(false);
        expect(existsSync(join(runtime?.dataDir ?? '', '.daemon-owner.json'))).toBe(
          true,
        );
        cleanupOrder.push('socket');
        database.close();
        cleanupOrder.push('database');
      },
    });
    await server.start();
    const cleanupClient = await authenticate(runtime);
    clientReference.current = cleanupClient;
    clients.push(cleanupClient);

    await server.stop();
    server = undefined;
    expect(existsSync(join(runtime.dataDir, '.daemon-owner.json'))).toBe(false);
    cleanupOrder.push('lock');
    expect(cleanupOrder).toEqual([
      'connections',
      'driver',
      'socket',
      'database',
      'lock',
    ]);
  });
});
