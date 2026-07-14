import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  EventListAfterResultSchema,
  SessionCreateResultSchema,
  SessionSnapshotSchema,
  WorkspaceRegisterResultSchema,
  type RpcResponse,
} from '../../packages/protocol/src/index.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempRuntime,
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

describe('event.listAfter', () => {
  let runtime: TempRuntime | undefined;
  let client: RpcClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await runtime?.cleanup();
    runtime = undefined;
  });

  const createSessionWithSecondTurn = async (): Promise<{
    readonly sessionId: string;
    readonly turnId: string;
  }> => {
    if (!runtime || !client) {
      throw new Error('test runtime is unavailable');
    }
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const workspaceResponse = await client.sendRequest({
      ...client.createRequest('workspace.register', { path: workspacePath }),
      clientRequestId: 'events-workspace',
    });
    expect(workspaceResponse.ok).toBe(true);
    if (!workspaceResponse.ok) {
      throw new Error('workspace.register failed');
    }
    const workspace = WorkspaceRegisterResultSchema.parse(workspaceResponse.result);
    const createResponse = await client.sendRequest({
      ...client.createRequest('session.create', {
        workspaceId: workspace.workspaceId,
        title: 'Event Session',
        prompt: 'First prompt',
      }),
      clientRequestId: 'events-session',
    });
    expect(createResponse.ok).toBe(true);
    if (!createResponse.ok) {
      throw new Error('session.create failed');
    }
    const created = SessionCreateResultSchema.parse(createResponse.result);
    const enqueueResponse = await client.sendRequest({
      ...client.createRequest('turn.enqueue', {
        sessionId: created.sessionId,
        prompt: 'Second prompt',
      }),
      sessionId: created.sessionId,
      clientRequestId: 'events-enqueue',
    });
    expect(enqueueResponse.ok).toBe(true);
    return created;
  };

  const listAfter = async (
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<{
    readonly request: ReturnType<RpcClient['createRequest']> & {
      readonly sessionId: string;
    };
    readonly response: RpcResponse;
  }> => {
    if (!client) {
      throw new Error('RPC client is unavailable');
    }
    const request = {
      ...client.createRequest('event.listAfter', {
        sessionId,
        afterSeq,
        limit,
      }),
      sessionId,
    };
    return { request, response: await client.sendRequest(request) };
  };

  it('returns exactly min(limit, highWater-afterSeq) consecutive events', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);
    const created = await createSessionWithSecondTurn();

    const firstPage = await listAfter(created.sessionId, 0, 1);
    expect(firstPage.response.ok).toBe(true);
    if (!firstPage.response.ok) {
      throw new Error('event.listAfter failed');
    }
    expect(EventListAfterResultSchema.parse(firstPage.response.result)).toMatchObject({
      highWaterSeq: 3,
      events: [{ seq: 1, type: 'session.created' }],
    });

    const secondPage = await listAfter(created.sessionId, 1, 2);
    expect(secondPage.response.ok).toBe(true);
    if (!secondPage.response.ok) {
      throw new Error('event.listAfter failed');
    }
    const result = EventListAfterResultSchema.parse(secondPage.response.result);
    expect(result.highWaterSeq).toBe(3);
    expect(result.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(result.events.map((event) => event.type)).toEqual([
      'turn.queued',
      'turn.queued',
    ]);

    const oversizedPage = await listAfter(created.sessionId, 2, 100);
    expect(oversizedPage.response.ok).toBe(true);
    if (!oversizedPage.response.ok) {
      throw new Error('event.listAfter failed');
    }
    expect(EventListAfterResultSchema.parse(oversizedPage.response.result).events).toEqual([
      expect.objectContaining({ seq: 3 }),
    ]);
  });

  it('returns an empty page when the cursor equals the captured high-water mark', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);
    const created = await createSessionWithSecondTurn();

    const { response } = await listAfter(created.sessionId, 3, 20);
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error('event.listAfter failed');
    }
    expect(EventListAfterResultSchema.parse(response.result)).toEqual({
      events: [],
      highWaterSeq: 3,
    });
  });

  it('rejects a cursor ahead of high-water with the exact stable error', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);
    const created = await createSessionWithSecondTurn();

    const { request, response } = await listAfter(created.sessionId, 4, 20);
    expect(response).toEqual({
      kind: 'response',
      protocolVersion: 1,
      requestId: request.requestId,
      traceId: request.traceId,
      ok: false,
      error: {
        code: 'EVENT_CURSOR_AHEAD',
        category: 'validation',
        message: 'Event cursor is ahead of the current session history',
        retryable: false,
        userAction: 'Reload the session snapshot',
        detailsRef: null,
        traceId: request.traceId,
      },
    });
  });

  it('rejects an unknown session with the exact stable error', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);

    const { request, response } = await listAfter('missing-session', 0, 20);
    expect(response).toEqual({
      kind: 'response',
      protocolVersion: 1,
      requestId: request.requestId,
      traceId: request.traceId,
      ok: false,
      error: {
        code: 'SESSION_NOT_FOUND',
        category: 'validation',
        message: 'Session was not found',
        retryable: false,
        userAction: 'Refresh and choose an existing session',
        detailsRef: null,
        traceId: request.traceId,
      },
    });
  });

  it('projects model-only events as sequence-preserving redacted envelopes', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);
    const created = await createSessionWithSecondTurn();
    const writer = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    try {
      writer.pragma('foreign_keys = ON');
      const append = writer.transaction(() => {
        writer
          .prepare(
            `INSERT INTO session_events (
              id, session_id, turn_id, tool_run_id, seq, type, actor, audience,
              payload_json, blob_id, created_at
            ) VALUES (?, ?, NULL, NULL, 4, 'model.private', 'model', 'model', ?, ?, ?)`,
          )
          .run(
            '018f0000-0000-7000-8000-000000000004',
            created.sessionId,
            JSON.stringify({ secret: 'must-not-render' }),
            'private-blob',
            new Date().toISOString(),
          );
        writer
          .prepare(
            `UPDATE sessions
             SET next_event_seq = 5, revision = revision + 1
             WHERE id = ?`,
          )
          .run(created.sessionId);
      });
      append.immediate();
    } finally {
      writer.close();
    }

    const { response } = await listAfter(created.sessionId, 3, 10);
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error('event.listAfter failed');
    }
    const page = EventListAfterResultSchema.parse(response.result);
    expect(page).toEqual({
      highWaterSeq: 4,
      events: [
        {
          id: '018f0000-0000-7000-8000-000000000004',
          sessionId: created.sessionId,
          turnId: null,
          toolRunId: null,
          seq: 4,
          type: 'redacted',
          actor: 'model',
          audience: 'model',
          redacted: true,
          payload: null,
          blobId: null,
          createdAt: expect.any(String),
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('must-not-render');
    expect(JSON.stringify(page)).not.toContain('private-blob');

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
    expect(snapshot.highWaterSeq).toBe(4);
    expect(snapshot.events[3]).toEqual(page.events[0]);
  });
});
