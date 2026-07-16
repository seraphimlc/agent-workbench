import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Socket } from 'node:net';

export type ScriptedChunk =
  | Uint8Array
  | {
      readonly bytes: Uint8Array;
      readonly waitFor?: Promise<void>;
      readonly afterWrite?: () => void;
    };

export type FakeOpenAiScript = {
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
};

export type FakeOpenAiServer = {
  readonly baseUrl: string;
  readonly completed: Promise<void>;
  close(): Promise<void>;
};

const readBody = async (request: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
};

const normalizedHeader = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
};

const stableJson = (value: unknown): string => JSON.stringify(value);

export const startFakeOpenAiServer = async (input: {
  readonly scripts: readonly [FakeOpenAiScript, ...FakeOpenAiScript[]];
}): Promise<FakeOpenAiServer> => {
  const scripts = [...input.scripts];
  const sockets = new Set<Socket>();
  let activeRequests = 0;
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: unknown) => void;
  let completionSettled = false;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => undefined);

  const settleCompleted = (): void => {
    if (!completionSettled && scripts.length === 0 && activeRequests === 0) {
      completionSettled = true;
      resolveCompleted();
    }
  };
  const fail = (error: unknown): void => {
    if (!completionSettled) {
      completionSettled = true;
      rejectCompleted(error);
    }
  };

  const server: Server = createServer(async (request, response) => {
    const script = scripts.shift();
    if (!script) {
      const error = new Error('Fake OpenAI Server received an unexpected request');
      fail(error);
      response.writeHead(500).end(error.message);
      return;
    }
    activeRequests += 1;

    try {
      const body = await readBody(request);
      if (request.method !== script.expectedRequest.method) {
        throw new Error(`Expected ${script.expectedRequest.method}, received ${String(request.method)}`);
      }
      if (request.url !== script.expectedRequest.path) {
        throw new Error(`Expected ${script.expectedRequest.path}, received ${String(request.url)}`);
      }
      for (const [name, expected] of Object.entries(script.expectedRequest.headers)) {
        const actual = normalizedHeader(request.headers, name);
        if (actual !== expected) {
          throw new Error(`Expected request header ${name}=${expected}, received ${String(actual)}`);
        }
      }
      if (Object.hasOwn(script.expectedRequest, 'jsonBody')) {
        let jsonBody: unknown;
        try {
          jsonBody = JSON.parse(body.toString('utf8')) as unknown;
        } catch {
          throw new Error('Fake OpenAI Server request body is not valid JSON');
        }
        if (stableJson(jsonBody) !== stableJson(script.expectedRequest.jsonBody)) {
          throw new Error(
            `Unexpected request JSON: ${stableJson(jsonBody)} expected ${stableJson(script.expectedRequest.jsonBody)}`,
          );
        }
      } else if (body.byteLength !== 0) {
        throw new Error('Fake OpenAI Server request body was not expected');
      }

      response.writeHead(script.response.status ?? 200, script.response.headers ?? {});
      for (const chunk of script.response.chunks) {
        const scripted = chunk instanceof Uint8Array ? { bytes: chunk } : chunk;
        await scripted.waitFor;
        if (!response.destroyed) {
          response.write(scripted.bytes);
          scripted.afterWrite?.();
        }
      }
      response.end();
    } catch (error) {
      fail(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : 'Fake OpenAI Server failed');
    } finally {
      activeRequests -= 1;
      settleCompleted();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('error', fail);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Fake OpenAI Server did not bind a TCP port');
  }

  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    completed,
    close: async () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        for (const socket of sockets) {
          socket.destroy();
        }
      });
      await closePromise;
    },
  };
};
