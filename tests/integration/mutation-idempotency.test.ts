import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SessionCreateResultSchema,
  SessionListResultSchema,
  SessionSnapshotSchema,
  TurnCancelResultSchema,
  TurnEnqueueResultSchema,
  WorkspaceRegisterResultSchema,
  type RpcRequestEnvelope,
  type RpcResponse,
} from '../../packages/protocol/src/index.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempRuntime,
  type DaemonProcess,
  type SpawnDaemonOptions,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import {
  connectRpcClient,
  type RpcClient,
} from '../../packages/testkit/src/rpc-client.js';

const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');
const crashBeforeCommitEntryPoint = fileURLToPath(
  new URL('../fixtures/crash-before-commit-daemon.ts', import.meta.url),
);

const waitForCondition = async (
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
};

const mutationRequest = (
  client: RpcClient,
  method: 'workspace.register' | 'session.create' | 'turn.enqueue' | 'turn.cancel',
  payload: unknown,
  clientRequestId: string,
  sessionId: string | null = null,
): RpcRequestEnvelope => ({
  ...client.createRequest(method, payload),
  sessionId,
  clientRequestId,
});

const authenticatedClient = async (
  socketPath: string,
  daemon: DaemonProcess,
): Promise<RpcClient> => {
  const client = await connectRpcClient(socketPath);
  await client.waitForChallenge();
  const response = await client.authenticate(daemon.bootstrapSecret);
  expect(response.ok).toBe(true);
  return client;
};

const expectIdempotencyConflict = (
  response: RpcResponse,
  request: RpcRequestEnvelope,
): void => {
  expect(response).toEqual({
    kind: 'response',
    protocolVersion: 1,
    requestId: request.requestId,
    traceId: request.traceId,
    ok: false,
    error: {
      code: 'IDEMPOTENCY_CONFLICT',
      category: 'validation',
      message: 'Client request id was already used with different input',
      retryable: false,
      userAction: 'Retry with a new client request id',
      detailsRef: null,
      traceId: request.traceId,
    },
  });
};

describe('mutation idempotency', () => {
  let runtime: TempRuntime | undefined;
  const clients = new Set<RpcClient>();

  afterEach(async () => {
    await Promise.all([...clients].map(async (client) => await client.close()));
    clients.clear();
    await runtime?.cleanup();
    runtime = undefined;
  });

  const connect = async (daemon: DaemonProcess): Promise<RpcClient> => {
    if (!runtime) {
      throw new Error('runtime is unavailable');
    }
    const client = await authenticatedClient(runtime.socketPath, daemon);
    clients.add(client);
    return client;
  };

  const registerWorkspace = async (
    client: RpcClient,
    workspacePath: string,
    key = 'workspace-key',
  ): Promise<string> => {
    const response = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: workspacePath },
        key,
      ),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error('workspace.register failed');
    }
    return WorkspaceRegisterResultSchema.parse(response.result).workspaceId;
  };

  const createSession = async (
    client: RpcClient,
    workspaceId: string,
    key = 'session-key',
    prompt = 'First prompt',
  ): Promise<{ readonly sessionId: string; readonly turnId: string }> => {
    const response = await client.sendRequest(
      mutationRequest(
        client,
        'session.create',
        { workspaceId, title: 'Session', prompt },
        key,
      ),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error('session.create failed');
    }
    return SessionCreateResultSchema.parse(response.result);
  };

  it('replays workspace.register before revalidating a deleted path and uses retry correlation', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const client = await connect(daemon);

    const firstRequest = mutationRequest(
      client,
      'workspace.register',
      { path: workspacePath },
      'register-replay-key',
    );
    const firstResponse = await client.sendRequest(firstRequest);
    expect(firstResponse.ok).toBe(true);
    if (!firstResponse.ok) {
      throw new Error('workspace.register failed');
    }
    rmSync(workspacePath, { recursive: true });
    const retryRequest = mutationRequest(
      client,
      'workspace.register',
      { path: workspacePath },
      'register-replay-key',
    );
    const retryResponse = await client.sendRequest(retryRequest);

    expect(retryResponse.ok).toBe(true);
    if (!retryResponse.ok) {
      throw new Error('workspace.register replay failed');
    }
    expect(WorkspaceRegisterResultSchema.parse(retryResponse.result)).toEqual(
      WorkspaceRegisterResultSchema.parse(firstResponse.result),
    );
    expect(retryResponse.requestId).toBe(retryRequest.requestId);
    expect(retryResponse.traceId).toBe(retryRequest.traceId);
    expect(retryResponse.requestId).not.toBe(firstResponse.requestId);
    expect(retryResponse.traceId).not.toBe(firstResponse.traceId);

    const database = new Database(join(runtime.dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      const row = database
        .prepare(
          `SELECT result_json FROM rpc_idempotency
           WHERE method = 'workspace.register' AND client_request_id = ?`,
        )
        .get('register-replay-key') as { readonly result_json: string };
      expect(JSON.parse(row.result_json)).toEqual(firstResponse.result);
      expect(row.result_json).not.toMatch(
        /requestId|traceId|protocolVersion|kind|"ok"/,
      );
    } finally {
      database.close();
    }
  });

  it('returns IDEMPOTENCY_CONFLICT when workspace.register reuses a key with different input', async () => {
    runtime = createTempRuntime();
    const firstPath = join(runtime.rootDir, 'workspace-a');
    const secondPath = join(runtime.rootDir, 'workspace-b');
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const client = await connect(daemon);
    await registerWorkspace(client, firstPath, 'workspace-conflict');
    const request = mutationRequest(
      client,
      'workspace.register',
      { path: secondPath },
      'workspace-conflict',
    );
    const response = await client.sendRequest(request);
    expectIdempotencyConflict(response, request);
  });

  it('canonicalizes recursively reordered object keys and replays one session.create fact set', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const client = await connect(daemon);
    const workspaceId = await registerWorkspace(client, workspacePath);
    const firstPayload = {
      workspaceId,
      title: 'Canonical Session',
      prompt: 'Canonical prompt',
    };
    const reorderedPayload = {
      prompt: 'Canonical prompt',
      title: 'Canonical Session',
      workspaceId,
    };
    const firstRequest = mutationRequest(
      client,
      'session.create',
      firstPayload,
      'session-replay',
    );
    const retryRequest = mutationRequest(
      client,
      'session.create',
      reorderedPayload,
      'session-replay',
    );
    const [firstResponse, retryResponse] = [
      await client.sendRequest(firstRequest),
      await client.sendRequest(retryRequest),
    ];
    expect(firstResponse.ok).toBe(true);
    expect(retryResponse.ok).toBe(true);
    if (!firstResponse.ok || !retryResponse.ok) {
      throw new Error('session.create replay failed');
    }
    expect(retryResponse.result).toEqual(firstResponse.result);

    const database = new Database(join(runtime.dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({
        count: 1,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({
        count: 1,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM turns').get()).toEqual({
        count: 1,
      });
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM session_events').get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it('returns IDEMPOTENCY_CONFLICT when session.create reuses a key with a different prompt', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const client = await connect(daemon);
    const workspaceId = await registerWorkspace(client, workspacePath);
    await createSession(client, workspaceId, 'session-conflict', 'winner');
    const request = mutationRequest(
      client,
      'session.create',
      { workspaceId, title: 'Session', prompt: 'different' },
      'session-conflict',
    );
    expectIdempotencyConflict(await client.sendRequest(request), request);
  });

  it('replays one turn.enqueue and conflicts on different input without changing counters', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const client = await connect(daemon);
    const workspaceId = await registerWorkspace(client, workspacePath);
    const created = await createSession(client, workspaceId);
    const firstRequest = mutationRequest(
      client,
      'turn.enqueue',
      { sessionId: created.sessionId, prompt: 'Second prompt' },
      'enqueue-replay',
      created.sessionId,
    );
    const retryRequest = mutationRequest(
      client,
      'turn.enqueue',
      { prompt: 'Second prompt', sessionId: created.sessionId },
      'enqueue-replay',
      created.sessionId,
    );
    const firstResponse = await client.sendRequest(firstRequest);
    const retryResponse = await client.sendRequest(retryRequest);
    expect(firstResponse.ok).toBe(true);
    expect(retryResponse.ok).toBe(true);
    if (!firstResponse.ok || !retryResponse.ok) {
      throw new Error('turn.enqueue replay failed');
    }
    expect(TurnEnqueueResultSchema.parse(retryResponse.result)).toEqual(
      TurnEnqueueResultSchema.parse(firstResponse.result),
    );

    const conflictRequest = mutationRequest(
      client,
      'turn.enqueue',
      { sessionId: created.sessionId, prompt: 'Different prompt' },
      'enqueue-replay',
      created.sessionId,
    );
    expectIdempotencyConflict(
      await client.sendRequest(conflictRequest),
      conflictRequest,
    );

    const snapshotRequest = {
      ...client.createRequest('session.getSnapshot', {
        sessionId: created.sessionId,
      }),
      sessionId: created.sessionId,
    };
    const snapshotResponse = await client.sendRequest(snapshotRequest);
    if (!snapshotResponse.ok) {
      throw new Error('session.getSnapshot failed');
    }
    const snapshot = SessionSnapshotSchema.parse(snapshotResponse.result);
    expect(snapshot.turns.map((turn) => turn.ordinal)).toEqual([1, 2]);
    expect(snapshot.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(snapshot.session).toMatchObject({
      nextTurnOrdinal: 3,
      nextEventSeq: 4,
      revision: 2,
    });
  });

  it('scopes the same client key independently across session.create and turn.enqueue', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const client = await connect(daemon);
    const workspaceId = await registerWorkspace(client, workspacePath);
    const created = await createSession(client, workspaceId, 'shared-method-key');
    const enqueueResponse = await client.sendRequest(
      mutationRequest(
        client,
        'turn.enqueue',
        { sessionId: created.sessionId, prompt: 'Method scoped' },
        'shared-method-key',
        created.sessionId,
      ),
    );
    expect(enqueueResponse.ok).toBe(true);
    if (!enqueueResponse.ok) {
      throw new Error('turn.enqueue failed');
    }
    expect(TurnEnqueueResultSchema.parse(enqueueResponse.result).turnId).not.toBe(
      created.turnId,
    );

    const database = new Database(join(runtime.dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(
        database
          .prepare(
            `SELECT method FROM rpc_idempotency
             WHERE client_request_id = 'shared-method-key' ORDER BY method`,
          )
          .all(),
      ).toEqual([{ method: 'session.create' }, { method: 'turn.enqueue' }]);
    } finally {
      database.close();
    }
  });

  it('serializes identical concurrent session.create requests from two sockets into one result', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const firstClient = await connect(daemon);
    const secondClient = await connect(daemon);
    const workspaceId = await registerWorkspace(firstClient, workspacePath);
    const payload = { workspaceId, title: 'Concurrent', prompt: 'Same' };
    const [firstResponse, secondResponse] = await Promise.all([
      firstClient.sendRequest(
        mutationRequest(
          firstClient,
          'session.create',
          payload,
          'concurrent-same',
        ),
      ),
      secondClient.sendRequest(
        mutationRequest(
          secondClient,
          'session.create',
          payload,
          'concurrent-same',
        ),
      ),
    ]);
    expect(firstResponse.ok).toBe(true);
    expect(secondResponse.ok).toBe(true);
    if (!firstResponse.ok || !secondResponse.ok) {
      throw new Error('concurrent session.create failed');
    }
    expect(secondResponse.result).toEqual(firstResponse.result);

    const database = new Database(join(runtime.dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({
        count: 1,
      });
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM session_events').get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it('chooses one concurrent payload winner and returns one conflict from two sockets', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const firstClient = await connect(daemon);
    const secondClient = await connect(daemon);
    const workspaceId = await registerWorkspace(firstClient, workspacePath);
    const firstRequest = mutationRequest(
      firstClient,
      'session.create',
      { workspaceId, title: 'Winner A', prompt: 'A' },
      'concurrent-conflict',
    );
    const secondRequest = mutationRequest(
      secondClient,
      'session.create',
      { workspaceId, title: 'Winner B', prompt: 'B' },
      'concurrent-conflict',
    );
    const responses = await Promise.all([
      firstClient.sendRequest(firstRequest),
      secondClient.sendRequest(secondRequest),
    ]);
    expect(responses.filter((response) => response.ok)).toHaveLength(1);
    expect(responses.filter((response) => !response.ok)).toHaveLength(1);
    const failedIndex = responses.findIndex((response) => !response.ok);
    expectIdempotencyConflict(
      responses[failedIndex] as RpcResponse,
      failedIndex === 0 ? firstRequest : secondRequest,
    );
    const winner = responses.find((response) => response.ok);
    if (!winner?.ok) {
      throw new Error('concurrent winner missing');
    }
    const created = SessionCreateResultSchema.parse(winner.result);
    const snapshotRequest = {
      ...firstClient.createRequest('session.getSnapshot', {
        sessionId: created.sessionId,
      }),
      sessionId: created.sessionId,
    };
    const snapshotResponse = await firstClient.sendRequest(snapshotRequest);
    if (!snapshotResponse.ok) {
      throw new Error('session.getSnapshot failed');
    }
    const snapshot = SessionSnapshotSchema.parse(snapshotResponse.result);
    expect(['A', 'B']).toContain(snapshot.messages[0]?.content);
    expect(snapshot.session.title).toBe(
      snapshot.messages[0]?.content === 'A' ? 'Winner A' : 'Winner B',
    );
  });

  it('allocates consecutive ordinals and event sequences for two concurrent enqueue keys', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const firstClient = await connect(daemon);
    const secondClient = await connect(daemon);
    const workspaceId = await registerWorkspace(firstClient, workspacePath);
    const created = await createSession(firstClient, workspaceId);
    const [firstResponse, secondResponse] = await Promise.all([
      firstClient.sendRequest(
        mutationRequest(
          firstClient,
          'turn.enqueue',
          { sessionId: created.sessionId, prompt: 'Concurrent A' },
          'enqueue-a',
          created.sessionId,
        ),
      ),
      secondClient.sendRequest(
        mutationRequest(
          secondClient,
          'turn.enqueue',
          { sessionId: created.sessionId, prompt: 'Concurrent B' },
          'enqueue-b',
          created.sessionId,
        ),
      ),
    ]);
    expect(firstResponse.ok).toBe(true);
    expect(secondResponse.ok).toBe(true);

    const snapshotRequest = {
      ...firstClient.createRequest('session.getSnapshot', {
        sessionId: created.sessionId,
      }),
      sessionId: created.sessionId,
    };
    const snapshotResponse = await firstClient.sendRequest(snapshotRequest);
    if (!snapshotResponse.ok) {
      throw new Error('session.getSnapshot failed');
    }
    const snapshot = SessionSnapshotSchema.parse(snapshotResponse.result);
    expect(snapshot.turns.map((turn) => turn.ordinal)).toEqual([1, 2, 3]);
    expect(snapshot.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(snapshot.session).toMatchObject({
      nextTurnOrdinal: 4,
      nextEventSeq: 5,
      revision: 3,
    });
  });

  it('returns a redacted internal error when a stored method result is corrupted', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const client = await connect(daemon);
    await registerWorkspace(client, workspacePath, 'corrupt-result');
    const writer = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    try {
      writer
        .prepare(
          `UPDATE rpc_idempotency SET result_json = ?
           WHERE method = 'workspace.register' AND client_request_id = ?`,
        )
        .run('{"workspaceId":42}', 'corrupt-result');
    } finally {
      writer.close();
    }
    const request = mutationRequest(
      client,
      'workspace.register',
      { path: workspacePath },
      'corrupt-result',
    );
    const response = await client.sendRequest(request);
    expect(response).toEqual({
      kind: 'response',
      protocolVersion: 1,
      requestId: request.requestId,
      traceId: request.traceId,
      ok: false,
      error: {
        code: 'RPC_INTERNAL_ERROR',
        category: 'internal',
        message: 'RPC request failed internally',
        retryable: false,
        userAction: null,
        detailsRef: null,
        traceId: request.traceId,
      },
    });
  });

  it('rolls back partial facts and redacts an unexpected SQLite constraint message', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const client = await connect(daemon);
    const workspaceId = await registerWorkspace(client, workspacePath);
    const sentinel = `SECRET_SQL_${Date.now()}_${runtime.dataDir}`;
    const writer = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    try {
      writer.exec(`
        CREATE TRIGGER reject_session_idempotency
        BEFORE INSERT ON rpc_idempotency
        WHEN NEW.method = 'session.create'
        BEGIN
          SELECT RAISE(ABORT, '${sentinel.replaceAll("'", "''")}');
        END;
      `);
    } finally {
      writer.close();
    }
    const request = mutationRequest(
      client,
      'session.create',
      { workspaceId, title: 'Rejected', prompt: 'Must roll back' },
      'trigger-rollback',
    );
    const response = await client.sendRequest(request);

    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).not.toContain(sentinel);
    expect(response).toMatchObject({
      requestId: request.requestId,
      traceId: request.traceId,
      error: {
        code: 'RPC_INTERNAL_ERROR',
        category: 'internal',
        message: 'RPC request failed internally',
        retryable: false,
        userAction: null,
        detailsRef: null,
        traceId: request.traceId,
      },
    });
    expect(daemon.stdout).not.toContain(sentinel);
    expect(daemon.stderr).not.toContain(sentinel);

    const reader = new Database(join(runtime.dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(reader.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({
        count: 0,
      });
      expect(reader.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({
        count: 0,
      });
      expect(reader.prepare('SELECT COUNT(*) AS count FROM turns').get()).toEqual({
        count: 0,
      });
      expect(
        reader.prepare('SELECT COUNT(*) AS count FROM session_events').get(),
      ).toEqual({ count: 0 });
      expect(
        reader
          .prepare(
            `SELECT COUNT(*) AS count FROM rpc_idempotency
             WHERE method = 'session.create' AND client_request_id = 'trigger-rollback'`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      reader.close();
    }
  });

  it('rolls back staged facts and idempotency when SIGKILL lands before transaction commit', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const crashDaemon = runtime.spawnDaemon({
      entryPoint: crashBeforeCommitEntryPoint,
    } as SpawnDaemonOptions & { readonly entryPoint: string });
    await crashDaemon.waitForReady();
    const crashClient = await connect(crashDaemon);
    const workspaceId = await registerWorkspace(
      crashClient,
      workspacePath,
      'crash-workspace',
    );
    const payload = {
      workspaceId,
      title: 'Crash Atomicity',
      prompt: 'Must be all-or-nothing',
    };
    const crashRequest = mutationRequest(
      crashClient,
      'session.create',
      payload,
      'crash-session-key',
    );
    const responseOutcome = crashClient.sendRequest(crashRequest).then(
      () => 'response' as const,
      () => 'closed' as const,
    );
    await waitForCondition(
      () => crashDaemon.stdout.includes('"event":"before_commit"'),
      'the before-commit crash marker',
    );
    const crashExit = await crashDaemon.waitForExit();

    expect(crashExit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await responseOutcome).toBe('closed');
    const beforeRetry = new Database(join(runtime.dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(beforeRetry.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({
        count: 0,
      });
      expect(beforeRetry.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({
        count: 0,
      });
      expect(beforeRetry.prepare('SELECT COUNT(*) AS count FROM turns').get()).toEqual({
        count: 0,
      });
      expect(
        beforeRetry.prepare('SELECT COUNT(*) AS count FROM session_events').get(),
      ).toEqual({ count: 0 });
      expect(
        beforeRetry
          .prepare(
            `SELECT COUNT(*) AS count FROM rpc_idempotency
             WHERE method = 'session.create' AND client_request_id = 'crash-session-key'`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      beforeRetry.close();
    }

    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();
    const replacementClient = await connect(replacement);
    const retryRequest = mutationRequest(
      replacementClient,
      'session.create',
      payload,
      'crash-session-key',
    );
    const retryResponse = await replacementClient.sendRequest(retryRequest);
    expect(retryResponse.ok).toBe(true);
    if (!retryResponse.ok) {
      throw new Error('session.create retry failed');
    }
    const created = SessionCreateResultSchema.parse(retryResponse.result);
    const afterRetry = new Database(join(runtime.dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(afterRetry.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({
        count: 1,
      });
      expect(afterRetry.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({
        count: 1,
      });
      expect(afterRetry.prepare('SELECT COUNT(*) AS count FROM turns').get()).toEqual({
        count: 1,
      });
      expect(
        afterRetry.prepare('SELECT COUNT(*) AS count FROM session_events').get(),
      ).toEqual({ count: 2 });
      expect(
        afterRetry
          .prepare(
            `SELECT COUNT(*) AS count FROM rpc_idempotency
             WHERE method = 'session.create' AND client_request_id = 'crash-session-key'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        afterRetry
          .prepare('SELECT id FROM sessions')
          .get(),
      ).toEqual({ id: created.sessionId });
      expect(afterRetry.pragma('foreign_key_check')).toEqual([]);
    } finally {
      afterRetry.close();
    }
  }, 15_000);

  it('lists active Sessions and cancels queued Turns idempotently over authenticated RPC', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const client = await connect(daemon);
    const workspaceId = await registerWorkspace(client, workspacePath, 'list-cancel-workspace');
    const created = await createSession(client, workspaceId, 'list-cancel-session');
    const queued = await client.sendRequest(
      mutationRequest(
        client,
        'turn.enqueue',
        { sessionId: created.sessionId, prompt: 'Cancel this queued Turn' },
        'list-cancel-enqueue',
        created.sessionId,
      ),
    );
    expect(queued.ok).toBe(true);
    if (!queued.ok) {
      throw new Error('turn.enqueue failed');
    }
    const queuedTurn = TurnEnqueueResultSchema.parse(queued.result);

    const listedRequest = client.createRequest('session.list', {});
    const listed = await client.sendRequest(listedRequest);
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error('session.list failed');
    }
    expect(SessionListResultSchema.parse(listed.result)).toEqual({
      sessions: [
        expect.objectContaining({
          id: created.sessionId,
          queuedTurnCount: 2,
          currentTurnId: null,
          runtimeStatus: 'queued',
        }),
      ],
    });

    const firstRequest = mutationRequest(
      client,
      'turn.cancel',
      { sessionId: created.sessionId, turnId: queuedTurn.turnId },
      'list-cancel-key',
      created.sessionId,
    );
    const first = await client.sendRequest(firstRequest);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error('turn.cancel failed');
    }
    const expected = TurnCancelResultSchema.parse(first.result);
    const replay = await client.sendRequest({
      ...mutationRequest(
        client,
        'turn.cancel',
        { sessionId: created.sessionId, turnId: queuedTurn.turnId },
        'list-cancel-key',
        created.sessionId,
      ),
    });
    expect(replay).toMatchObject({ ok: true, result: expected });
    const retry = await client.sendRequest(
      mutationRequest(
        client,
        'turn.cancel',
        { sessionId: created.sessionId, turnId: queuedTurn.turnId },
        'list-cancel-retry-key',
        created.sessionId,
      ),
    );
    expect(retry).toMatchObject({ ok: true, result: expected });

    const conflict = await client.sendRequest(
      mutationRequest(
        client,
        'turn.cancel',
        { sessionId: created.sessionId, turnId: created.turnId },
        'list-cancel-key',
        created.sessionId,
      ),
    );
    expectIdempotencyConflict(conflict, {
      ...firstRequest,
      requestId: conflict.requestId,
      traceId: conflict.traceId,
    });

    const snapshotResponse = await client.sendRequest({
      ...client.createRequest('session.getSnapshot', { sessionId: created.sessionId }),
      sessionId: created.sessionId,
    });
    expect(snapshotResponse.ok).toBe(true);
    if (!snapshotResponse.ok) {
      throw new Error('session.getSnapshot failed');
    }
    const snapshot = SessionSnapshotSchema.parse(snapshotResponse.result);
    expect(snapshot.turns.map((turn) => [turn.id, turn.ordinal, turn.status])).toEqual([
      [created.turnId, 1, 'queued'],
      [queuedTurn.turnId, 2, 'canceled'],
    ]);
    expect(snapshot.events.filter((event) => event.type === 'turn.canceled')).toEqual([
      expect.objectContaining({
        turnId: queuedTurn.turnId,
        payload: { ordinal: 2, queueKind: 'normal' },
      }),
    ]);
  });
});
