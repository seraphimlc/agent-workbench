import { afterEach, describe, expect, it, vi } from 'vitest';

type ProviderPrivateConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string | null;
};

type ProbeCall = {
  readonly endpoint: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly messages: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly signal?: AbortSignal;
};

type ModelProbeModule = {
  probeProviderModel(
    config: ProviderPrivateConfig,
    options?: {
      readonly fetch?: typeof fetch;
      readonly adapter?: {
        call(input: ProbeCall): Promise<{
          readonly finishReason: 'stop' | 'tool_calls';
          readonly content: string | null;
          readonly toolCalls: readonly {
            readonly logicalCallId: string;
            readonly toolId: string;
            readonly argumentsJson: string;
          }[];
        }>;
      };
      readonly requestTimeoutMs?: number;
      readonly totalTimeoutMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<string>;
};

type FakeOpenAiServer = {
  readonly baseUrl: string;
  readonly completed: Promise<void>;
  close(): Promise<void>;
};

type FakeServerModule = {
  startFakeOpenAiServer(input: {
    readonly scripts: readonly [
      {
        readonly expectedRequest: {
          readonly method: 'GET' | 'POST';
          readonly path: string;
          readonly headers: Readonly<Record<string, string>>;
          readonly jsonBody?: unknown;
        };
        readonly response: {
          readonly status?: number;
          readonly headers?: Readonly<Record<string, string>>;
          readonly chunks: readonly Uint8Array[];
        };
      },
      ...Array<{
        readonly expectedRequest: {
          readonly method: 'GET' | 'POST';
          readonly path: string;
          readonly headers: Readonly<Record<string, string>>;
          readonly jsonBody?: unknown;
        };
        readonly response: {
          readonly status?: number;
          readonly headers?: Readonly<Record<string, string>>;
          readonly chunks: readonly Uint8Array[];
        };
      }>,
    ];
  }): Promise<FakeOpenAiServer>;
};

const MODULE_PATH = './model-probe.js';
const FAKE_SERVER_MODULE_PATH = '../../../../packages/testkit/src/fake-openai-server.js';
const encoder = new TextEncoder();

const CHAT_MESSAGES = [{ role: 'user', content: 'Reply with the single word OK.' }] as const;
const TOOL_MESSAGES = [
  {
    role: 'user',
    content: 'Call fs.read_text with {"path":"README.md"}. Do not answer with text.',
  },
] as const;
const PROVIDER_READ_TOOL = {
  type: 'function',
  function: {
    name: 'fs.read_text',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
    },
  },
} as const;

const loadProbe = async (): Promise<ModelProbeModule> =>
  (await import(MODULE_PATH)) as unknown as ModelProbeModule;

const loadFakeServer = async (): Promise<FakeServerModule> =>
  (await import(FAKE_SERVER_MODULE_PATH)) as unknown as FakeServerModule;

const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const chatSse = (requestId: string): Uint8Array =>
  encoder.encode(
    event({
      id: requestId,
      choices: [{ index: 0, delta: { content: 'OK' } }],
    }) +
      event({
        id: requestId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) +
      'data: [DONE]\n\n',
  );

const toolSse = (requestId: string): Uint8Array =>
  encoder.encode(
    event({
      id: requestId,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-readme',
                type: 'function',
                function: {
                  name: 'fs.read_text',
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
        },
      ],
    }) +
      event({
        id: requestId,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }) +
      'data: [DONE]\n\n',
  );

const providerConfig = (baseUrl: string, modelId: string | null): ProviderPrivateConfig => ({
  baseUrl: `${baseUrl}/v1`,
  apiKey: 'probe-secret-key',
  modelId,
});

const chatScript = (modelId: string, response: Uint8Array | { readonly status: number }) => ({
  expectedRequest: {
    method: 'POST' as const,
    path: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer probe-secret-key',
      'content-type': 'application/json',
    },
    jsonBody: {
      model: modelId,
      stream: true,
      messages: CHAT_MESSAGES,
      tools: [],
    },
  },
  response:
    response instanceof Uint8Array
      ? {
          headers: { 'content-type': 'text/event-stream' },
          chunks: [response],
        }
      : { status: response.status, chunks: [encoder.encode('provider raw failure')] },
});

const toolScript = (modelId: string, response: Uint8Array | { readonly status: number }) => ({
  expectedRequest: {
    method: 'POST' as const,
    path: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer probe-secret-key',
      'content-type': 'application/json',
    },
    jsonBody: {
      model: modelId,
      stream: true,
      messages: TOOL_MESSAGES,
      tools: [PROVIDER_READ_TOOL],
    },
  },
  response:
    response instanceof Uint8Array
      ? {
          headers: { 'content-type': 'text/event-stream' },
          chunks: [response],
        }
      : { status: response.status, chunks: [encoder.encode('provider raw failure')] },
});

const expectProbeFailure = async (operation: Promise<unknown>): Promise<Error & { code: string }> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({
      code: 'PROVIDER_MODEL_PROBE_FAILED',
      message: 'Provider model probe failed',
    });
    return error as Error & { code: string };
  }
  throw new Error('Expected provider model probe to fail');
};

afterEach(() => {
  vi.useRealTimers();
});

describe('probeProviderModel', () => {
  it('aborts promptly when the caller signal is canceled', async () => {
    const { probeProviderModel } = await loadProbe();
    const controller = new AbortController();
    const operation = expectProbeFailure(
      probeProviderModel(providerConfig('https://provider.example.test', 'slow'), {
        adapter: { call: async () => await new Promise<never>(() => undefined) },
        requestTimeoutMs: 10_000,
        totalTimeoutMs: 10_000,
        signal: controller.signal,
      }),
    );

    controller.abort();

    await expect(
      Promise.race([
        operation,
        new Promise<never>((_resolve, rejectPromise) => {
          setTimeout(() => rejectPromise(new Error('probe abort timed out')), 100);
        }),
      ]),
    ).resolves.toMatchObject({ code: 'PROVIDER_MODEL_PROBE_FAILED' });
  });

  it('uses an explicit model as the only candidate but still runs chat and Tool probes', async () => {
    const { probeProviderModel } = await loadProbe();
    const { startFakeOpenAiServer } = await loadFakeServer();
    const server = await startFakeOpenAiServer({
      scripts: [
        chatScript('explicit-model', chatSse('chat-explicit')),
        toolScript('explicit-model', toolSse('tool-explicit')),
      ],
    });

    try {
      await expect(
        probeProviderModel(providerConfig(server.baseUrl, 'explicit-model')),
      ).resolves.toBe('explicit-model');
      await server.completed;
    } finally {
      await server.close();
    }
  });

  it('discovers models, probes them in stable order, and returns the first two-stage success', async () => {
    const { probeProviderModel } = await loadProbe();
    const { startFakeOpenAiServer } = await loadFakeServer();
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'GET',
            path: '/v1/models',
            headers: { authorization: 'Bearer probe-secret-key' },
          },
          response: {
            headers: { 'content-type': 'application/json' },
            chunks: [
              encoder.encode(
                JSON.stringify({
                  data: [
                    { id: 'text-embedding-3-small' },
                    { id: 'beta-chat' },
                    { id: 'image-1' },
                    { id: 'alpha-chat' },
                    { id: 'rerank-v3' },
                    { id: 'audio-1' },
                  ],
                }),
              ),
            ],
          },
        },
        chatScript('alpha-chat', { status: 400 }),
        chatScript('beta-chat', chatSse('chat-beta')),
        toolScript('beta-chat', toolSse('tool-beta')),
      ],
    });

    try {
      await expect(probeProviderModel(providerConfig(server.baseUrl, null))).resolves.toBe(
        'beta-chat',
      );
      await server.completed;
    } finally {
      await server.close();
    }
  });

  it('continues to the next candidate when the first candidate passes chat but fails Tool probing', async () => {
    const { probeProviderModel } = await loadProbe();
    const { startFakeOpenAiServer } = await loadFakeServer();
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'GET',
            path: '/v1/models',
            headers: { authorization: 'Bearer probe-secret-key' },
          },
          response: {
            headers: { 'content-type': 'application/json' },
            chunks: [
              encoder.encode(JSON.stringify({ data: [{ id: 'beta-chat' }, { id: 'alpha-chat' }] })),
            ],
          },
        },
        chatScript('alpha-chat', chatSse('chat-alpha')),
        toolScript('alpha-chat', { status: 400 }),
        chatScript('beta-chat', chatSse('chat-beta')),
        toolScript('beta-chat', toolSse('tool-beta')),
      ],
    });

    try {
      await expect(probeProviderModel(providerConfig(server.baseUrl, null))).resolves.toBe(
        'beta-chat',
      );
      await server.completed;
    } finally {
      await server.close();
    }
  });

  it('continues to the next candidate when the first candidate Tool probe times out', async () => {
    vi.useFakeTimers();
    const { probeProviderModel } = await loadProbe();
    const calls: string[] = [];
    const operation = probeProviderModel(providerConfig('https://provider.example.test', null), {
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ id: 'beta-chat' }, { id: 'alpha-chat' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      adapter: {
        call: async (input) => {
          const stage = input.tools.length === 0 ? 'chat' : 'tool';
          calls.push(`${input.modelId}:${stage}`);
          if (input.modelId === 'alpha-chat' && stage === 'tool') {
            return await new Promise<never>(() => undefined);
          }
          if (stage === 'chat') {
            return { finishReason: 'stop', content: 'OK', toolCalls: [] };
          }
          return {
            finishReason: 'tool_calls',
            content: null,
            toolCalls: [
              {
                logicalCallId: 'call-readme',
                toolId: 'fs.read_text',
                argumentsJson: '{"path":"README.md"}',
              },
            ],
          };
        },
      },
      requestTimeoutMs: 25,
      totalTimeoutMs: 1_000,
    });
    const result = expect(operation).resolves.toBe('beta-chat');

    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(calls).toEqual([
      'alpha-chat:chat',
      'alpha-chat:tool',
      'beta-chat:chat',
      'beta-chat:tool',
    ]);
  });

  it('filters non-chat models, sorts deterministically, and probes at most three candidates', async () => {
    const { probeProviderModel } = await loadProbe();
    const attempted: string[] = [];
    const config = providerConfig('https://provider.example.test', null);
    const fetchModels: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'zeta-chat' },
            { id: 'image-1' },
            { id: 'alpha-chat' },
            { id: 'beta-chat' },
            { id: 'text-embedding-3-small' },
            { id: 'delta-chat' },
            { id: 'gamma-chat' },
            { id: 'audio-1' },
            { id: 'rerank-v3' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    await expectProbeFailure(
      probeProviderModel(config, {
        fetch: fetchModels,
        adapter: {
          call: async (input) => {
            attempted.push(input.modelId);
            throw new Error('candidate rejected');
          },
        },
      }),
    );

    expect(attempted).toEqual(['alpha-chat', 'beta-chat', 'delta-chat']);
  });

  it('enforces the per-request timeout even when an injected adapter ignores aborts', async () => {
    vi.useFakeTimers();
    const { probeProviderModel } = await loadProbe();
    const operation = probeProviderModel(providerConfig('https://provider.example.test', 'slow'), {
      adapter: { call: async () => await new Promise<never>(() => undefined) },
      requestTimeoutMs: 25,
      totalTimeoutMs: 1_000,
    });
    const failure = expectProbeFailure(operation);

    await vi.advanceTimersByTimeAsync(25);
    await failure;
  });

  it('enforces the total timeout while model discovery is pending', async () => {
    vi.useFakeTimers();
    const { probeProviderModel } = await loadProbe();
    const operation = probeProviderModel(providerConfig('https://provider.example.test', null), {
      fetch: async () => await new Promise<Response>(() => undefined),
      requestTimeoutMs: 1_000,
      totalTimeoutMs: 40,
    });
    const failure = expectProbeFailure(operation);

    await vi.advanceTimersByTimeAsync(40);
    await failure;
  });

  it('applies the per-request timeout while the models response body is pending', async () => {
    vi.useFakeTimers();
    const { probeProviderModel } = await loadProbe();
    let settled = false;
    const operation = probeProviderModel(providerConfig('https://provider.example.test', null), {
      fetch: async () =>
        new Response(new ReadableStream({ start: () => undefined }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      requestTimeoutMs: 25,
      totalTimeoutMs: 40,
    });
    const failure = expectProbeFailure(operation).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(25);
    const settledAtRequestTimeout = settled;
    await vi.advanceTimersByTimeAsync(15);
    await failure;
    expect(settledAtRequestTimeout).toBe(true);
  });

  it('returns one stable sanitized failure without API keys or raw provider responses', async () => {
    const { probeProviderModel } = await loadProbe();
    const apiKey = 'never-print-this-key';
    const error = await expectProbeFailure(
      probeProviderModel(
        {
          baseUrl: 'https://provider.example.test/v1',
          apiKey,
          modelId: 'broken-model',
        },
        {
          adapter: {
            call: async () => {
              throw new Error(`raw provider response with ${apiKey}`);
            },
          },
        },
      ),
    );

    expect(error.message).not.toContain(apiKey);
    expect(error.message).not.toContain('raw provider response');
    expect(JSON.stringify(error)).not.toContain(apiKey);
  });
});
