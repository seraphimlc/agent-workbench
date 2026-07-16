import { describe, expect, it } from 'vitest';

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

type FakeOpenAiServerModule = {
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
          readonly chunks: readonly ScriptedChunk[];
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
          readonly chunks: readonly ScriptedChunk[];
        };
      }>,
    ];
  }): Promise<FakeOpenAiServer>;
};

const MODULE_PATH = './fake-openai-server.js';
const encoder = new TextEncoder();

const loadFakeServer = async (): Promise<FakeOpenAiServerModule> =>
  (await import(MODULE_PATH)) as unknown as FakeOpenAiServerModule;

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

describe('Fake OpenAI Server', () => {
  it('supports a bodyless GET models script without changing POST request matching', async () => {
    const { startFakeOpenAiServer } = await loadFakeServer();
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'GET',
            path: '/v1/models',
            headers: { authorization: 'Bearer test-key' },
          },
          response: {
            headers: { 'content-type': 'application/json' },
            chunks: [encoder.encode('{"data":[{"id":"chat-model"}]}')],
          },
        },
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { 'content-type': 'application/json' },
            jsonBody: { model: 'chat-model' },
          },
          response: { chunks: [encoder.encode('complete')] },
        },
      ],
    });
    let completed = false;
    void server.completed.then(() => {
      completed = true;
    });

    try {
      const modelsResponse = await fetch(new URL('/v1/models', server.baseUrl), {
        headers: { authorization: 'Bearer test-key' },
      });
      expect(await modelsResponse.json()).toEqual({ data: [{ id: 'chat-model' }] });
      await Promise.resolve();
      expect(completed).toBe(false);

      const chatResponse = await fetch(new URL('/v1/chat/completions', server.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat-model' }),
      });
      expect(await chatResponse.text()).toBe('complete');
      await server.completed;
      expect(completed).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('serves scripted chunks over real loopback HTTP and validates the native fetch request', async () => {
    const { startFakeOpenAiServer } = await loadFakeServer();
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: 'Bearer test-key',
              'content-type': 'application/json',
            },
            jsonBody: {
              model: 'test-model',
              stream: true,
              messages: [{ role: 'user', content: 'Hello' }],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [encoder.encode('data: first\n\n'), encoder.encode('data: second\n\n')],
          },
        },
      ],
    });

    try {
      const endpoint = new URL('/v1/chat/completions', server.baseUrl);
      expect(endpoint.protocol).toBe('http:');
      expect(endpoint.hostname).toBe('127.0.0.1');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'test-model',
          stream: true,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('data: first\n\ndata: second\n\n');
      await server.completed;
    } finally {
      await server.close();
    }
  });

  it('gates later chunks on an explicit condition instead of timing sleeps', async () => {
    const { startFakeOpenAiServer } = await loadFakeServer();
    const firstWritten = deferred();
    const releaseSecond = deferred();
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
            chunks: [
              { bytes: encoder.encode('first'), afterWrite: firstWritten.resolve },
              { bytes: encoder.encode('second'), waitFor: releaseSecond.promise },
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
      });
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Expected a streaming response body');
      }

      await firstWritten.promise;
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
      releaseSecond.resolve();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('second');
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      await server.completed;
    } finally {
      releaseSecond.resolve();
      await server.close();
    }
  });

  it('resolves completed only after the script queue and all active requests are drained', async () => {
    const { startFakeOpenAiServer } = await loadFakeServer();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { 'content-type': 'application/json' },
            jsonBody: { request: 1 },
          },
          response: {
            chunks: [
              { bytes: encoder.encode('first-start'), afterWrite: firstStarted.resolve },
              { bytes: encoder.encode('first-end'), waitFor: releaseFirst.promise },
            ],
          },
        },
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { 'content-type': 'application/json' },
            jsonBody: { request: 2 },
          },
          response: {
            chunks: [
              { bytes: encoder.encode('second-start'), afterWrite: secondStarted.resolve },
              { bytes: encoder.encode('second-end'), waitFor: releaseSecond.promise },
            ],
          },
        },
      ],
    });
    let completed = false;
    void server.completed.then(() => {
      completed = true;
    });

    try {
      const firstResponsePromise = fetch(new URL('/v1/chat/completions', server.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: 1 }),
      });
      await firstStarted.promise;
      const secondResponsePromise = fetch(new URL('/v1/chat/completions', server.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: 2 }),
      });
      await secondStarted.promise;

      releaseSecond.resolve();
      expect(await (await secondResponsePromise).text()).toBe('second-startsecond-end');
      await Promise.resolve();
      expect(completed).toBe(false);

      releaseFirst.resolve();
      expect(await (await firstResponsePromise).text()).toBe('first-startfirst-end');
      await server.completed;
      expect(completed).toBe(true);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await server.close();
    }
  });

  it('rejects close when an unexpected request arrives after completion', async () => {
    const { startFakeOpenAiServer } = await loadFakeServer();
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'GET',
            path: '/expected',
            headers: {},
          },
          response: { chunks: [encoder.encode('expected')] },
        },
      ],
    });

    try {
      expect(await (await fetch(new URL('/expected', server.baseUrl))).text()).toBe(
        'expected',
      );
      await server.completed;

      const unexpected = await fetch(new URL('/late-unexpected', server.baseUrl));
      expect(unexpected.status).toBe(500);
      expect(await unexpected.text()).toContain('unexpected request');
      await expect(server.close()).rejects.toThrow(
        'Fake OpenAI Server received an unexpected request',
      );
    } finally {
      await server.close().catch(() => undefined);
    }
  });
});
