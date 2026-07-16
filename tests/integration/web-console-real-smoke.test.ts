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

const succeededSnapshot = (privateValue: string): SessionSnapshot => ({
  session: session(false),
  messages: [
    userMessage,
    {
      id: 'message-assistant-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      role: 'assistant',
      status: 'completed',
      content: `Persisted final containing ${privateValue}`,
      createdAt: timestamp(6),
      completedAt: timestamp(6),
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
      finishedAt: timestamp(6),
      errorCode: null,
      errorMessage: null,
      resultMessageId: 'message-assistant-1',
    },
  ],
  highWaterSeq: 6,
  events: [
    visibleEvent(1, 'session.created'),
    visibleEvent(2, 'model.started', {
      turnId: 'turn-1',
      actor: 'model',
      payload: { modelCallId: 'model-call-1' },
    }),
    visibleEvent(3, 'model.completed', {
      turnId: 'turn-1',
      actor: 'model',
      payload: { modelCallId: 'model-call-1', modelAttemptId: 'attempt-1' },
    }),
    visibleEvent(4, 'tool.started', {
      turnId: 'turn-1',
      toolRunId: 'tool-run-1',
      actor: 'tool',
      audience: 'both',
      payload: {
        toolRunId: 'tool-run-1',
        toolId: 'fs.read_text',
        inputSummary: 'package.json',
      },
    }),
    visibleEvent(5, 'tool.succeeded', {
      turnId: 'turn-1',
      toolRunId: 'tool-run-1',
      actor: 'tool',
      audience: 'both',
      payload: {
        toolRunId: 'tool-run-1',
        outputBytes: 128,
        outputSummary: `tool content ${privateValue}`,
      },
    }),
    visibleEvent(6, 'turn.succeeded', {
      turnId: 'turn-1',
      payload: { modelAttemptId: 'attempt-1' },
    }),
  ],
});

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
        'model.completed': 1,
        'model.started': 1,
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
});
