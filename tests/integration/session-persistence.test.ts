import {
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import {
  SessionCreateResultSchema,
  SessionSnapshotSchema,
  WorkspaceRegisterResultSchema,
  type RpcRequestEnvelope,
  type RpcResponse,
} from '../../packages/protocol/src/index.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempRuntime,
  type DaemonProcess,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import {
  connectRpcClient,
  type RpcClient,
} from '../../packages/testkit/src/rpc-client.js';
import { DaemonServer } from '../../services/daemon/src/server.js';

const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

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
  method: 'workspace.register' | 'session.create' | 'turn.enqueue',
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

const expectError = (
  response: RpcResponse,
  traceId: string,
  expected: {
    readonly code: string;
    readonly message: string;
    readonly userAction: string;
  },
): void => {
  expect(response).toEqual({
    kind: 'response',
    protocolVersion: 1,
    requestId: response.requestId,
    traceId,
    ok: false,
    error: {
      code: expected.code,
      category: 'validation',
      message: expected.message,
      retryable: false,
      userAction: expected.userAction,
      detailsRef: null,
      traceId,
    },
  });
};

describe('craft session persistence', () => {
  let runtime: TempRuntime | undefined;
  let client: RpcClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('restores the exact initial Session facts after a graceful restart', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);

    const firstDaemon = runtime.spawnDaemon();
    await firstDaemon.waitForReady();
    client = await authenticatedClient(runtime.socketPath, firstDaemon);

    const workspaceResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: workspacePath },
        'workspace-register-1',
      ),
    );
    expect(workspaceResponse.ok).toBe(true);
    if (!workspaceResponse.ok) {
      throw new Error('workspace.register failed');
    }
    const workspace = WorkspaceRegisterResultSchema.parse(workspaceResponse.result);

    const createResponse = await client.sendRequest(
      mutationRequest(
        client,
        'session.create',
        {
          workspaceId: workspace.workspaceId,
          title: 'Persistent Session',
          prompt: 'Persist this prompt',
        },
        'session-create-1',
      ),
    );
    expect(createResponse.ok).toBe(true);
    if (!createResponse.ok) {
      throw new Error('session.create failed');
    }
    const created = SessionCreateResultSchema.parse(createResponse.result);

    await client.close();
    client = undefined;
    await firstDaemon.stop();

    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();
    client = await authenticatedClient(runtime.socketPath, replacement);
    const snapshotRequest = {
      ...client.createRequest('session.getSnapshot', {
        sessionId: created.sessionId,
      }),
      sessionId: created.sessionId,
    };
    const snapshotResponse = await client.sendRequest(snapshotRequest);

    expect(snapshotResponse.ok).toBe(true);
    if (!snapshotResponse.ok) {
      throw new Error('session.getSnapshot failed');
    }
    const snapshot = SessionSnapshotSchema.parse(snapshotResponse.result);
    expect(snapshot.session).toMatchObject({
      id: created.sessionId,
      title: 'Persistent Session',
      workspaceId: workspace.workspaceId,
      lifecycleStatus: 'active',
      runtimeStatus: 'queued',
      queueBlockReason: null,
      recoveryEpisode: 0,
      recoverySourceTurnId: null,
      currentTurnId: null,
      mode: 'craft',
      accessMode: 'full_access',
      nextTurnOrdinal: 2,
      nextEventSeq: 3,
      revision: 1,
    });
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        sessionId: created.sessionId,
        turnId: created.turnId,
        role: 'user',
        status: 'completed',
        content: 'Persist this prompt',
      }),
    ]);
    expect(snapshot.turns).toEqual([
      expect.objectContaining({
        id: created.turnId,
        sessionId: created.sessionId,
        ordinal: 1,
        clientRequestId: 'session-create-1',
        queueKind: 'normal',
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
        resultMessageId: null,
        modeSnapshot: 'craft',
        accessModeSnapshot: 'full_access',
      }),
    ]);
    expect(snapshot.highWaterSeq).toBe(2);
    expect(snapshot.events.map(({ seq, type, turnId, actor, audience, payload }) => ({
      seq,
      type,
      turnId,
      actor,
      audience,
      payload,
    }))).toEqual([
      {
        seq: 1,
        type: 'session.created',
        turnId: null,
        actor: 'daemon',
        audience: 'both',
        payload: {
          workspaceId: workspace.workspaceId,
          title: 'Persistent Session',
          mode: 'craft',
          accessMode: 'full_access',
        },
      },
      {
        seq: 2,
        type: 'turn.queued',
        turnId: created.turnId,
        actor: 'daemon',
        audience: 'both',
        payload: { ordinal: 1, queueKind: 'normal' },
      },
    ]);
    const sharedTimestamps = new Set([
      snapshot.session.createdAt,
      snapshot.session.updatedAt,
      snapshot.messages[0]?.createdAt,
      snapshot.messages[0]?.completedAt,
      snapshot.turns[0]?.queuedAt,
      ...snapshot.events.map((event) => event.createdAt),
    ]);
    expect(sharedTimestamps).toEqual(new Set([snapshot.session.createdAt]));
  });

  it('restores committed WAL facts after an unclean SIGKILL restart', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const firstDaemon = runtime.spawnDaemon();
    await firstDaemon.waitForReady();
    client = await authenticatedClient(runtime.socketPath, firstDaemon);
    const workspaceResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: workspacePath },
        'wal-workspace',
      ),
    );
    if (!workspaceResponse.ok) {
      throw new Error('workspace.register failed');
    }
    const workspace = WorkspaceRegisterResultSchema.parse(workspaceResponse.result);
    const createResponse = await client.sendRequest(
      mutationRequest(
        client,
        'session.create',
        {
          workspaceId: workspace.workspaceId,
          title: 'WAL Session',
          prompt: 'Committed before SIGKILL',
        },
        'wal-session',
      ),
    );
    if (!createResponse.ok) {
      throw new Error('session.create failed');
    }
    const created = SessionCreateResultSchema.parse(createResponse.result);

    await client.close();
    client = undefined;
    const killed = await firstDaemon.stop('SIGKILL');
    expect(killed.signal).toBe('SIGKILL');

    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();
    client = await authenticatedClient(runtime.socketPath, replacement);
    const request = {
      ...client.createRequest('session.getSnapshot', {
        sessionId: created.sessionId,
      }),
      sessionId: created.sessionId,
    };
    const response = await client.sendRequest(request);
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error('session.getSnapshot failed');
    }
    const snapshot = SessionSnapshotSchema.parse(response.result);
    expect(snapshot.session.id).toBe(created.sessionId);
    expect(snapshot.messages.map((message) => message.content)).toEqual([
      'Committed before SIGKILL',
    ]);
    expect(snapshot.turns.map((turn) => turn.id)).toEqual([created.turnId]);
    expect(snapshot.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it('reuses one canonical workspace for fresh keys without creating Session Events', async () => {
    runtime = createTempRuntime();
    const realWorkspace = join(runtime.rootDir, 'real-workspace');
    const aliasWorkspace = join(runtime.rootDir, 'workspace-alias');
    mkdirSync(realWorkspace);
    symlinkSync(realWorkspace, aliasWorkspace);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await authenticatedClient(runtime.socketPath, daemon);

    const firstResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: aliasWorkspace },
        'canonical-alias-key',
      ),
    );
    const secondResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: realWorkspace },
        'canonical-real-key',
      ),
    );
    expect(firstResponse.ok).toBe(true);
    expect(secondResponse.ok).toBe(true);
    if (!firstResponse.ok || !secondResponse.ok) {
      throw new Error('workspace.register failed');
    }
    const first = WorkspaceRegisterResultSchema.parse(firstResponse.result);
    const second = WorkspaceRegisterResultSchema.parse(secondResponse.result);
    expect(second.workspaceId).toBe(first.workspaceId);

    await client.close();
    client = undefined;
    await daemon.stop();
    const database = new Database(join(runtime.dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(database.prepare('SELECT * FROM workspaces').all()).toEqual([
        {
          id: first.workspaceId,
          path: resolve(aliasWorkspace),
          canonical_path: realpathSync.native(aliasWorkspace),
          created_at: expect.any(String),
        },
      ]);
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM session_events').get(),
      ).toEqual({ count: 0 });
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM rpc_idempotency').get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it.each(['missing', 'file'] as const)(
    'rejects a %s workspace path with the stable validation error',
    async (kind) => {
      runtime = createTempRuntime();
      const path = join(runtime.rootDir, `invalid-${kind}`);
      if (kind === 'file') {
        writeFileSync(path, 'not a directory', { mode: 0o600 });
      }
      const daemon = runtime.spawnDaemon();
      await daemon.waitForReady();
      client = await authenticatedClient(runtime.socketPath, daemon);
      const request = mutationRequest(
        client,
        'workspace.register',
        { path },
        `invalid-workspace-${kind}`,
      );
      const response = await client.sendRequest(request);

      expectError(response, request.traceId, {
        code: 'WORKSPACE_PATH_INVALID',
        message: 'Workspace path must reference an existing directory',
        userAction: 'Choose an existing workspace directory',
      });
    },
  );

  it('rejects session.create for an unknown workspace with the stable validation error', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await authenticatedClient(runtime.socketPath, daemon);
    const request = mutationRequest(
      client,
      'session.create',
      {
        workspaceId: 'missing-workspace',
        title: 'Missing',
        prompt: 'Must not persist',
      },
      'missing-workspace-key',
    );
    const response = await client.sendRequest(request);

    expectError(response, request.traceId, {
      code: 'WORKSPACE_NOT_FOUND',
      message: 'Workspace was not found',
      userAction: 'Register or choose an existing workspace',
    });
  });

  it.each([
    'running',
    'waiting_for_user',
    'canceling',
    'recovering',
    'error',
  ] as const)(
    'turn.enqueue preserves %s runtime and all recovery/current fields',
    async (runtimeStatus) => {
      runtime = createTempRuntime();
      const workspacePath = join(runtime.rootDir, 'workspace');
      mkdirSync(workspacePath);
      const daemon = runtime.spawnDaemon();
      await daemon.waitForReady();
      client = await authenticatedClient(runtime.socketPath, daemon);
      const workspaceResponse = await client.sendRequest(
        mutationRequest(
          client,
          'workspace.register',
          { path: workspacePath },
          `preserve-workspace-${runtimeStatus}`,
        ),
      );
      if (!workspaceResponse.ok) {
        throw new Error('workspace.register failed');
      }
      const workspace = WorkspaceRegisterResultSchema.parse(workspaceResponse.result);
      const createResponse = await client.sendRequest(
        mutationRequest(
          client,
          'session.create',
          {
            workspaceId: workspace.workspaceId,
            title: 'Preserve state',
            prompt: 'Initial',
          },
          `preserve-session-${runtimeStatus}`,
        ),
      );
      if (!createResponse.ok) {
        throw new Error('session.create failed');
      }
      const created = SessionCreateResultSchema.parse(createResponse.result);
      const writer = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
      try {
        writer.pragma('foreign_keys = ON');
        writer
          .prepare(
            `UPDATE sessions
             SET runtime_status = ?,
                 queue_block_reason = 'recovery_review',
                 recovery_episode = 7,
                 recovery_source_turn_id = ?,
                 current_turn_id = ?
             WHERE id = ?`,
          )
          .run(
            runtimeStatus,
            created.turnId,
            created.turnId,
            created.sessionId,
          );
      } finally {
        writer.close();
      }

      const enqueueResponse = await client.sendRequest(
        mutationRequest(
          client,
          'turn.enqueue',
          { sessionId: created.sessionId, prompt: 'Queued behind current state' },
          `preserve-enqueue-${runtimeStatus}`,
          created.sessionId,
        ),
      );
      expect(enqueueResponse.ok).toBe(true);
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
      expect(snapshot.session).toMatchObject({
        runtimeStatus,
        queueBlockReason: 'recovery_review',
        recoveryEpisode: 7,
        recoverySourceTurnId: created.turnId,
        currentTurnId: created.turnId,
        nextTurnOrdinal: 3,
        nextEventSeq: 4,
        revision: 2,
      });
    },
  );

  it('turn.enqueue transitions only idle runtime status to queued', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await authenticatedClient(runtime.socketPath, daemon);
    const workspaceResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: workspacePath },
        'idle-workspace',
      ),
    );
    if (!workspaceResponse.ok) {
      throw new Error('workspace.register failed');
    }
    const workspace = WorkspaceRegisterResultSchema.parse(workspaceResponse.result);
    const createResponse = await client.sendRequest(
      mutationRequest(
        client,
        'session.create',
        {
          workspaceId: workspace.workspaceId,
          title: 'Idle transition',
          prompt: 'Initial',
        },
        'idle-session',
      ),
    );
    if (!createResponse.ok) {
      throw new Error('session.create failed');
    }
    const created = SessionCreateResultSchema.parse(createResponse.result);
    const writer = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    try {
      writer
        .prepare("UPDATE sessions SET runtime_status = 'idle' WHERE id = ?")
        .run(created.sessionId);
    } finally {
      writer.close();
    }
    const enqueueResponse = await client.sendRequest(
      mutationRequest(
        client,
        'turn.enqueue',
        { sessionId: created.sessionId, prompt: 'Wake the queue' },
        'idle-enqueue',
        created.sessionId,
      ),
    );
    expect(enqueueResponse.ok).toBe(true);
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
    expect(SessionSnapshotSchema.parse(snapshotResponse.result).session.runtimeStatus).toBe(
      'queued',
    );
  });

  it.each(['session.getSnapshot', 'turn.enqueue'] as const)(
    'returns SESSION_NOT_FOUND for %s against an unknown session',
    async (method) => {
      runtime = createTempRuntime();
      const daemon = runtime.spawnDaemon();
      await daemon.waitForReady();
      client = await authenticatedClient(runtime.socketPath, daemon);
      const request =
        method === 'session.getSnapshot'
          ? {
              ...client.createRequest(method, { sessionId: 'missing-session' }),
              sessionId: 'missing-session',
            }
          : mutationRequest(
              client,
              method,
              { sessionId: 'missing-session', prompt: 'Never queued' },
              'missing-session-enqueue',
              'missing-session',
            );
      const response = await client.sendRequest(request);
      expectError(response, request.traceId, {
        code: 'SESSION_NOT_FOUND',
        message: 'Session was not found',
        userAction: 'Refresh and choose an existing session',
      });
    },
  );

  it('keeps the runtime lock while database close is blocked', async () => {
    runtime = createTempRuntime();
    let closeEntered = false;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolvePromise) => {
      releaseClose = resolvePromise;
    });
    const server = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: Buffer.alloc(32, 0x62),
      closeDatabase: async (database: { close(): void }) => {
        closeEntered = true;
        await closeGate;
        database.close();
      },
    } as never);
    await server.start();
    const stopping = server.stop();
    await waitForCondition(
      () => closeEntered,
      'the injected database close gate',
    );

    const contender = runtime.spawnDaemon({
      socketPath: runtime.alternateSocketPath,
    });
    const contenderExit = await contender.waitForExit(2_000);
    expect(contenderExit.code).not.toBe(0);
    expect(existsSync(runtime.alternateSocketPath)).toBe(false);

    releaseClose();
    await stopping;
    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();
  }, 12_000);

  it('fails closed without releasing ownership when database close reports failure', async () => {
    runtime = createTempRuntime();
    const ownerPath = join(runtime.dataDir, '.daemon-owner.json');
    const server = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: Buffer.alloc(32, 0x63),
      closeDatabase: (database: { close(): void }) => {
        database.close();
        throw new Error('injected close failure');
      },
    } as never);
    await server.start();

    await expect(server.stop()).rejects.toThrow('injected close failure');
    expect(existsSync(ownerPath)).toBe(true);
    const contender = runtime.spawnDaemon({
      socketPath: runtime.alternateSocketPath,
    });
    const contenderExit = await contender.waitForExit(2_000);
    expect(contenderExit.code).not.toBe(0);
    expect(existsSync(runtime.alternateSocketPath)).toBe(false);

    const runtimeLock = (
      server as unknown as {
        readonly runtimeLock?: { release(): Promise<void> };
      }
    ).runtimeLock;
    await runtimeLock?.release();
    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();
  }, 12_000);
});
