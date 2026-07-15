import { describe, expect, it } from 'vitest';

type NormalizedToolCall = {
  readonly logicalCallId: string;
  readonly toolId: string;
  readonly argumentsJson: string;
};

type DecodedOpenAiResponse = {
  readonly finishReason: 'stop' | 'tool_calls';
  readonly content: string | null;
  readonly toolCalls: readonly NormalizedToolCall[];
  readonly providerRequestId: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens: number;
  } | null;
};

type DecoderModule = {
  decodeOpenAiSseResponse(
    response: Response,
    options: {
      readonly signal?: AbortSignal;
      readonly maxResponseBytes: number;
      readonly maxErrorBodyBytes: number;
    },
  ): Promise<DecodedOpenAiResponse>;
};

type ScriptedChunk =
  | Uint8Array
  | {
      readonly bytes: Uint8Array;
      readonly waitFor?: Promise<void>;
      readonly afterWrite?: () => void;
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
          readonly method: 'POST';
          readonly path: '/v1/chat/completions';
          readonly headers: Readonly<Record<string, string>>;
          readonly jsonBody: unknown;
        };
        readonly response: {
          readonly status?: number;
          readonly headers?: Readonly<Record<string, string>>;
          readonly chunks: readonly ScriptedChunk[];
        };
      },
      ...Array<{
        readonly expectedRequest: {
          readonly method: 'POST';
          readonly path: '/v1/chat/completions';
          readonly headers: Readonly<Record<string, string>>;
          readonly jsonBody: unknown;
        };
        readonly response: {
          readonly status?: number;
          readonly headers?: Readonly<Record<string, string>>;
          readonly chunks: readonly ScriptedChunk[];
        };
      }>,
    ];
  }): Promise<FakeOpenAiServer>;
};

const DECODER_MODULE_PATH = './openai-sse-decoder.js';
const FAKE_SERVER_MODULE_PATH = '../../../../packages/testkit/src/fake-openai-server.js';
const encoder = new TextEncoder();
const defaultOptions = {
  maxResponseBytes: 64 * 1024,
  maxErrorBodyBytes: 32,
};

const loadDecoder = async (): Promise<DecoderModule> =>
  (await import(DECODER_MODULE_PATH)) as unknown as DecoderModule;

const loadFakeServer = async (): Promise<FakeServerModule> =>
  (await import(FAKE_SERVER_MODULE_PATH)) as unknown as FakeServerModule;

const deferred = (): {
  readonly promise: Promise<void>;
  resolve(): void;
} => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
};

const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const doneEvent = 'data: [DONE]\n\n';

const splitBytes = (bytes: Uint8Array, cutOffsets: readonly number[]): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const offset of cutOffsets) {
    chunks.push(bytes.slice(start, offset));
    start = offset;
  }
  chunks.push(bytes.slice(start));
  return chunks.filter((chunk) => chunk.byteLength > 0);
};

const expectDecoderError = async (
  operation: Promise<unknown>,
  code: 'MODEL_STREAM_INTERRUPTED' | 'MODEL_RESPONSE_INVALID' | 'MODEL_PROVIDER_ERROR',
): Promise<Record<string, unknown>> => {
  try {
    const normalized = await operation;
    throw new Error(`Expected ${code}, received normalized success: ${JSON.stringify(normalized)}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
    return error as Record<string, unknown>;
  }
};

const decodeScript = async (
  response: {
    readonly status?: number;
    readonly chunks: readonly ScriptedChunk[];
  },
  options: Partial<Parameters<DecoderModule['decodeOpenAiSseResponse']>[1]> = {},
): Promise<DecodedOpenAiResponse> => {
  const { decodeOpenAiSseResponse } = await loadDecoder();
  const { startFakeOpenAiServer } = await loadFakeServer();
  const server = await startFakeOpenAiServer({
    scripts: [
      {
        expectedRequest: {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          jsonBody: { stream: true },
        },
        response: {
          ...(response.status === undefined ? {} : { status: response.status }),
          headers: { 'content-type': 'text/event-stream' },
          chunks: response.chunks,
        },
      },
    ],
  });

  try {
    const fetchResponse = await fetch(new URL('/v1/chat/completions', server.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const result = await decodeOpenAiSseResponse(fetchResponse, {
      ...defaultOptions,
      ...options,
    });
    await server.completed;
    return result;
  } finally {
    await server.close();
  }
};

describe('decodeOpenAiSseResponse', () => {
  it('decodes UTF-8 text when code points and SSE lines are split across arbitrary TCP chunks', async () => {
    const payload =
      event({ id: 'response-text', choices: [{ index: 0, delta: { content: '你' } }] }) +
      event({ id: 'response-text', choices: [{ index: 0, delta: { content: '🙂' } }] }) +
      event({
        id: 'response-text',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
      }) +
      doneEvent;
    const bytes = encoder.encode(payload);

    await expect(
      decodeScript({
        chunks: splitBytes(bytes, [1, 7, 19, 43, 44, 45, 81, 119, bytes.length - 3]),
      }),
    ).resolves.toEqual({
      finishReason: 'stop',
      content: '你🙂',
      toolCalls: [],
      providerRequestId: 'response-text',
      usage: { inputTokens: 4, outputTokens: 2, cachedTokens: 1 },
    });
  });

  it('reassembles independently split Tool Call ids, names, and arguments in index order', async () => {
    const chunks = [
      event({
        id: 'response-tools',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: 'call-', type: 'function', function: { name: 'fs.', arguments: '{"b"' } },
              ],
            },
          },
        ],
      }),
      event({
        id: 'response-tools',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call-', type: 'function', function: { name: 'fs.', arguments: '{"a"' } },
                { index: 1, id: 'b', function: { name: 'write_text', arguments: ':2}' } },
              ],
            },
          },
        ],
      }),
      event({
        id: 'response-tools',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'read_text', arguments: ':1}' } },
              ],
            },
          },
        ],
      }),
      event({
        id: 'response-tools',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      doneEvent,
    ].map((chunk) => encoder.encode(chunk));

    await expect(decodeScript({ chunks })).resolves.toEqual({
      finishReason: 'tool_calls',
      content: null,
      toolCalls: [
        { logicalCallId: 'call-a', toolId: 'fs.read_text', argumentsJson: '{"a":1}' },
        { logicalCallId: 'call-b', toolId: 'fs.write_text', argumentsJson: '{"b":2}' },
      ],
      providerRequestId: 'response-tools',
      usage: null,
    });
  });

  it('bounds a non-2xx Provider response body', async () => {
    const body = 'provider failure '.repeat(16);
    const error = await expectDecoderError(
      decodeScript(
        { status: 503, chunks: [encoder.encode(body)] },
        { maxErrorBodyBytes: 24 },
      ),
      'MODEL_PROVIDER_ERROR',
    );

    expect(error).toMatchObject({
      status: 503,
      responseBody: body.slice(0, 24),
      responseBodyTruncated: true,
    });
  });

  it.each([
    {
      name: 'malformed event JSON',
      chunks: [encoder.encode('data: {not-json}\n\n')],
    },
    {
      name: 'conflicting duplicate Tool Call index',
      chunks: [
        encoder.encode(
          event({
            id: 'response-conflict',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call-a', type: 'function', function: { name: 'fs.read_text', arguments: '{}' } },
                    { index: 0, id: 'call-b', type: 'function', function: { name: 'fs.write_text', arguments: '{}' } },
                  ],
                },
              },
            ],
          }) + doneEvent,
        ),
      ],
    },
  ])('rejects $name as MODEL_RESPONSE_INVALID', async ({ chunks }) => {
    await expectDecoderError(decodeScript({ chunks }), 'MODEL_RESPONSE_INVALID');
  });

  it.each([
    {
      name: 'terminal finish after DONE',
      payload:
        event({
          id: 'response-finish-after-done',
          choices: [{ index: 0, delta: { content: 'Complete' } }],
        }) +
        doneEvent +
        event({
          id: 'response-finish-after-done',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
    },
    {
      name: 'content data after DONE',
      payload:
        event({
          id: 'response-content-after-done',
          choices: [{ index: 0, delta: { content: 'Complete' } }],
        }) +
        event({
          id: 'response-content-after-done',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }) +
        doneEvent +
        event({
          id: 'response-content-after-done',
          choices: [{ index: 0, delta: { content: ' late' } }],
        }),
    },
  ])('rejects $name as MODEL_RESPONSE_INVALID', async ({ payload }) => {
    await expectDecoderError(
      decodeScript({ chunks: [encoder.encode(payload)] }),
      'MODEL_RESPONSE_INVALID',
    );
  });

  it.each([
    {
      name: 'duplicate choice indexes in one event',
      payload:
        event({
          id: 'response-duplicate-choices',
          choices: [
            { index: 0, delta: { content: 'Complete' } },
            { index: 0, delta: { content: ' duplicate' } },
          ],
        }) +
        event({
          id: 'response-duplicate-choices',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }) +
        doneEvent,
    },
    {
      name: 'semantic delta in a terminal finish choice',
      payload:
        event({
          id: 'response-terminal-delta',
          choices: [
            {
              index: 0,
              delta: { content: 'must not append' },
              finish_reason: 'stop',
            },
          ],
        }) + doneEvent,
    },
    {
      name: 'duplicate terminal choice appending a semantic delta',
      payload:
        event({
          id: 'response-terminal-duplicate',
          choices: [
            { index: 0, delta: {}, finish_reason: 'stop' },
            { index: 0, delta: { content: 'must not append' } },
          ],
        }) + doneEvent,
    },
  ])('rejects $name as MODEL_RESPONSE_INVALID', async ({ payload }) => {
    await expectDecoderError(
      decodeScript({ chunks: [encoder.encode(payload)] }),
      'MODEL_RESPONSE_INVALID',
    );
  });

  it.each([
    {
      name: 'data after terminal finish',
      payload:
        event({
          id: 'response-data-after-finish',
          choices: [{ index: 0, delta: { content: 'Complete' } }],
        }) +
        event({
          id: 'response-data-after-finish',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }) +
        event({
          id: 'response-data-after-finish',
          choices: [{ index: 0, delta: { content: ' late' } }],
        }) +
        doneEvent,
    },
    {
      name: 'incomplete trailing data after DONE',
      payload:
        event({
          id: 'response-trailing-after-done',
          choices: [{ index: 0, delta: { content: 'Complete' } }],
        }) +
        event({
          id: 'response-trailing-after-done',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }) +
        doneEvent +
        'data: {"id":"response-trailing-after-done"',
    },
  ])('rejects $name as MODEL_RESPONSE_INVALID', async ({ payload }) => {
    await expectDecoderError(
      decodeScript({ chunks: [encoder.encode(payload)] }),
      'MODEL_RESPONSE_INVALID',
    );
  });

  it('rejects invalid UTF-8 instead of replacing bytes', async () => {
    const prefix = encoder.encode(
      'data: {"id":"response-invalid-utf8","choices":[{"index":0,"delta":{"content":"',
    );
    const suffix = encoder.encode('"}}]}\n\ndata: [DONE]\n\n');
    const bytes = new Uint8Array(prefix.byteLength + 2 + suffix.byteLength);
    bytes.set(prefix, 0);
    bytes.set([0xc3, 0x28], prefix.byteLength);
    bytes.set(suffix, prefix.byteLength + 2);

    await expectDecoderError(decodeScript({ chunks: [bytes] }), 'MODEL_RESPONSE_INVALID');
  });

  it('rejects a response that exceeds the configured byte limit', async () => {
    const chunks = [
      encoder.encode(
        event({
          id: 'response-overflow',
          choices: [{ index: 0, delta: { content: 'x'.repeat(128) } }],
        }),
      ),
    ];

    await expectDecoderError(
      decodeScript({ chunks }, { maxResponseBytes: 32 }),
      'MODEL_RESPONSE_INVALID',
    );
  });

  it.each([
    {
      name: 'complete-looking Tool arguments followed by EOF',
      chunks: [
        encoder.encode(
          event({
            id: 'response-eof-tool',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-file',
                      type: 'function',
                      function: { name: 'fs.read_text', arguments: '{"path":"notes.md"}' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      ],
    },
    {
      name: 'terminal finish without DONE',
      chunks: [
        encoder.encode(
          event({
            id: 'response-terminal-only',
            choices: [{ index: 0, delta: { content: 'Complete' } }],
          }) +
            event({
              id: 'response-terminal-only',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }),
        ),
      ],
    },
    {
      name: 'DONE without terminal finish',
      chunks: [
        encoder.encode(
          event({
            id: 'response-done-only',
            choices: [{ index: 0, delta: { content: 'Incomplete' } }],
          }) + doneEvent,
        ),
      ],
    },
  ])('rejects $name as MODEL_STREAM_INTERRUPTED', async ({ chunks }) => {
    await expectDecoderError(decodeScript({ chunks }), 'MODEL_STREAM_INTERRUPTED');
  });

  it('returns MODEL_STREAM_INTERRUPTED when AbortSignal cancels an in-flight stream', async () => {
    const { decodeOpenAiSseResponse } = await loadDecoder();
    const { startFakeOpenAiServer } = await loadFakeServer();
    const firstWritten = deferred();
    const releaseTail = deferred();
    const controller = new AbortController();
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { 'content-type': 'application/json' },
            jsonBody: { stream: true },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [
              {
                bytes: encoder.encode(
                  event({
                    id: 'response-abort',
                    choices: [{ index: 0, delta: { content: 'partial' } }],
                  }),
                ),
                afterWrite: firstWritten.resolve,
              },
              { bytes: encoder.encode(doneEvent), waitFor: releaseTail.promise },
            ],
          },
        },
      ],
    });

    try {
      const response = await fetch(new URL('/v1/chat/completions', server.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true }),
        signal: controller.signal,
      });
      const decoding = decodeOpenAiSseResponse(response, {
        ...defaultOptions,
        signal: controller.signal,
      });
      await firstWritten.promise;
      controller.abort();
      releaseTail.resolve();

      await expectDecoderError(decoding, 'MODEL_STREAM_INTERRUPTED');
    } finally {
      releaseTail.resolve();
      await server.close();
    }
  });
});
