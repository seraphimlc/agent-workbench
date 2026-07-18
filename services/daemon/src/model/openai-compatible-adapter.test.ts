import type { RunnerModelMessage } from '@agent-workbench/protocol';
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

const toolDefinition = (toolId: string): unknown => ({
  toolId,
  type: 'function',
  function: { name: toolId, parameters: { type: 'object' } },
});

const providerToolDefinition = (name: string): unknown => ({
  type: 'function',
  function: { name, parameters: { type: 'object' } },
});

const toolCallResponse = (
  requestId: string,
  toolCalls: readonly {
    readonly logicalCallId: string;
    readonly providerName: string;
    readonly argumentsJson: string;
  }[],
): Uint8Array =>
  encoder.encode(
    event({
      id: requestId,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: toolCalls.map((toolCall, index) => ({
              index,
              id: toolCall.logicalCallId,
              type: 'function',
              function: {
                name: toolCall.providerName,
                arguments: toolCall.argumentsJson,
              },
            })),
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

const startAdapterServer = async (input: {
  readonly messages: readonly unknown[];
  readonly expectedMessages?: readonly unknown[];
  readonly expectedTools: readonly unknown[];
  readonly response: Uint8Array;
}): Promise<FakeOpenAiServer> => {
  const { startFakeOpenAiServer } = await loadFakeServer();
  return await startFakeOpenAiServer({
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
            messages: input.expectedMessages ?? input.messages,
            tools: input.expectedTools,
          },
        },
        response: {
          headers: { 'content-type': 'text/event-stream' },
          chunks: [input.response],
        },
      },
    ],
  });
};

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

  it('uses the audited request inputs and leaves a text-only response unchanged', async () => {
    const { startFakeOpenAiServer } = await loadFakeServer();
    const messages = [{ role: 'user', content: 'Say complete.' }] as const;
    const tools = [toolDefinition('fs.read_text')] as const;
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
              tools: [providerToolDefinition('fs_read_text')],
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
          tools,
        }),
      ).resolves.toEqual({
        finishReason: 'stop',
        content: 'Complete',
        toolCalls: [],
        providerRequestId: 'response-audited-call',
        usage: null,
      });
      await server.completed;
    } finally {
      await server.close();
    }
  });

  it('uses a provider-safe function name and restores the internal tool id', async () => {
    const messages = [{ role: 'user', content: 'Read README.md.' }] as const;
    const tools = [toolDefinition('fs.read_text')] as const;
    const server = await startAdapterServer({
      messages,
      expectedTools: [providerToolDefinition('fs_read_text')],
      response: toolCallResponse('response-adapter-tool', [
        {
          logicalCallId: 'call-readme',
          providerName: 'fs_read_text',
          argumentsJson: '{"path":"README.md"}',
        },
      ]),
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
      ).resolves.toMatchObject({
        finishReason: 'tool_calls',
        toolCalls: [
          {
            logicalCallId: 'call-readme',
            toolId: 'fs.read_text',
            argumentsJson: '{"path":"README.md"}',
          },
        ],
      });
      await server.completed;
    } finally {
      await server.close();
    }
  });

  it('translates second-cycle Runner tool history to OpenAI wire messages', async () => {
    const messages: readonly RunnerModelMessage[] = [
      { role: 'user', content: 'Read README.md.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            logicalCallId: 'call-readme',
            toolId: 'fs.read_text',
            argumentsJson: '{"path":"README.md"}',
          },
        ],
      },
      { role: 'tool', logicalCallId: 'call-readme', content: '# Agent Workbench' },
    ];
    const tools = [toolDefinition('fs.read_text')] as const;
    const server = await startAdapterServer({
      messages,
      expectedMessages: [
        { role: 'user', content: 'Read README.md.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-readme',
              type: 'function',
              function: {
                name: 'fs_read_text',
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-readme', content: '# Agent Workbench' },
      ],
      expectedTools: [providerToolDefinition('fs_read_text')],
      response: encoder.encode(
        event({
          id: 'response-adapter-second-cycle',
          choices: [{ index: 0, delta: { content: 'README loaded.' } }],
        }) +
          event({
            id: 'response-adapter-second-cycle',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          'data: [DONE]\n\n',
      ),
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
      ).resolves.toMatchObject({
        finishReason: 'stop',
        content: 'README loaded.',
        toolCalls: [],
      });
      await server.completed;
    } finally {
      await server.close();
    }
  });

  it('assigns deterministic aliases when sanitized function names collide', async () => {
    const messages: readonly RunnerModelMessage[] = [
      { role: 'user', content: 'Call every tool.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            logicalCallId: 'history-slash',
            toolId: 'fs/read_text',
            argumentsJson: '{"source":"slash"}',
          },
          {
            logicalCallId: 'history-safe',
            toolId: 'fs_read_text',
            argumentsJson: '{"source":"safe"}',
          },
          {
            logicalCallId: 'history-dot',
            toolId: 'fs.read_text',
            argumentsJson: '{"source":"dot"}',
          },
        ],
      },
      { role: 'tool', logicalCallId: 'history-slash', content: 'slash result' },
      { role: 'tool', logicalCallId: 'history-safe', content: 'safe result' },
      { role: 'tool', logicalCallId: 'history-dot', content: 'dot result' },
    ];
    const tools = [
      toolDefinition('fs/read_text'),
      toolDefinition('fs_read_text'),
      toolDefinition('fs.read_text'),
    ] as const;
    const server = await startAdapterServer({
      messages,
      expectedMessages: [
        { role: 'user', content: 'Call every tool.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'history-slash',
              type: 'function',
              function: { name: 'fs_read_text_3', arguments: '{"source":"slash"}' },
            },
            {
              id: 'history-safe',
              type: 'function',
              function: { name: 'fs_read_text', arguments: '{"source":"safe"}' },
            },
            {
              id: 'history-dot',
              type: 'function',
              function: { name: 'fs_read_text_2', arguments: '{"source":"dot"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'history-slash', content: 'slash result' },
        { role: 'tool', tool_call_id: 'history-safe', content: 'safe result' },
        { role: 'tool', tool_call_id: 'history-dot', content: 'dot result' },
      ],
      expectedTools: [
        providerToolDefinition('fs_read_text_3'),
        providerToolDefinition('fs_read_text'),
        providerToolDefinition('fs_read_text_2'),
      ],
      response: toolCallResponse('response-adapter-collisions', [
        {
          logicalCallId: 'call-slash',
          providerName: 'fs_read_text_3',
          argumentsJson: '{"source":"slash"}',
        },
        {
          logicalCallId: 'call-safe',
          providerName: 'fs_read_text',
          argumentsJson: '{"source":"safe"}',
        },
        {
          logicalCallId: 'call-dot',
          providerName: 'fs_read_text_2',
          argumentsJson: '{"source":"dot"}',
        },
      ]),
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
      ).resolves.toMatchObject({
        toolCalls: [
          { logicalCallId: 'call-slash', toolId: 'fs/read_text' },
          { logicalCallId: 'call-safe', toolId: 'fs_read_text' },
          { logicalCallId: 'call-dot', toolId: 'fs.read_text' },
        ],
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
                    name: 'fs_read_text',
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
