import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

type RpcRequest = {
  readonly requestId: string;
  readonly method: string;
  readonly payload: unknown;
  readonly sessionId?: string;
  readonly clientRequestId?: string;
};

type ServerModule = {
  startWebConsoleServer(options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly signalSource?: Pick<EventEmitter, 'once' | 'off'>;
    readonly dependencies: {
      parseProviderConfig(
        environment: Readonly<Record<string, string | undefined>>,
      ): {
        readonly privateConfig: {
          readonly baseUrl: string;
          readonly apiKey: string;
          readonly modelId: string | null;
        };
        readonly publicConfig: {
          readonly baseHost: string;
          readonly modelId: string | null;
        };
      };
      probeProviderModel(config: {
        readonly baseUrl: string;
        readonly apiKey: string;
        readonly modelId: string | null;
      }, options: { readonly signal: AbortSignal }): Promise<string>;
      createDaemonManager(): {
        start(options: unknown): Promise<{
          readonly pid: number;
          readonly socketPath: string;
          readonly bootstrapSecret: Buffer;
          readonly failure: Promise<Error>;
          stop(): Promise<void>;
        }>;
      };
      connectDaemonRpcClient(socketPath: string): Promise<{
        authenticate(secret: Uint8Array): Promise<void>;
        createRequest(
          method: string,
          payload: unknown,
          options?: {
            readonly sessionId?: string;
            readonly clientRequestId?: string;
          },
        ): RpcRequest;
        send(request: RpcRequest): Promise<unknown>;
        close(): Promise<void>;
      }>;
      createViteServer(cspNoncePlaceholder: string): Promise<{
        middlewares(
          request: IncomingMessage,
          response: ServerResponse,
          next: (error?: unknown) => void,
        ): void;
        transformIndexHtml(url: string, html: string): Promise<string>;
        close(): Promise<void>;
      }>;
      loadIndexHtml(): Promise<string>;
      createCsrfToken(): string;
      createCspNonce?(): string;
      sleep?(milliseconds: number): Promise<void>;
      writeReady(line: string): void;
    };
  }): Promise<{
    readonly url: string;
    stop(): Promise<void>;
  }>;
  attachShutdownSignals(
    server: { stop(): Promise<void> },
    signalSource: Pick<EventEmitter, 'once' | 'off'>,
    onError?: (error: unknown) => void,
  ): () => void;
};

const loadServer = async (): Promise<ServerModule> =>
  (await import('./index.js')) as unknown as ServerModule;

const environment = {
  AGENT_WORKBENCH_PROVIDER_BASE_URL: 'https://api.example.test/v1',
  AGENT_WORKBENCH_PROVIDER_API_KEY: 'provider-secret',
};

const pendingFailure = (): Promise<Error> => new Promise(() => undefined);

const deferred = <Value>() => {
  let resolvePromise!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const within = async <Value>(
  operation: Promise<Value>,
  milliseconds = 100,
): Promise<Value> =>
  await Promise.race([
    operation,
    new Promise<never>((_resolve, rejectPromise) => {
      setTimeout(
        () => rejectPromise(new Error('operation did not settle in time')),
        milliseconds,
      );
    }),
  ]);

describe('web console server', () => {
  it('starts in order, serves per-response HTML nonces, prints one ready URL, and stops once', async () => {
    const { startWebConsoleServer } = await loadServer();
    const lifecycle: string[] = [];
    const readyLines: string[] = [];
    const bootstrapSecret = Buffer.alloc(32, 7);
    let requestSequence = 0;
    let serverUrl = '';
    let viteCspNoncePlaceholder = '';
    const responseCspNonces = [
      'response-nonce-1',
      'response-nonce-2',
      'response-nonce-3',
      'response-nonce-4',
    ];
    let nextResponseCspNonce = 0;
    const server = await startWebConsoleServer({
      cwd: process.cwd(),
      environment,
      dependencies: {
        parseProviderConfig: (input) => {
          lifecycle.push('parse');
          expect(input).toBe(environment);
          return {
            privateConfig: {
              baseUrl: 'https://api.example.test/v1',
              apiKey: 'provider-secret',
              modelId: null,
            },
            publicConfig: { baseHost: 'api.example.test', modelId: null },
          };
        },
        probeProviderModel: async (config) => {
          lifecycle.push('probe');
          expect(config.apiKey).toBe('provider-secret');
          return 'chat-model';
        },
        createDaemonManager: () => ({
          start: async (options) => {
            lifecycle.push('launch');
            expect(options).toMatchObject({
              workspacePath: process.cwd(),
              provider: {
                baseUrl: 'https://api.example.test/v1',
                apiKey: 'provider-secret',
                modelId: 'chat-model',
              },
            });
            return {
              pid: 4321,
              socketPath: '/tmp/daemon.sock',
              bootstrapSecret,
              failure: pendingFailure(),
              stop: async () => {
                lifecycle.push('daemon.close');
              },
            };
          },
        }),
        connectDaemonRpcClient: async (socketPath) => {
          lifecycle.push('connect');
          expect(socketPath).toBe('/tmp/daemon.sock');
          return {
            authenticate: async (secret) => {
              lifecycle.push('auth');
              expect(Buffer.from(secret)).toEqual(Buffer.alloc(32, 7));
            },
            createRequest: (method, payload, options = {}) => ({
              requestId: `request-${++requestSequence}`,
              method,
              payload,
              ...options,
            }),
            send: async (request) => ({
              kind: 'response',
              protocolVersion: 1,
              requestId: request.requestId,
              traceId: 'trace-1',
              ok: true,
              result: { status: 'ready', protocolVersion: 1, pid: 4321 },
            }),
            close: async () => {
              lifecycle.push('rpc.close');
              await expect(fetch(serverUrl)).rejects.toThrow();
            },
          };
        },
        createViteServer: async (cspNoncePlaceholder) => {
          lifecycle.push('vite');
          viteCspNoncePlaceholder = cspNoncePlaceholder ?? '';
          return {
            middlewares: (request, response, next) => {
              if (request.url === '/asset.js') {
                response.setHeader('content-type', 'text/javascript');
                response.end('export const ready = true;');
                return;
              }
              next();
            },
            transformIndexHtml: async (_url, html) =>
              html.replace(
                '<title>',
                `<meta property="csp-nonce" nonce="${viteCspNoncePlaceholder}"><style nonce="${viteCspNoncePlaceholder}">body{display:grid}</style><meta name="vite-test" content="ok"><title>`,
              ),
            close: async () => {
              lifecycle.push('vite.close');
            },
          };
        },
        loadIndexHtml: async () =>
          '<!doctype html><html><head><title>Agent Workbench</title></head><body></body></html>',
        createCsrfToken: () => 'csrf-token',
        createCspNonce: () => {
          const cspNonce = responseCspNonces[nextResponseCspNonce];
          nextResponseCspNonce += 1;
          if (cspNonce === undefined) throw new Error('Unexpected HTML response');
          return cspNonce;
        },
        writeReady: (line) => {
          lifecycle.push('ready');
          readyLines.push(line);
        },
      },
    });
    serverUrl = server.url;

    expect(lifecycle.slice(0, 7)).toEqual([
      'parse',
      'probe',
      'launch',
      'connect',
      'auth',
      'vite',
      'ready',
    ]);
    expect(bootstrapSecret).toEqual(Buffer.alloc(32));
    expect(readyLines).toHaveLength(1);
    expect(JSON.parse(readyLines[0] ?? '')).toEqual({
      event: 'ready',
      url: server.url,
    });

    const runtime = await fetch(`${server.url}api/runtime`);
    expect(runtime.status).toBe(200);
    expect(await runtime.json()).toEqual({
      daemon: { status: 'ready', protocolVersion: 1, pid: 4321 },
      provider: { baseHost: 'api.example.test', modelId: 'chat-model' },
      workspace: { name: expect.any(String) },
    });

    expect(viteCspNoncePlaceholder).toBe(
      'agent-workbench-csp-nonce-placeholder',
    );
    const readHtmlCspNonce = async (): Promise<string> => {
      const html = await fetch(server.url);
      const htmlBody = await html.text();
      expect(html.status).toBe(200);
      expect(html.headers.get('cache-control')).toBe('no-store');
      const contentSecurityPolicy =
        html.headers.get('content-security-policy') ?? '';
      const cspNonce = /style-src 'self' 'nonce-([^']+)'/.exec(
        contentSecurityPolicy,
      )?.[1];
      expect(cspNonce).toBeDefined();
      expect(contentSecurityPolicy).toBe(
        `default-src 'self'; connect-src 'self'; style-src 'self' 'nonce-${cspNonce}'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`,
      );
      expect(
        [...htmlBody.matchAll(/\snonce="([^"]+)"/g)].map(
          (match) => match[1],
        ),
      ).toEqual([cspNonce, cspNonce]);
      expect(htmlBody).not.toContain(viteCspNoncePlaceholder);
      expect(htmlBody).toContain(
        '<meta name="agent-workbench-csrf" content="csrf-token">',
      );
      expect(htmlBody).toContain('<meta name="vite-test" content="ok">');
      return cspNonce ?? '';
    };

    const repeatedCspNonces = [
      await readHtmlCspNonce(),
      await readHtmlCspNonce(),
    ];
    const concurrentCspNonces = await Promise.all([
      readHtmlCspNonce(),
      readHtmlCspNonce(),
    ]);
    expect(repeatedCspNonces).toEqual(responseCspNonces.slice(0, 2));
    expect(new Set(concurrentCspNonces)).toEqual(
      new Set(responseCspNonces.slice(2)),
    );
    expect(
      new Set([...repeatedCspNonces, ...concurrentCspNonces]),
    ).toHaveProperty('size', 4);

    const asset = await fetch(`${server.url}asset.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('no-store');
    expect(await asset.text()).toBe('export const ready = true;');

    await server.stop();
    await server.stop();

    expect(lifecycle.slice(-3)).toEqual([
      'rpc.close',
      'daemon.close',
      'vite.close',
    ]);
    expect(lifecycle.filter((entry) => entry === 'rpc.close')).toHaveLength(1);
    expect(lifecycle.filter((entry) => entry === 'daemon.close')).toHaveLength(1);
    expect(lifecycle.filter((entry) => entry === 'vite.close')).toHaveLength(1);
  });

  it('cleans every created resource and emits no URL when startup fails', async () => {
    const { startWebConsoleServer } = await loadServer();
    const lifecycle: string[] = [];
    const readyLines: string[] = [];
    const bootstrapSecret = Buffer.alloc(32, 9);

    await expect(
      startWebConsoleServer({
        cwd: process.cwd(),
        environment,
        dependencies: {
          parseProviderConfig: () => ({
            privateConfig: {
              baseUrl: 'https://api.example.test/v1',
              apiKey: 'provider-secret',
              modelId: 'configured-model',
            },
            publicConfig: {
              baseHost: 'api.example.test',
              modelId: 'configured-model',
            },
          }),
          probeProviderModel: async () => 'configured-model',
          createDaemonManager: () => ({
            start: async () => ({
              pid: 4321,
              socketPath: '/tmp/daemon.sock',
              bootstrapSecret,
              failure: pendingFailure(),
              stop: async () => {
                lifecycle.push('daemon.close');
              },
            }),
          }),
          connectDaemonRpcClient: async () => ({
            authenticate: async () => undefined,
            createRequest: (method, payload) => ({
              requestId: 'request-1',
              method,
              payload,
            }),
            send: async () => {
              throw new Error('unused');
            },
            close: async () => {
              lifecycle.push('rpc.close');
            },
          }),
          createViteServer: async () => ({
            middlewares: (_request, _response, next) => next(),
            transformIndexHtml: async (_url, html) => html,
            close: async () => {
              lifecycle.push('vite.close');
            },
          }),
          loadIndexHtml: async () => {
            throw new Error('index load failed');
          },
          createCsrfToken: () => 'csrf-token',
          writeReady: (line) => readyLines.push(line),
        },
      }),
    ).rejects.toThrow('index load failed');

    expect(bootstrapSecret).toEqual(Buffer.alloc(32));
    expect(readyLines).toEqual([]);
    expect(lifecycle).toEqual(['rpc.close', 'daemon.close', 'vite.close']);
  });

  it('aborts a never-resolving probe without waiting for startup settlement', async () => {
    const { startWebConsoleServer } = await loadServer();
    const signals = new EventEmitter();
    const receivedSignal = deferred<AbortSignal>();
    const readyLines: string[] = [];
    const startup = startWebConsoleServer({
      cwd: process.cwd(),
      environment,
      signalSource: signals,
      dependencies: {
        parseProviderConfig: () => ({
          privateConfig: {
            baseUrl: 'https://api.example.test/v1',
            apiKey: 'provider-secret',
            modelId: 'chat-model',
          },
          publicConfig: {
            baseHost: 'api.example.test',
            modelId: 'chat-model',
          },
        }),
        probeProviderModel: async (_config, options) => {
          receivedSignal.resolve(options.signal);
          return await new Promise<never>(() => undefined);
        },
        createDaemonManager: () => ({
          start: async () => {
            throw new Error('daemon must not start');
          },
        }),
        connectDaemonRpcClient: async () => {
          throw new Error('RPC must not connect');
        },
        createViteServer: async () => {
          throw new Error('Vite must not start');
        },
        loadIndexHtml: async () => {
          throw new Error('HTML must not load');
        },
        createCsrfToken: () => 'csrf-token',
        writeReady: (line) => readyLines.push(line),
      },
    });

    const signal = await receivedSignal.promise;
    signals.emit('SIGINT');

    await expect(within(startup)).rejects.toMatchObject({
      code: 'WEB_CONSOLE_STARTUP_CANCELLED',
    });
    expect(signal.aborted).toBe(true);
    expect(readyLines).toEqual([]);
  });

  it('returns from stop before a late daemon resolves and reaps it on arrival', async () => {
    const { startWebConsoleServer } = await loadServer();
    const signals = new EventEmitter();
    const daemonStarted = deferred<void>();
    const lateDaemon = deferred<{
      readonly pid: number;
      readonly socketPath: string;
      readonly bootstrapSecret: Buffer;
      readonly failure: Promise<Error>;
      stop(): Promise<void>;
    }>();
    const bootstrapSecret = Buffer.alloc(32, 8);
    let daemonStops = 0;
    const readyLines: string[] = [];
    const startup = startWebConsoleServer({
      cwd: process.cwd(),
      environment,
      signalSource: signals,
      dependencies: {
        parseProviderConfig: () => ({
          privateConfig: {
            baseUrl: 'https://api.example.test/v1',
            apiKey: 'provider-secret',
            modelId: 'chat-model',
          },
          publicConfig: {
            baseHost: 'api.example.test',
            modelId: 'chat-model',
          },
        }),
        probeProviderModel: async () => 'chat-model',
        createDaemonManager: () => ({
          start: async () => {
            daemonStarted.resolve();
            return await lateDaemon.promise;
          },
        }),
        connectDaemonRpcClient: async () => {
          throw new Error('RPC must not connect');
        },
        createViteServer: async () => {
          throw new Error('Vite must not start');
        },
        loadIndexHtml: async () => {
          throw new Error('HTML must not load');
        },
        createCsrfToken: () => 'csrf-token',
        writeReady: (line) => readyLines.push(line),
      },
    });

    await daemonStarted.promise;
    signals.emit('SIGTERM');
    await expect(within(startup)).rejects.toMatchObject({
      code: 'WEB_CONSOLE_STARTUP_CANCELLED',
    });
    expect(daemonStops).toBe(0);

    lateDaemon.resolve({
      pid: 4321,
      socketPath: '/tmp/daemon.sock',
      bootstrapSecret,
      failure: pendingFailure(),
      stop: async () => {
        daemonStops += 1;
      },
    });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(daemonStops).toBe(1);
    expect(bootstrapSecret).toEqual(Buffer.alloc(32));
    expect(readyLines).toEqual([]);
  });

  it('returns from stop before a late Vite resolves and closes it on arrival', async () => {
    const { startWebConsoleServer } = await loadServer();
    const signals = new EventEmitter();
    const viteStarted = deferred<void>();
    const lateVite = deferred<{
      middlewares(
        request: IncomingMessage,
        response: ServerResponse,
        next: (error?: unknown) => void,
      ): void;
      transformIndexHtml(url: string, html: string): Promise<string>;
      close(): Promise<void>;
    }>();
    let daemonStops = 0;
    let rpcCloses = 0;
    let viteCloses = 0;
    const readyLines: string[] = [];
    const startup = startWebConsoleServer({
      cwd: process.cwd(),
      environment,
      signalSource: signals,
      dependencies: {
        parseProviderConfig: () => ({
          privateConfig: {
            baseUrl: 'https://api.example.test/v1',
            apiKey: 'provider-secret',
            modelId: 'chat-model',
          },
          publicConfig: {
            baseHost: 'api.example.test',
            modelId: 'chat-model',
          },
        }),
        probeProviderModel: async () => 'chat-model',
        createDaemonManager: () => ({
          start: async () => ({
            pid: 4321,
            socketPath: '/tmp/daemon.sock',
            bootstrapSecret: Buffer.alloc(32, 3),
            failure: pendingFailure(),
            stop: async () => {
              daemonStops += 1;
            },
          }),
        }),
        connectDaemonRpcClient: async () => ({
          authenticate: async () => undefined,
          createRequest: (method, payload) => ({
            requestId: 'request-1',
            method,
            payload,
          }),
          send: async () => {
            throw new Error('unused');
          },
          close: async () => {
            rpcCloses += 1;
          },
        }),
        createViteServer: async () => {
          viteStarted.resolve();
          return await lateVite.promise;
        },
        loadIndexHtml: async () => {
          throw new Error('HTML must not load');
        },
        createCsrfToken: () => 'csrf-token',
        writeReady: (line) => readyLines.push(line),
      },
    });

    await viteStarted.promise;
    signals.emit('SIGINT');
    await expect(within(startup)).rejects.toMatchObject({
      code: 'WEB_CONSOLE_STARTUP_CANCELLED',
    });
    expect(rpcCloses).toBe(1);
    expect(daemonStops).toBe(1);
    expect(viteCloses).toBe(0);

    lateVite.resolve({
      middlewares: (_request, _response, next) => next(),
      transformIndexHtml: async (_url, html) => html,
      close: async () => {
        viteCloses += 1;
      },
    });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(viteCloses).toBe(1);
    expect(readyLines).toEqual([]);
  });

  it('reaps partial resources when signaled before HTTP bind and emits no ready URL', async () => {
    const { startWebConsoleServer } = await loadServer();
    const signals = new EventEmitter();
    const daemonStarted = deferred<void>();
    const releaseConnect = deferred<void>();
    const lifecycle: string[] = [];
    const readyLines: string[] = [];
    const bootstrapSecret = Buffer.alloc(32, 5);
    const startup = startWebConsoleServer({
      cwd: process.cwd(),
      environment,
      signalSource: signals,
      dependencies: {
        parseProviderConfig: () => ({
          privateConfig: {
            baseUrl: 'https://api.example.test/v1',
            apiKey: 'provider-secret',
            modelId: 'chat-model',
          },
          publicConfig: {
            baseHost: 'api.example.test',
            modelId: 'chat-model',
          },
        }),
        probeProviderModel: async () => 'chat-model',
        createDaemonManager: () => ({
          start: async () => {
            lifecycle.push('daemon.start');
            daemonStarted.resolve();
            return {
              pid: 4321,
              socketPath: '/tmp/daemon.sock',
              bootstrapSecret,
              failure: pendingFailure(),
              stop: async () => {
                lifecycle.push('daemon.close');
              },
            };
          },
        }),
        connectDaemonRpcClient: async () => {
          lifecycle.push('connect');
          await releaseConnect.promise;
          return {
            authenticate: async () => undefined,
            createRequest: (method, payload) => ({
              requestId: 'request-1',
              method,
              payload,
            }),
            send: async () => {
              throw new Error('unused');
            },
            close: async () => {
              lifecycle.push('rpc.close');
            },
          };
        },
        createViteServer: async () => {
          lifecycle.push('vite.unexpected');
          throw new Error('Vite must not start after shutdown');
        },
        loadIndexHtml: async () => {
          throw new Error('HTML must not load after shutdown');
        },
        createCsrfToken: () => 'csrf-token',
        writeReady: (line) => readyLines.push(line),
      },
    });

    await daemonStarted.promise;
    signals.emit('SIGTERM');
    releaseConnect.resolve();

    await expect(startup).rejects.toMatchObject({
      code: 'WEB_CONSOLE_STARTUP_CANCELLED',
    });
    expect(bootstrapSecret).toEqual(Buffer.alloc(32));
    expect(readyLines).toEqual([]);
    expect(lifecycle).toEqual(['daemon.start', 'daemon.close']);
  });

  it('limits reconnect attempts, reauthenticates candidates, and degrades runtime safely', async () => {
    const { startWebConsoleServer } = await loadServer();
    const bootstrapSecret = Buffer.alloc(32, 6);
    const readyLines: string[] = [];
    const sleepCalls: number[] = [];
    let connections = 0;
    let authentications = 0;
    const createRequest = (method: string, payload: unknown) => ({
      requestId: `request-${method}`,
      method,
      payload,
    });
    const server = await startWebConsoleServer({
      cwd: process.cwd(),
      environment,
      dependencies: {
        parseProviderConfig: () => ({
          privateConfig: {
            baseUrl: 'https://api.example.test/v1',
            apiKey: 'provider-secret',
            modelId: 'chat-model',
          },
          publicConfig: {
            baseHost: 'api.example.test',
            modelId: 'chat-model',
          },
        }),
        probeProviderModel: async () => 'chat-model',
        createDaemonManager: () => ({
          start: async () => ({
            pid: 4321,
            socketPath: '/tmp/daemon.sock',
            bootstrapSecret,
            failure: pendingFailure(),
            stop: async () => undefined,
          }),
        }),
        connectDaemonRpcClient: async () => {
          connections += 1;
          if (connections >= 3) throw new Error('Reconnect unavailable');
          if (connections === 2) {
            return {
              authenticate: async (secret) => {
                authentications += 1;
                expect(Buffer.from(secret)).toEqual(Buffer.alloc(32, 6));
                throw new Error('Candidate authentication failed');
              },
              createRequest,
              send: async () => {
                throw new Error('unused');
              },
              close: async () => undefined,
            };
          }
          return {
            authenticate: async (secret) => {
              authentications += 1;
              expect(Buffer.from(secret)).toEqual(Buffer.alloc(32, 6));
            },
            createRequest,
            send: async () => {
              throw Object.assign(new Error('RPC connection closed'), {
                code: 'RPC_CONNECTION_CLOSED',
              });
            },
            close: async () => undefined,
          };
        },
        createViteServer: async () => ({
          middlewares: (_request, _response, next) => next(),
          transformIndexHtml: async (_url, html) => html,
          close: async () => undefined,
        }),
        loadIndexHtml: async () =>
          '<!doctype html><html><head><title>Agent Workbench</title></head><body></body></html>',
        createCsrfToken: () => 'csrf-token',
        sleep: async (milliseconds) => {
          sleepCalls.push(milliseconds);
        },
        writeReady: (line) => readyLines.push(line),
      },
    });

    const runtime = await fetch(`${server.url}api/runtime`);
    expect(runtime.status).toBe(200);
    expect(await runtime.json()).toEqual({
      daemon: { status: 'unavailable', protocolVersion: null, pid: null },
      provider: { baseHost: 'api.example.test', modelId: 'chat-model' },
      workspace: { name: expect.any(String) },
    });

    const mutation = await fetch(`${server.url}api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: new URL(server.url).origin,
        'x-agent-workbench-csrf': 'csrf-token',
      },
      body: JSON.stringify({
        submissionId: '123e4567-e89b-42d3-a456-426614174000',
        prompt: 'Read README.md',
      }),
    });
    expect(mutation.status).toBe(503);
    expect(await mutation.json()).toEqual({
      error: {
        code: 'RUNTIME_UNAVAILABLE',
        message: 'Runtime is unavailable',
        retryable: true,
        userAction: null,
      },
    });

    expect(readyLines).toHaveLength(1);
    expect(connections).toBe(7);
    expect(authentications).toBe(2);
    expect(sleepCalls).toHaveLength(4);
    expect(sleepCalls.every((milliseconds) => milliseconds < 100)).toBe(true);
    await server.stop();
  });

  it('coalesces SIGINT and SIGTERM into one idempotent shutdown', async () => {
    const { attachShutdownSignals } = await loadServer();
    const signals = new EventEmitter();
    let stops = 0;
    const detach = attachShutdownSignals(
      {
        stop: async () => {
          stops += 1;
        },
      },
      signals,
    );

    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    detach();
    signals.emit('SIGINT');

    expect(stops).toBe(1);
  });
});
