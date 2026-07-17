import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeSecurity } from './http-security.js';

type RpcCall = {
  readonly method: string;
  readonly payload: unknown;
  readonly sessionId?: string;
  readonly clientRequestId?: string;
};

type RpcReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: unknown };

type HttpApiModule = {
  createHttpApiHandler(options: {
    readonly rpc: {
      call(input: RpcCall): Promise<RpcReply>;
      reconnect?(): Promise<void>;
    };
    readonly runtimeSecurity: ReturnType<typeof createRuntimeSecurity>;
    readonly provider: {
      readonly baseHost: string;
      readonly modelId: string;
    };
    readonly workspace: {
      readonly name: string;
      readonly path: string;
    };
  }): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
};

const servers = new Set<Server>();

const emptySnapshot = {
  session: {
    id: 'session-1',
    title: 'Inspect repository',
    workspaceId: 'workspace-1',
    lifecycleStatus: 'active',
    runtimeStatus: 'idle',
    queueBlockReason: null,
    recoveryEpisode: 0,
    recoverySourceTurnId: null,
    currentTurnId: null,
    mode: 'craft',
    accessMode: 'full_access',
    nextTurnOrdinal: 1,
    nextEventSeq: 1,
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  },
  messages: [],
  turns: [],
  highWaterSeq: 0,
  events: [],
};

const event = (seq: number) => ({
  id: `event-${seq}`,
  sessionId: 'session-1',
  turnId: null,
  toolRunId: null,
  seq,
  actor: 'daemon',
  audience: 'ui',
  createdAt: '2026-07-16T00:00:00.000Z',
  type: 'turn.queued',
  redacted: false,
  payload: {},
  blobId: null,
});

const sessionList = {
  sessions: [
    {
      id: 'session/1',
      title: 'Inspect repository',
      runtimeStatus: 'queued',
      currentTurnId: null,
      queuedTurnCount: 1,
      updatedAt: '2026-07-16T00:00:00.000Z',
    },
  ],
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        }),
    ),
  );
  servers.clear();
});

const startApi = async (rpc: {
  call(input: RpcCall): Promise<RpcReply>;
  reconnect?(): Promise<void>;
}) => {
  const { createHttpApiHandler } = (await import(
    './http-api.js'
  )) as unknown as HttpApiModule;
  const server = createServer();
  servers.add(server);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('HTTP API did not bind a TCP port');
  }
  const handler = createHttpApiHandler({
    rpc,
    runtimeSecurity: createRuntimeSecurity(address.port, 'csrf-token'),
    provider: { baseHost: 'api.example.test', modelId: 'chat-model' },
    workspace: { name: 'agent-workbench', path: '/private/workspace' },
  });
  server.on('request', (request, response) => {
    void handler(request, response);
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
  };
};

const success = (result: unknown): RpcReply => ({ ok: true, result });

const postChunkedJson = async (
  origin: string,
  pathname: string,
  body: string,
): Promise<{ readonly body: string; readonly status: number }> =>
  await new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(pathname, origin);
    const request = httpRequest(
      {
        hostname: target.hostname,
        method: 'POST',
        path: target.pathname,
        port: target.port,
        headers: {
          'content-type': 'application/json',
          origin,
          'x-agent-workbench-csrf': 'csrf-token',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          resolvePromise({
            body: Buffer.concat(chunks).toString('utf8'),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.once('error', rejectPromise);
    const midpoint = Math.floor(body.length / 2);
    request.write(body.slice(0, midpoint));
    request.end(body.slice(midpoint));
  });

describe('web console HTTP API', () => {
  it('returns sanitized runtime information from a validated health result', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        return success({ status: 'ready', protocolVersion: 1, pid: 4321 });
      },
    });

    const response = await fetch(`${api.origin}/api/runtime`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      daemon: { status: 'ready', protocolVersion: 1, pid: 4321 },
      provider: { baseHost: 'api.example.test', modelId: 'chat-model' },
      workspace: { name: 'agent-workbench' },
    });
    expect(calls).toEqual([{ method: 'app.health', payload: {} }]);
  });

  it('registers the configured workspace before creating a session', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        if (input.method === 'workspace.register') {
          return success({ workspaceId: 'workspace-1' });
        }
        return success({ sessionId: 'session-1', turnId: 'turn-1' });
      },
    });
    const submissionId = '123e4567-e89b-42d3-a456-426614174000';

    const response = await fetch(`${api.origin}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: api.origin,
        'x-agent-workbench-csrf': 'csrf-token',
      },
      body: JSON.stringify({ submissionId, prompt: 'Read README.md' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    expect(calls).toEqual([
      {
        method: 'workspace.register',
        payload: { path: '/private/workspace' },
        clientRequestId: `web:session:${submissionId}`,
      },
      {
        method: 'session.create',
        payload: {
          workspaceId: 'workspace-1',
          title: 'Read README.md',
          prompt: 'Read README.md',
        },
        clientRequestId: `web:session:${submissionId}`,
      },
    ]);
  });

  it('reuses the same session client request id for an HTTP retry', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        return input.method === 'workspace.register'
          ? success({ workspaceId: 'workspace-1' })
          : success({ sessionId: 'session-1', turnId: 'turn-1' });
      },
    });
    const submissionId = '123e4567-e89b-42d3-a456-426614174000';
    const request = () =>
      fetch(`${api.origin}/api/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: api.origin,
          'x-agent-workbench-csrf': 'csrf-token',
        },
        body: JSON.stringify({ submissionId, prompt: 'Read README.md' }),
      });

    const first = await request();
    const retry = await request();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(await first.json()).toEqual(await retry.json());
    expect(calls.filter(({ method }) => method === 'workspace.register')).toHaveLength(1);
    expect(
      calls
        .filter(({ method }) => method === 'session.create')
        .map(({ clientRequestId }) => clientRequestId),
    ).toEqual([
      `web:session:${submissionId}`,
      `web:session:${submissionId}`,
    ]);
  });

  it('enqueues turns with a method-scoped stable client request id', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        return success({ turnId: 'turn-2' });
      },
    });
    const submissionId = '123e4567-e89b-42d3-a456-426614174000';

    const response = await fetch(`${api.origin}/api/sessions/session-1/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: api.origin,
        'x-agent-workbench-csrf': 'csrf-token',
      },
      body: JSON.stringify({ submissionId, prompt: 'Now inspect package.json' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ turnId: 'turn-2' });
    expect(calls).toEqual([
      {
        method: 'turn.enqueue',
        payload: {
          sessionId: 'session-1',
          prompt: 'Now inspect package.json',
        },
        sessionId: 'session-1',
        clientRequestId: `web:turn:${submissionId}`,
      },
    ]);
  });

  it('lists authoritative sessions without requiring mutation CSRF credentials', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        return success(sessionList);
      },
    });

    const response = await fetch(`${api.origin}/api/sessions`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(sessionList);
    expect(calls).toEqual([{ method: 'session.list', payload: {} }]);
  });

  it('cancels an encoded queued turn with a stable cancel submission id', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        return success({ turnId: 'turn /1', status: 'canceled' });
      },
    });
    const submissionId = '123e4567-e89b-42d3-a456-426614174000';
    const sessionId = 'session /1';
    const turnId = 'turn /1';

    const response = await fetch(
      `${api.origin}/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: api.origin,
          'x-agent-workbench-csrf': 'csrf-token',
        },
        body: JSON.stringify({ submissionId }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ turnId, status: 'canceled' });
    expect(calls).toEqual([
      {
        method: 'turn.cancel',
        payload: { sessionId, turnId },
        sessionId,
        clientRequestId: `web:cancel:${submissionId}`,
      },
    ]);
  });

  it('returns a validated authoritative session snapshot', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        return success(emptySnapshot);
      },
    });

    const response = await fetch(
      `${api.origin}/api/sessions/session-1/snapshot`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snapshot: emptySnapshot });
    expect(calls).toEqual([
      {
        method: 'session.getSnapshot',
        payload: { sessionId: 'session-1' },
        sessionId: 'session-1',
      },
    ]);
  });

  it('validates event pages against the requested session cursor and limit', async () => {
    const calls: RpcCall[] = [];
    const page = { events: [event(5), event(6)], highWaterSeq: 6 };
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        return success(page);
      },
    });

    const response = await fetch(
      `${api.origin}/api/sessions/session-1/events?afterSeq=4&limit=2`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(calls).toEqual([
      {
        method: 'event.listAfter',
        payload: { sessionId: 'session-1', afterSeq: 4, limit: 2 },
        sessionId: 'session-1',
      },
    ]);
  });

  it('maps RPC errors to local public text without reflecting private fields', async () => {
    const api = await startApi({
      call: async () => ({
        ok: false,
        error: {
          code: 'PRIVATE_VALIDATION_FAILURE',
          category: 'internal',
          message:
            'apiKey=provider-secret socketPath=/tmp/private.sock path=/private/workspace',
          retryable: false,
          userAction: 'Open /private/workspace and inspect provider-secret',
          detailsRef: '/tmp/private.sock#private-details',
          traceId: 'private-trace',
        },
      }),
    });

    const response = await fetch(
      `${api.origin}/api/sessions/missing/snapshot`,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'Request failed',
        retryable: false,
        userAction: null,
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('socketPath');
    expect(serialized).not.toContain('/tmp/private.sock');
    expect(serialized).not.toContain('/private/workspace');
    expect(serialized).not.toContain('private-details');
    expect(serialized).not.toContain('private-trace');
  });

  it('distinguishes unknown API routes from unsupported methods', async () => {
    const api = await startApi({
      call: async () => {
        throw new Error('RPC must not be called');
      },
    });

    const missing = await fetch(`${api.origin}/api/private/socket`);
    const wrongMethod = await fetch(`${api.origin}/api/sessions`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        origin: api.origin,
        'x-agent-workbench-csrf': 'csrf-token',
      },
    });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: 'WEB_ROUTE_NOT_FOUND',
        message: 'API route was not found',
        retryable: false,
        userAction: null,
      },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, POST');
    expect(await wrongMethod.json()).toEqual({
      error: {
        code: 'WEB_METHOD_NOT_ALLOWED',
        message: 'HTTP method is not allowed for this API route',
        retryable: false,
        userAction: null,
      },
    });
  });

  it('rejects RPC results carrying private transport or secret fields', async () => {
    const api = await startApi({
      call: async () =>
        success({
          status: 'ready',
          protocolVersion: 1,
          pid: 4321,
          apiKey: 'provider-secret',
          bootstrapSecret: 'daemon-secret',
          socketPath: '/tmp/private.sock',
        }),
    });

    const response = await fetch(`${api.origin}/api/runtime`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      daemon: { status: 'unavailable', protocolVersion: null, pid: null },
      provider: { baseHost: 'api.example.test', modelId: 'chat-model' },
      workspace: { name: 'agent-workbench' },
    });
    expect(body).not.toContain('apiKey');
    expect(body).not.toContain('provider-secret');
    expect(body).not.toContain('bootstrapSecret');
    expect(body).not.toContain('daemon-secret');
    expect(body).not.toContain('socketPath');
    expect(body).not.toContain('/tmp/private.sock');
    expect(body).not.toContain('/private/workspace');
  });

  it('rejects invalid body query and encoded path inputs before RPC', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        throw new Error('RPC must not be called');
      },
    });

    const invalidBody = await fetch(`${api.origin}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: api.origin,
        'x-agent-workbench-csrf': 'csrf-token',
      },
      body: JSON.stringify({
        submissionId: '123E4567-E89B-42D3-A456-426614174000',
        prompt: 'Read README.md',
      }),
    });
    const invalidQuery = await fetch(
      `${api.origin}/api/sessions/session-1/events?afterSeq=-1&limit=2`,
    );
    const invalidPath = await fetch(`${api.origin}/api/sessions/%E0/snapshot`);

    expect(invalidBody.status).toBe(400);
    expect(invalidQuery.status).toBe(400);
    expect(invalidPath.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('rejects invalid cancel bodies and malformed paths before RPC', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        throw new Error('RPC must not be called');
      },
    });

    const invalidBody = await fetch(
      `${api.origin}/api/sessions/session-1/turns/turn-1/cancel`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: api.origin,
          'x-agent-workbench-csrf': 'csrf-token',
        },
        body: JSON.stringify({
          submissionId: '123e4567-e89b-42d3-a456-426614174000',
          extra: true,
        }),
      },
    );
    const malformedPath = await fetch(
      `${api.origin}/api/sessions/%E0/turns/turn-1/cancel`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: api.origin,
          'x-agent-workbench-csrf': 'csrf-token',
        },
        body: JSON.stringify({
          submissionId: '123e4567-e89b-42d3-a456-426614174000',
        }),
      },
    );

    expect(invalidBody.status).toBe(400);
    expect(malformedPath.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it.each([
    ['SESSION_NOT_FOUND', 404, 'Session was not found', 'Refresh and choose an existing session'],
    ['TURN_NOT_FOUND', 404, 'Turn was not found in this session', 'Refresh the session and choose an existing turn'],
    ['TURN_NOT_CANCELLABLE', 409, 'Only queued turns can be canceled', 'Wait for the current turn to finish or choose a queued turn'],
  ] as const)(
    'preserves the sanitized public %s cancellation error',
    async (code, status, message, userAction) => {
      const api = await startApi({
        call: async () => ({
          ok: false,
          error: {
            code,
            category: 'validation',
            message,
            retryable: true,
            userAction,
            detailsRef: 'private-details',
            traceId: 'private-trace',
          },
        }),
      });

      const response = await fetch(
        `${api.origin}/api/sessions/session-1/turns/turn-1/cancel`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: api.origin,
            'x-agent-workbench-csrf': 'csrf-token',
          },
          body: JSON.stringify({
            submissionId: '123e4567-e89b-42d3-a456-426614174000',
          }),
        },
      );

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: {
          code,
          message,
          retryable: false,
          userAction,
        },
      });
    },
  );

  it('returns 413 for an oversized JSON body without reflecting its content', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        throw new Error('RPC must not be called');
      },
    });
    const privateMarker = 'oversized-private-marker';
    const response = await fetch(`${api.origin}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: api.origin,
        'x-agent-workbench-csrf': 'csrf-token',
      },
      body: JSON.stringify({
        submissionId: '123e4567-e89b-42d3-a456-426614174000',
        prompt: `${privateMarker}:${'x'.repeat(128 * 1024)}`,
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(413);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: 'WEB_REQUEST_TOO_LARGE',
        message: 'Request body is too large',
        retryable: false,
        userAction: null,
      },
    });
    expect(body).not.toContain(privateMarker);
    expect(calls).toEqual([]);
  });

  it('enforces the JSON body byte cap when Content-Length is absent', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        throw new Error('RPC must not be called');
      },
    });
    const privateMarker = 'chunked-private-marker';
    const response = await postChunkedJson(
      api.origin,
      '/api/sessions',
      JSON.stringify({
        submissionId: '123e4567-e89b-42d3-a456-426614174000',
        prompt: `${privateMarker}:${'x'.repeat(128 * 1024)}`,
      }),
    );

    expect(response.status).toBe(413);
    expect(response.body).not.toContain(privateMarker);
    expect(calls).toEqual([]);
  });

  it('returns the existing safe 400 when the prompt exceeds its schema limit', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        throw new Error('RPC must not be called');
      },
    });
    const privateMarker = 'prompt-private-marker';
    const response = await fetch(`${api.origin}/api/sessions/session-1/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: api.origin,
        'x-agent-workbench-csrf': 'csrf-token',
      },
      body: JSON.stringify({
        submissionId: '123e4567-e89b-42d3-a456-426614174000',
        prompt: `${privateMarker}:${'x'.repeat(64 * 1024)}`,
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: 'WEB_REQUEST_INVALID',
        message: 'Request body is invalid',
        retryable: false,
        userAction: null,
      },
    });
    expect(body).not.toContain(privateMarker);
    expect(calls).toEqual([]);
  });

  it('rejects an event page that violates the request context', async () => {
    const api = await startApi({
      call: async () =>
        success({
          events: [{ ...event(5), sessionId: 'session-2' }],
          highWaterSeq: 5,
        }),
    });

    const response = await fetch(
      `${api.origin}/api/sessions/session-1/events?afterSeq=4&limit=1`,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: 'RPC_PROTOCOL_ERROR',
        message: 'Runtime returned an invalid response',
        retryable: false,
        userAction: null,
      },
    });
  });

  it('rejects unknown or duplicate query parameters on every route', async () => {
    const calls: RpcCall[] = [];
    const api = await startApi({
      call: async (input) => {
        calls.push(input);
        throw new Error('RPC must not be called');
      },
    });

    const responses = await Promise.all([
      fetch(`${api.origin}/api/runtime?debug=true`),
      fetch(`${api.origin}/api/sessions/session-1/snapshot?x=1&x=2`),
      fetch(
        `${api.origin}/api/sessions/session-1/events?afterSeq=0&limit=1&extra=true`,
      ),
      fetch(
        `${api.origin}/api/sessions/session-1/events?afterSeq=0&afterSeq=1&limit=1`,
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400, 400]);
    expect(calls).toEqual([]);
  });

  it('returns a fresh unavailable runtime without coordinating reconnect itself', async () => {
    let reconnects = 0;
    const api = await startApi({
      call: async () => {
        throw new Error('RPC connection closed');
      },
      reconnect: async () => {
        reconnects += 1;
        throw new Error('Reconnect failed');
      },
    });

    const response = await fetch(`${api.origin}/api/runtime`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      daemon: { status: 'unavailable', protocolVersion: null, pid: null },
      provider: { baseHost: 'api.example.test', modelId: 'chat-model' },
      workspace: { name: 'agent-workbench' },
    });
    expect(reconnects).toBe(0);
  });
});
