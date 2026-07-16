import type {
  RendererSessionEventEnvelope,
  SessionSnapshot,
} from '@agent-workbench/protocol';
import { describe, expect, it } from 'vitest';

import {
  runWebConsoleRealSmoke,
  runWebConsoleRealSmokeCli,
} from '../../scripts/web-console-real-smoke.js';

const timestamp = (second: number): string =>
  `2026-07-16T00:00:${String(second).padStart(2, '0')}.000Z`;

const visibleEvent = (
  seq: number,
  type: string,
  options: {
    readonly turnId?: string | null;
    readonly toolRunId?: string | null;
    readonly actor?: RendererSessionEventEnvelope['actor'];
    readonly audience?: 'ui' | 'both';
    readonly payload?: unknown;
  } = {},
): RendererSessionEventEnvelope => ({
  id: `event-${String(seq)}`,
  sessionId: 'session-1',
  turnId: options.turnId ?? null,
  toolRunId: options.toolRunId ?? null,
  seq,
  actor: options.actor ?? 'daemon',
  audience: options.audience ?? 'ui',
  createdAt: timestamp(seq),
  type,
  redacted: false,
  payload: (options.payload ?? {}) as never,
  blobId: null,
});

const session = (running: boolean): SessionSnapshot['session'] => ({
  id: 'session-1',
  title: 'Inspect package.json',
  workspaceId: 'workspace-1',
  lifecycleStatus: 'active',
  runtimeStatus: running ? 'running' : 'idle',
  queueBlockReason: null,
  recoveryEpisode: 0,
  recoverySourceTurnId: null,
  currentTurnId: running ? 'turn-1' : null,
  mode: 'craft',
  accessMode: 'full_access',
  nextTurnOrdinal: 2,
  nextEventSeq: running ? 4 : 7,
  revision: running ? 3 : 8,
  createdAt: timestamp(0),
  updatedAt: timestamp(running ? 3 : 6),
});

const userMessage: SessionSnapshot['messages'][number] = {
  id: 'message-user-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  role: 'user',
  status: 'completed',
  content: 'Read package.json',
  createdAt: timestamp(1),
  completedAt: timestamp(1),
};

const runningSnapshot = (): SessionSnapshot => ({
  session: session(true),
  messages: [userMessage],
  turns: [
    {
      id: 'turn-1',
      sessionId: 'session-1',
      ordinal: 1,
      clientRequestId: 'request-1',
      queueKind: 'normal',
      status: 'running',
      inputMessageId: userMessage.id,
      modeSnapshot: 'craft',
      accessModeSnapshot: 'full_access',
      executionFence: 1,
      queuedAt: timestamp(1),
      startedAt: timestamp(2),
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      resultMessageId: null,
    },
  ],
  highWaterSeq: 3,
  events: [
    visibleEvent(1, 'session.created'),
    visibleEvent(2, 'turn.queued', { turnId: 'turn-1' }),
    visibleEvent(3, 'model.started', {
      turnId: 'turn-1',
      actor: 'model',
      payload: { modelCallId: 'model-call-1' },
    }),
  ],
});

type SucceededSnapshotOptions = {
  readonly includePostToolModelCall?: boolean;
  readonly inputSummary?: string;
  readonly postToolModelBeforeTool?: boolean;
  readonly assistantContent?: string;
  readonly turnSucceededModelAttemptId?: string;
};

const succeededSnapshot = (
  privateValue: string,
  options: SucceededSnapshotOptions = {},
): SessionSnapshot => {
  const events: RendererSessionEventEnvelope[] = [];
  const appendEvent = (
    type: string,
    eventOptions: Parameters<typeof visibleEvent>[2] = {},
  ): void => {
    events.push(visibleEvent(events.length + 1, type, eventOptions));
  };
  const includePostToolModelCall = options.includePostToolModelCall ?? true;
  const appendPostToolModelCall = (): void => {
    appendEvent('model.started', {
      turnId: 'turn-1',
      actor: 'model',
      payload: { modelCallId: 'model-call-2' },
    });
    appendEvent('model.completed', {
      turnId: 'turn-1',
      actor: 'model',
      payload: { modelCallId: 'model-call-2', modelAttemptId: 'attempt-2' },
    });
  };

  appendEvent('session.created');
  appendEvent('model.started', {
    turnId: 'turn-1',
    actor: 'model',
    payload: { modelCallId: 'model-call-1' },
  });
  appendEvent('model.completed', {
    turnId: 'turn-1',
    actor: 'model',
    payload: { modelCallId: 'model-call-1', modelAttemptId: 'attempt-1' },
  });
  if (includePostToolModelCall && options.postToolModelBeforeTool) {
    appendPostToolModelCall();
  }
  appendEvent('tool.started', {
    turnId: 'turn-1',
    toolRunId: 'tool-run-1',
    actor: 'tool',
    audience: 'both',
    payload: {
      toolRunId: 'tool-run-1',
      toolId: 'fs.read_text',
      inputSummary: options.inputSummary ?? 'package.json',
    },
  });
  appendEvent('tool.succeeded', {
    turnId: 'turn-1',
    toolRunId: 'tool-run-1',
    actor: 'tool',
    audience: 'both',
    payload: {
      toolRunId: 'tool-run-1',
      outputBytes: 128,
      outputSummary: `tool content ${privateValue}`,
    },
  });
  if (includePostToolModelCall && !options.postToolModelBeforeTool) {
    appendPostToolModelCall();
  }
  appendEvent('turn.succeeded', {
    turnId: 'turn-1',
    payload: {
      modelAttemptId:
        options.turnSucceededModelAttemptId ??
        (includePostToolModelCall ? 'attempt-2' : 'attempt-1'),
    },
  });

  const finishedAt = timestamp(events.length);
  return {
    session: {
      ...session(false),
      nextEventSeq: events.length + 1,
      revision: events.length + 2,
      updatedAt: finishedAt,
    },
    messages: [
      userMessage,
      {
        id: 'message-assistant-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        role: 'assistant',
        status: 'completed',
        content:
          options.assistantContent ?? `Persisted final containing ${privateValue}`,
        createdAt: finishedAt,
        completedAt: finishedAt,
      },
    ],
    turns: [
      {
        id: 'turn-1',
        sessionId: 'session-1',
        ordinal: 1,
        clientRequestId: 'request-1',
        queueKind: 'normal',
        status: 'succeeded',
        inputMessageId: userMessage.id,
        modeSnapshot: 'craft',
        accessModeSnapshot: 'full_access',
        executionFence: 1,
        queuedAt: timestamp(1),
        startedAt: timestamp(2),
        finishedAt,
        errorCode: null,
        errorMessage: null,
        resultMessageId: 'message-assistant-1',
      },
    ],
    highWaterSeq: events.length,
    events,
  };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const requestUrl = (input: string | URL | Request): URL =>
  new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );

const createFetch = (snapshot: SessionSnapshot, modelId: string) =>
  async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url.pathname === '/') {
      return new Response(
        '<html><head><meta name="agent-workbench-csrf" content="csrf-token"></head></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    if (url.pathname === '/api/runtime') {
      return jsonResponse({
        daemon: { status: 'ready', protocolVersion: 1, pid: 123 },
        provider: { baseHost: 'provider.example.test', modelId },
        workspace: { name: 'private-workspace' },
      });
    }
    if (url.pathname === '/api/sessions') {
      return jsonResponse({ sessionId: 'session-1', turnId: 'turn-1' }, 201);
    }
    if (url.pathname === '/api/sessions/session-1/snapshot') {
      return jsonResponse({ snapshot });
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

const validEnvironment = {
  AGENT_WORKBENCH_PROVIDER_BASE_URL:
    'https://provider.example.test/private/provider/v1',
  AGENT_WORKBENCH_PROVIDER_API_KEY: 'private-api-key',
  AGENT_WORKBENCH_PROVIDER_MODEL: 'optional-model',
  AGENT_WORKBENCH_DEMO_WORKSPACE: '/private/workspace',
} as const;

type Settled<Value> =
  | { readonly status: 'resolved'; readonly value: Value }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'hung' };

const settleWithin = async <Value>(
  operation: Promise<Value>,
  timeoutMs = 250,
): Promise<Settled<Value>> =>
  await Promise.race([
    operation.then<Settled<Value>>(
      (value) => ({ status: 'resolved', value }),
      (error: unknown) => ({ status: 'rejected', error }),
    ),
    new Promise<Settled<Value>>((resolvePromise) => {
      setTimeout(() => resolvePromise({ status: 'hung' }), timeoutMs);
    }),
  ]);

const successfulServer = (stop: () => Promise<void> = async () => undefined) => ({
  url: 'http://127.0.0.1:4123/',
  stop,
});

describe('web-console-real-smoke', () => {
  it.each([
    ['base URL', { AGENT_WORKBENCH_PROVIDER_API_KEY: 'private-api-key' }],
    [
      'API key',
      {
        AGENT_WORKBENCH_PROVIDER_BASE_URL: 'https://provider.example.test/v1',
      },
    ],
  ])('fails stably before startup when %s is missing', async (_name, environment) => {
    let starts = 0;

    await expect(
      runWebConsoleRealSmoke({
        environment,
        dependencies: {
          startServer: async () => {
            starts += 1;
            throw new Error('must not start');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'SMOKE_CONFIG_MISSING',
      message: 'Required Web Console smoke configuration is missing',
    });
    expect(starts).toBe(0);
  });

  it('returns only a redacted summary of the successful persisted lifecycle', async () => {
    let stops = 0;
    const summary = await runWebConsoleRealSmoke({
      cwd: '/private/workspace',
      environment: validEnvironment,
      dependencies: {
        startServer: async () => ({
          url: 'http://127.0.0.1:4123/',
          stop: async () => {
            stops += 1;
          },
        }),
        fetch: createFetch(
          succeededSnapshot('/private/workspace private-api-key raw-provider-response'),
          'private-api-key',
        ),
        now: () => 100,
        createSubmissionId: () => '123e4567-e89b-42d3-a456-426614174000',
      },
    });

    expect(summary).toEqual({
      status: 'ok',
      modelId: '[redacted]',
      eventTypeCounts: {
        'model.completed': 2,
        'model.started': 2,
        'session.created': 1,
        'tool.started': 1,
        'tool.succeeded': 1,
        'turn.succeeded': 1,
      },
      turnStatus: 'succeeded',
      durationMs: 0,
    });
    const output = JSON.stringify(summary);
    for (const privateValue of [
      'private-api-key',
      '/private/provider/v1',
      '/private/workspace',
      'raw-provider-response',
      'tool content',
      'Persisted final',
      'bootstrap',
      'socket',
    ]) {
      expect(output).not.toContain(privateValue);
    }
    expect(stops).toBe(1);
  });

  it.each([
    [
      'missing the post-tool model call',
      succeededSnapshot('safe', { includePostToolModelCall: false }),
    ],
    [
      'reading a different path',
      succeededSnapshot('safe', { inputSummary: 'packages/protocol/package.json' }),
    ],
    [
      'starting the final model call before the Tool completes',
      succeededSnapshot('safe', { postToolModelBeforeTool: true }),
    ],
    [
      'persisting an empty assistant final',
      succeededSnapshot('safe', { assistantContent: '   ' }),
    ],
    [
      'pointing terminal success at the pre-tool model attempt',
      succeededSnapshot('safe', { turnSucceededModelAttemptId: 'attempt-1' }),
    ],
  ])('rejects a terminal snapshot %s', async (_name, snapshot) => {
    await expect(
      runWebConsoleRealSmoke({
        environment: validEnvironment,
        dependencies: {
          startServer: async () => successfulServer(),
          fetch: createFetch(snapshot, 'safe-model'),
          createSubmissionId: () => '123e4567-e89b-42d3-a456-426614174000',
        },
      }),
    ).rejects.toMatchObject({ code: 'SMOKE_REQUIREMENTS_NOT_MET' });
  });

  it('prints one safe error JSON object without echoing an unknown failure', async () => {
    let stdout = '';
    let stderr = '';
    const exitCode = await runWebConsoleRealSmokeCli(
      {},
      {
        runSmoke: async () => {
          throw new Error(
            'private-api-key https://provider.example.test/private/provider/v1 /private/workspace raw provider response tool content bootstrap socket',
          );
        },
        writeStdout: (line) => {
          stdout += line;
        },
        writeStderr: (line) => {
          stderr += line;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stderr)).toEqual({
      status: 'error',
      code: 'SMOKE_FAILED',
      message: 'Web Console real smoke failed',
    });
    expect(stderr).not.toMatch(
      /private-api-key|private\/provider|private\/workspace|provider response|tool content|bootstrap|socket/,
    );
  });

  it('stops the server when condition polling reaches the timeout', async () => {
    let now = 0;
    let stops = 0;

    await expect(
      runWebConsoleRealSmoke({
        environment: validEnvironment,
        timeoutMs: 100,
        pollIntervalMs: 25,
        dependencies: {
          startServer: async () => ({
            url: 'http://127.0.0.1:4123/',
            stop: async () => {
              stops += 1;
            },
          }),
          fetch: createFetch(runningSnapshot(), 'safe-model'),
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
          createSubmissionId: () => '123e4567-e89b-42d3-a456-426614174000',
        },
      }),
    ).rejects.toMatchObject({
      code: 'SMOKE_TIMEOUT',
      message: 'Web Console smoke timed out before the turn became terminal',
    });
    expect(stops).toBe(1);
  });

  it('uses one deadline from startup instead of resetting it before polling', async () => {
    let now = 0;
    const baseFetch = createFetch(
      succeededSnapshot('safe persisted final'),
      'safe-model',
    );

    await expect(
      runWebConsoleRealSmoke({
        environment: validEnvironment,
        timeoutMs: 100,
        dependencies: {
          startServer: async () => {
            now = 60;
            return successfulServer();
          },
          fetch: async (input, init) => {
            if (requestUrl(input).pathname === '/') now = 110;
            return await baseFetch(input, init);
          },
          now: () => now,
          createSubmissionId: () => '123e4567-e89b-42d3-a456-426614174000',
        },
      }),
    ).rejects.toMatchObject({ code: 'SMOKE_TIMEOUT' });
  });

  it('bounds a hanging server startup and aborts its startup signal', async () => {
    let startupSignal: AbortSignal | undefined;
    const outcome = await settleWithin(
      runWebConsoleRealSmoke({
        environment: validEnvironment,
        timeoutMs: 25,
        dependencies: {
          startServer: async (options) => {
            startupSignal = Reflect.get(options, 'signal') as AbortSignal | undefined;
            return await new Promise<never>(() => undefined);
          },
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: 'rejected',
      error: { code: 'SMOKE_TIMEOUT' },
    });
    expect(startupSignal?.aborted).toBe(true);
  });

  it('bounds a hanging HTML body read and stops the started server', async () => {
    let fetchSignal: AbortSignal | undefined;
    let stops = 0;
    const outcome = await settleWithin(
      runWebConsoleRealSmoke({
        environment: validEnvironment,
        timeoutMs: 25,
        dependencies: {
          startServer: async () =>
            successfulServer(async () => {
              stops += 1;
            }),
          fetch: async (_input, init) => {
            fetchSignal = init?.signal ?? undefined;
            return {
              ok: true,
              text: async () => await new Promise<string>(() => undefined),
            } as Response;
          },
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: 'rejected',
      error: { code: 'SMOKE_TIMEOUT' },
    });
    expect(fetchSignal?.aborted).toBe(true);
    expect(stops).toBe(1);
  });

  it('bounds a hanging session POST with the same abortable deadline', async () => {
    const baseFetch = createFetch(runningSnapshot(), 'safe-model');
    let sessionSignal: AbortSignal | undefined;
    let stops = 0;
    const outcome = await settleWithin(
      runWebConsoleRealSmoke({
        environment: validEnvironment,
        timeoutMs: 25,
        dependencies: {
          startServer: async () =>
            successfulServer(async () => {
              stops += 1;
            }),
          fetch: async (input, init) => {
            if (requestUrl(input).pathname === '/api/sessions') {
              sessionSignal = init?.signal ?? undefined;
              return await new Promise<Response>(() => undefined);
            }
            return await baseFetch(input, init);
          },
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: 'rejected',
      error: { code: 'SMOKE_TIMEOUT' },
    });
    expect(sessionSignal?.aborted).toBe(true);
    expect(stops).toBe(1);
  });

  it('bounds a hanging snapshot poll with the same abortable deadline', async () => {
    const baseFetch = createFetch(runningSnapshot(), 'safe-model');
    let pollSignal: AbortSignal | undefined;
    let stops = 0;
    const outcome = await settleWithin(
      runWebConsoleRealSmoke({
        environment: validEnvironment,
        timeoutMs: 25,
        dependencies: {
          startServer: async () =>
            successfulServer(async () => {
              stops += 1;
            }),
          fetch: async (input, init) => {
            if (requestUrl(input).pathname.endsWith('/snapshot')) {
              pollSignal = init?.signal ?? undefined;
              return await new Promise<Response>(() => undefined);
            }
            return await baseFetch(input, init);
          },
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: 'rejected',
      error: { code: 'SMOKE_TIMEOUT' },
    });
    expect(pollSignal?.aborted).toBe(true);
    expect(stops).toBe(1);
  });

  it('bounds hanging cleanup and preserves both cleanup and primary failures safely', async () => {
    const outcome = await settleWithin(
      runWebConsoleRealSmoke({
        environment: validEnvironment,
        timeoutMs: 25,
        pollIntervalMs: 5,
        dependencies: {
          startServer: async () =>
            successfulServer(async () => {
              await new Promise<void>(() => undefined);
            }),
          fetch: createFetch(runningSnapshot(), 'safe-model'),
        },
      }),
    );

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.error).toBeInstanceOf(AggregateError);
    expect(outcome.error).toMatchObject({
      code: 'SMOKE_MULTIPLE_FAILURES',
      message: 'Web Console smoke and cleanup both failed',
      errors: [
        { code: 'SMOKE_TIMEOUT', message: expect.not.stringContaining('private') },
        { code: 'SMOKE_STOP_FAILED', message: expect.not.stringContaining('private') },
      ],
    });
    expect(JSON.stringify(outcome.error)).not.toMatch(
      /private-api-key|private\/provider|private\/workspace|provider response|tool content|bootstrap|socket/,
    );
  });
});
