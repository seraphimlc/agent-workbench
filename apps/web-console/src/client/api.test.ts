import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiPublicError,
  createApiClient,
  type ApiClient,
} from './api.js';

const submissionId = '123e4567-e89b-42d3-a456-426614174000';

const runtime = {
  daemon: { status: 'ready', protocolVersion: 1, pid: 4321 },
  provider: { baseHost: 'api.example.test', modelId: 'chat-model' },
  workspace: { name: 'agent-workbench' },
} as const;

const snapshot = {
  session: {
    id: 'session/1',
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
} as const;

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
} as const;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const documentWithToken = (token = 'csrf-token'): Document =>
  ({
    querySelector: () => ({ content: token }),
  }) as unknown as Document;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web console client API', () => {
  it('always exposes the session bridge methods', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api: ApiClient = createApiClient({
      document: documentWithToken(),
      fetch,
    });
    const sessionBridge: Required<
      Pick<
        ApiClient,
        'listSessions' | 'cancelTurn' | 'createCancelTurnOperation'
      >
    > = api;

    expect(sessionBridge.listSessions).toBeTypeOf('function');
    expect(sessionBridge.cancelTurn).toBeTypeOf('function');
    expect(sessionBridge.createCancelTurnOperation).toBeTypeOf('function');
  });

  it('fails closed before any request when the CSRF bootstrap token is missing', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const document = {
      querySelector: () => null,
    } as unknown as Document;

    expect(() => createApiClient({ document, fetch })).toThrow(
      'CSRF_BOOTSTRAP_MISSING',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads and validates runtime, snapshot, and incremental event pages', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(runtime))
      .mockResolvedValueOnce(jsonResponse({ snapshot }))
      .mockResolvedValueOnce(
        jsonResponse({ events: [], highWaterSeq: 0 }),
      );
    const api = createApiClient({ document: documentWithToken(), fetch });

    await expect(api.getRuntime()).resolves.toEqual(runtime);
    await expect(api.getSnapshot('session/1')).resolves.toEqual(snapshot);
    await expect(
      api.getEvents({ sessionId: 'session/1', afterSeq: 0, limit: 25 }),
    ).resolves.toEqual({ events: [], highWaterSeq: 0 });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/runtime',
      '/api/sessions/session%2F1/snapshot',
      '/api/sessions/session%2F1/events?afterSeq=0&limit=25',
    ]);
    expect(fetch.mock.calls.every(([, init]) => init?.cache === 'no-store')).toBe(
      true,
    );
  });

  it('lists authoritative sessions and encodes both cancel path IDs', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(sessionList))
      .mockResolvedValueOnce(jsonResponse({ turnId: 'turn /1', status: 'canceled' }));
    const api = createApiClient({ document: documentWithToken(), fetch });
    const submission = { submissionId };

    await expect(api.listSessions()).resolves.toEqual(sessionList);
    await expect(api.cancelTurn('session /1', 'turn /1', submission)).resolves.toEqual({
      turnId: 'turn /1',
      status: 'canceled',
    });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/sessions',
      '/api/sessions/session%20%2F1/turns/turn%20%2F1/cancel',
    ]);
    expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(submission));
  });

  it('rejects invalid successful response bodies', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ ...runtime, apiKey: 'secret' }));
    const api = createApiClient({ document: documentWithToken(), fetch });

    await expect(api.getRuntime()).rejects.toThrow();
  });

  it('posts JSON with the CSRF header without synthesizing an Origin header', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ sessionId: 'session-1', turnId: 'turn-1' }, 201),
      )
      .mockResolvedValueOnce(jsonResponse({ turnId: 'turn-2' }, 202));
    const api = createApiClient({ document: documentWithToken(), fetch });
    const submission = { submissionId, prompt: 'Read README.md' };

    await expect(api.createSession(submission)).resolves.toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    await expect(api.submitTurn('session/1', submission)).resolves.toEqual({
      turnId: 'turn-2',
    });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/sessions',
      '/api/sessions/session%2F1/turns',
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify(submission));
      expect(new Headers(init?.headers)).toEqual(
        new Headers({
          accept: 'application/json',
          'content-type': 'application/json',
          'x-agent-workbench-csrf': 'csrf-token',
        }),
      );
      expect(new Headers(init?.headers).has('origin')).toBe(false);
    }
  });

  it('parses public failures into a typed error without exposing extra fields', async () => {
    const publicFailure = {
      error: {
        code: 'RUNTIME_UNAVAILABLE',
        message: 'Runtime is unavailable',
        retryable: true,
        userAction: 'Retry in a moment',
      },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(publicFailure, 503))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              ...publicFailure.error,
              privateTrace: 'must-not-cross-the-client-boundary',
            },
          },
          503,
        ),
      );
    const api = createApiClient({ document: documentWithToken(), fetch });

    const failure = await api.getRuntime().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiPublicError);
    expect(failure).toMatchObject({
      status: 503,
      code: 'RUNTIME_UNAVAILABLE',
      message: 'Runtime is unavailable',
      retryable: true,
      userAction: 'Retry in a moment',
    });
    expect(failure).not.toHaveProperty('privateTrace');

    await expect(api.getRuntime()).rejects.toThrow();
  });

  it.each(['session', 'turn'] as const)(
    'creates one stable %s operation whose retry reuses the exact submission body',
    async (kind) => {
      const randomUUID = vi.fn(() => submissionId);
      const success =
        kind === 'session'
          ? { sessionId: 'session-1', turnId: 'turn-1' }
          : { turnId: 'turn-2' };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new TypeError('network unavailable'))
        .mockResolvedValueOnce(
          jsonResponse(success, kind === 'session' ? 201 : 202),
        );
      const api = createApiClient({
        document: documentWithToken(),
        fetch,
        uuidSource: { randomUUID },
      });
      const operation =
        kind === 'session'
          ? api.createSessionOperation({ prompt: 'Read README.md' })
          : api.createTurnOperation('session/1', { prompt: 'Read README.md' });

      await expect(operation.execute()).rejects.toThrow('network unavailable');
      await expect(operation.retry()).resolves.toEqual(success);

      const bodies = fetch.mock.calls.map(([, init]) => String(init?.body));
      expect(randomUUID).toHaveBeenCalledTimes(1);
      expect(bodies[0]).toBe(bodies[1]);
      expect(bodies.map((body) => JSON.parse(body))).toEqual([
        { submissionId, prompt: 'Read README.md' },
        { submissionId, prompt: 'Read README.md' },
      ]);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(
        kind === 'session'
          ? ['/api/sessions', '/api/sessions']
          : [
              '/api/sessions/session%2F1/turns',
              '/api/sessions/session%2F1/turns',
            ],
      );
    },
  );

  it('creates one stable cancel operation whose retry reuses the exact submission body', async () => {
    const randomUUID = vi.fn(() => submissionId);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(
        jsonResponse({ turnId: 'turn /1', status: 'canceled' }),
      );
    const api = createApiClient({
      document: documentWithToken(),
      fetch,
      uuidSource: { randomUUID },
    });
    const operation = api.createCancelTurnOperation('session /1', 'turn /1');

    await expect(operation.execute()).rejects.toThrow('network unavailable');
    await expect(operation.retry()).resolves.toEqual({
      turnId: 'turn /1',
      status: 'canceled',
    });

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/sessions/session%20%2F1/turns/turn%20%2F1/cancel',
      '/api/sessions/session%20%2F1/turns/turn%20%2F1/cancel',
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ submissionId }),
      JSON.stringify({ submissionId }),
    ]);
  });
});
