import { describe, expect, it } from 'vitest';

import { OpenAiCompatibleAdapter } from './openai-compatible-adapter.js';

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
          readonly method: 'POST';
          readonly path: string;
          readonly headers: Readonly<Record<string, string>>;
          readonly jsonBody: unknown;
        };
        readonly response: {
          readonly status?: number;
          readonly headers?: Readonly<Record<string, string>>;
          readonly chunks: readonly Uint8Array[];
        };
      },
    ];
  }): Promise<FakeOpenAiServer>;
};

const FAKE_SERVER_MODULE_PATH = '../../../../packages/testkit/src/fake-openai-server.js';
const encoder = new TextEncoder();
const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const loadFakeServer = async (): Promise<FakeServerModule> =>
  (await import(FAKE_SERVER_MODULE_PATH)) as unknown as FakeServerModule;

describe('OpenAiCompatibleAdapter', () => {
  it('rejects redirects without replaying the audited request to the redirected origin', async () => {
    const { startFakeOpenAiServer } = await loadFakeServer();
    const messages = [{ role: 'user', content: 'Keep this prompt on the audited origin.' }] as const;
    const target = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'POST',
            path: '/redirected',
            headers: {
              authorization: 'Bearer redirect-test-key',
              'content-type': 'application/json',
            },
            jsonBody: {
              model: 'redirect-test-model',
              stream: true,
              messages,
              tools: [],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [
              encoder.encode(
                event({
                  id: 'response-redirected',
                  choices: [{ index: 0, delta: { content: 'Redirected' } }],
                }) +
                  event({
                    id: 'response-redirected',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  }) +
                  'data: [DONE]\n\n',
              ),
            ],
          },
        },
      ],
    });
    const origin = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: 'Bearer redirect-test-key',
              'content-type': 'application/json',
            },
            jsonBody: {
              model: 'redirect-test-model',
              stream: true,
              messages,
              tools: [],
            },
          },
          response: {
            status: 307,
            headers: {
              location: new URL('/redirected', target.baseUrl).toString(),
            },
            chunks: [],
          },
        },
      ],
    });
    const adapter = new OpenAiCompatibleAdapter({ timeoutMs: 5_000 });
    let redirectedOriginReceivedRequest = false;
    void target.completed.then(
      () => {
        redirectedOriginReceivedRequest = true;
      },
      () => {
        redirectedOriginReceivedRequest = true;
      },
    );

    try {
      await expect(
        adapter.call({
          endpoint: new URL('/v1/chat/completions', origin.baseUrl).toString(),
          modelId: 'redirect-test-model',
          apiKey: 'redirect-test-key',
          messages,
          tools: [],
        }),
      ).rejects.toBeInstanceOf(Error);
      await origin.completed;
      await Promise.resolve();
      expect(redirectedOriginReceivedRequest).toBe(false);
    } finally {
      await origin.close();
      await target.close();
    }
  });

  it('uses the endpoint, model, and credential supplied for the audited call', async () => {
    const { startFakeOpenAiServer } = await loadFakeServer();
    const messages = [{ role: 'user', content: 'Say complete.' }] as const;
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: 'Bearer audited-call-key',
              'content-type': 'application/json',
            },
            jsonBody: {
              model: 'audited-call-model',
              stream: true,
              messages,
              tools: [],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [
              encoder.encode(
                event({
                  id: 'response-audited-call',
                  choices: [{ index: 0, delta: { content: 'Complete' } }],
                }) +
                  event({
                    id: 'response-audited-call',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  }) +
                  'data: [DONE]\n\n',
              ),
            ],
          },
        },
      ],
    });
    const adapter = new OpenAiCompatibleAdapter({ timeoutMs: 5_000 });

    try {
      await expect(
        adapter.call({
          endpoint: new URL('/v1/chat/completions', server.baseUrl).toString(),
          modelId: 'audited-call-model',
          apiKey: 'audited-call-key',
          messages,
          tools: [],
        }),
      ).resolves.toMatchObject({
        finishReason: 'stop',
        content: 'Complete',
        providerRequestId: 'response-audited-call',
      });
      await server.completed;
    } finally {
      await server.close();
    }
  });

  it('rejects a terminal finish event sent after DONE', async () => {
    const { startFakeOpenAiServer } = await loadFakeServer();
    const messages = [{ role: 'user', content: 'Say complete.' }] as const;
    const tools = [
      {
        toolId: 'fs.read_text',
        type: 'function',
        function: {
          name: 'fs.read_text',
          parameters: { type: 'object' },
        },
      },
    ] as const;
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: 'Bearer adapter-test-key',
              'content-type': 'application/json',
            },
            jsonBody: {
              model: 'adapter-test-model',
              stream: true,
              messages,
              tools: [
                {
                  type: 'function',
                  function: {
                    name: 'fs.read_text',
                    parameters: { type: 'object' },
                  },
                },
              ],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [
              encoder.encode(
                event({
                  id: 'response-adapter-after-done',
                  choices: [{ index: 0, delta: { content: 'Complete' } }],
                }) +
                  'data: [DONE]\n\n' +
                  event({
                    id: 'response-adapter-after-done',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  }),
              ),
            ],
          },
        },
      ],
    });
    const adapter = new OpenAiCompatibleAdapter({ timeoutMs: 5_000 });

    try {
      await expect(
        adapter.call({
          endpoint: new URL('/v1/chat/completions', server.baseUrl).toString(),
          modelId: 'adapter-test-model',
          apiKey: 'adapter-test-key',
          messages,
          tools,
        }),
      ).rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID' });
      await server.completed;
    } finally {
      await server.close();
    }
  });
});
