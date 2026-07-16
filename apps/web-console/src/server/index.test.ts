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
      }): Promise<string>;
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
      createViteServer(): Promise<{
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

describe('web console server', () => {
  it('starts in order, serves secured HTTP, prints one ready URL, and stops once', async () => {
    const { startWebConsoleServer } = await loadServer();
    const lifecycle: string[] = [];
    const readyLines: string[] = [];
    const bootstrapSecret = Buffer.alloc(32, 7);
    let requestSequence = 0;
    let serverUrl = '';
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
        createViteServer: async () => {
          lifecycle.push('vite');
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
              html.replace('<title>', '<meta name="vite-test" content="ok"><title>'),
            close: async () => {
              lifecycle.push('vite.close');
            },
          };
        },
        loadIndexHtml: async () =>
          '<!doctype html><html><head><title>Agent Workbench</title></head><body></body></html>',
        createCsrfToken: () => 'csrf-token',
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

    const html = await fetch(server.url);
    const htmlBody = await html.text();
    expect(html.status).toBe(200);
    expect(html.headers.get('cache-control')).toBe('no-store');
    expect(html.headers.get('content-security-policy')).toBe(
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(htmlBody).toContain('<meta name="agent-workbench-csrf" content="csrf-token">');
    expect(htmlBody).toContain('<meta name="vite-test" content="ok">');

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
