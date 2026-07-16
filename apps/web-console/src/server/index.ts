import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicErrorResponseSchema } from '../shared/contracts.js';
import {
  parseProviderConfig,
  type ParsedProviderConfig,
  type ProviderPrivateConfig,
} from './config.js';
import {
  DaemonProcessManager,
  type DaemonProcessHandle,
  type DaemonProcessStartOptions,
} from './daemon-process.js';
import {
  connectDaemonRpcClient,
} from './daemon-rpc-client.js';
import { createHttpApiHandler } from './http-api.js';
import {
  createHttpSecurityHeaders,
  createRuntimeSecurity,
  injectCsrfMeta,
  type RuntimeSecurity,
  validateBrowserRequest,
} from './http-security.js';
import { probeProviderModel } from './model-probe.js';
import {
  RpcController,
  type RpcControllerClient,
} from './rpc-controller.js';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtmlPath = join(appRoot, 'index.html');

type DaemonManagerLike = {
  start(options: DaemonProcessStartOptions): Promise<DaemonProcessHandle>;
};

type ViteServerLike = {
  readonly middlewares: (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ) => void;
  transformIndexHtml(url: string, html: string): Promise<string>;
  close(): Promise<void>;
};

export type WebConsoleServerDependencies = {
  readonly parseProviderConfig: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => ParsedProviderConfig;
  readonly probeProviderModel: (
    config: ProviderPrivateConfig,
    options: { readonly signal: AbortSignal },
  ) => Promise<string>;
  readonly createDaemonManager: () => DaemonManagerLike;
  readonly connectDaemonRpcClient: (
    socketPath: string,
  ) => Promise<RpcControllerClient>;
  readonly createViteServer: () => Promise<ViteServerLike>;
  readonly loadIndexHtml: () => Promise<string>;
  readonly createCsrfToken: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeReady: (line: string) => void;
};

export type StartWebConsoleServerOptions = {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly dependencies?: Partial<WebConsoleServerDependencies>;
  readonly signalSource?: ShutdownSignalSource;
  readonly onShutdownError?: (error: unknown) => void;
};

export type WebConsoleServerHandle = {
  readonly url: string;
  stop(): Promise<void>;
};

export type ShutdownSignalSource = {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

const createDefaultViteServer = async (): Promise<ViteServerLike> => {
  const vite = await import('vite');
  return await vite.createServer({
    root: appRoot,
    appType: 'custom',
    clearScreen: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
  });
};

const defaultDependencies = (): WebConsoleServerDependencies => ({
  parseProviderConfig,
  probeProviderModel,
  createDaemonManager: () => new DaemonProcessManager(),
  connectDaemonRpcClient,
  createViteServer: createDefaultViteServer,
  loadIndexHtml: async () => await readFile(indexHtmlPath, 'utf8'),
  createCsrfToken: () => randomBytes(32).toString('base64url'),
  sleep: async (milliseconds) =>
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, milliseconds);
    }),
  writeReady: (line) => {
    process.stdout.write(line);
  },
});

const startupCanceledError = (): Error & { readonly code: string } =>
  Object.assign(new Error('Web console startup was canceled'), {
    code: 'WEB_CONSOLE_STARTUP_CANCELLED',
  });

const disposeLate = <Value>(
  operation: Promise<Value>,
  dispose: ((value: Value) => void | Promise<void>) | undefined,
): void => {
  void operation.then(
    async (value) => {
      await Promise.resolve(dispose?.(value)).catch(() => undefined);
    },
    () => undefined,
  );
};

const raceWithAbort = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
  dispose: ((value: Value) => void | Promise<void>) | undefined = undefined,
): Promise<Value> => {
  if (signal.aborted) {
    disposeLate(operation, dispose);
    throw startupCanceledError();
  }

  return await new Promise<Value>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      action();
    };
    const handleAbort = (): void =>
      finish(() => {
        disposeLate(operation, dispose);
        rejectPromise(startupCanceledError());
      });
    signal.addEventListener('abort', handleAbort, { once: true });
    operation.then(
      (value) => finish(() => resolvePromise(value)),
      (error: unknown) => finish(() => rejectPromise(error)),
    );
  });
};

const resolveWorkspace = (
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
): { readonly name: string; readonly path: string } => {
  const configuredPath = environment.AGENT_WORKBENCH_DEMO_WORKSPACE?.trim();
  const workspacePath = realpathSync(resolve(configuredPath || cwd));
  if (!statSync(workspacePath).isDirectory()) {
    throw Object.assign(new Error('Demo workspace is invalid'), {
      code: 'WEB_WORKSPACE_INVALID',
    });
  }
  return { name: basename(workspacePath), path: workspacePath };
};

const dataDirectoryForWorkspace = (workspacePath: string): string => {
  const workspaceHash = createHash('sha256')
    .update(workspacePath, 'utf8')
    .digest('hex')
    .slice(0, 20);
  return join(tmpdir(), 'agent-workbench-preview', workspaceHash);
};


const headerValue = (
  value: string | readonly string[] | undefined,
): string | undefined => {
  if (typeof value === 'string' || value === undefined) return value;
  return value[0];
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = createHttpSecurityHeaders('api'),
): void => {
  response.writeHead(statusCode, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
};

const sendPublicError = (
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void => {
  sendJson(
    response,
    statusCode,
    PublicErrorResponseSchema.parse({
      error: {
        code,
        message,
        retryable: false,
        userAction: null,
      },
    }),
  );
};

const sendHtml = (
  response: ServerResponse,
  html: string,
): void => {
  response.writeHead(200, {
    ...createHttpSecurityHeaders('html'),
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(html);
};

const createBrowserHandler = (options: {
  readonly api: ReturnType<typeof createHttpApiHandler>;
  readonly runtimeSecurity: RuntimeSecurity;
  readonly vite: ViteServerLike;
  readonly indexHtml: string;
}): ((request: IncomingMessage, response: ServerResponse) => Promise<void>) =>
  async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await options.api(request, response);
      return;
    }

    const security = validateBrowserRequest(
      {
        method: 'GET',
        host: headerValue(request.headers.host),
        origin: headerValue(request.headers.origin),
      },
      options.runtimeSecurity,
    );
    if (!security.allowed) {
      sendPublicError(
        response,
        security.statusCode,
        security.code,
        'Browser request was rejected',
      );
      return;
    }

    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      sendPublicError(
        response,
        405,
        'WEB_METHOD_NOT_ALLOWED',
        'HTTP method is not allowed for this web route',
      );
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const transformed = await options.vite.transformIndexHtml(
        url.pathname,
        options.indexHtml,
      );
      sendHtml(response, injectCsrfMeta(transformed, options.runtimeSecurity));
      return;
    }

    response.setHeader('cache-control', 'no-store');
    options.vite.middlewares(request, response, (error) => {
      if (response.writableEnded) return;
      if (error !== undefined) {
        sendPublicError(
          response,
          500,
          'WEB_ASSET_FAILED',
          'Web asset request failed',
        );
        return;
      }
      sendPublicError(
        response,
        404,
        'WEB_ROUTE_NOT_FOUND',
        'Web route was not found',
      );
    });
  };

const listenOnLoopback = async (server: Server): Promise<number> => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const handleError = (error: Error): void => {
      server.off('listening', handleListening);
      rejectPromise(error);
    };
    const handleListening = (): void => {
      server.off('error', handleError);
      resolvePromise();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Web console HTTP server did not bind a TCP port');
  }
  return address.port;
};

const closeHttpServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
};

export const startWebConsoleServer = async (
  options: StartWebConsoleServerOptions = {},
): Promise<WebConsoleServerHandle> => {
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const startupAbort = new AbortController();
  let daemon: DaemonProcessHandle | undefined;
  let rpcClient: RpcControllerClient | undefined;
  let rpcController: RpcController | undefined;
  let rpcAuthenticationSecret: Buffer | undefined;
  let http: Server | undefined;
  let vite: ViteServerLike | undefined;
  let activeHandler:
    | ((request: IncomingMessage, response: ServerResponse) => Promise<void>)
    | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let shutdownRequested = false;
  let resolveStartupSettled!: () => void;
  const startupSettled = new Promise<void>((resolvePromise) => {
    resolveStartupSettled = resolvePromise;
  });
  let detachSignals = (): void => undefined;

  const zeroBootstrapSecret = (): void => {
    daemon?.bootstrapSecret.fill(0);
  };
  const cleanup = async (): Promise<void> => {
    activeHandler = undefined;
    const failures: unknown[] = [];
    if (http !== undefined) {
      try {
        await closeHttpServer(http);
      } catch (error) {
        failures.push(error);
      }
    }
    if (rpcController !== undefined) {
      try {
        await rpcController.close();
      } catch (error) {
        failures.push(error);
      }
    } else if (rpcClient !== undefined) {
      try {
        await rpcClient.close();
      } catch (error) {
        failures.push(error);
      }
    }
    rpcAuthenticationSecret?.fill(0);
    if (daemon !== undefined) {
      try {
        await daemon.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (vite !== undefined) {
      try {
        await vite.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Web console shutdown failed');
    }
  };
  const stop = async (): Promise<void> => {
    shutdownRequested = true;
    startupAbort.abort();
    await startupSettled;
    cleanupPromise ??= cleanup().finally(detachSignals);
    await cleanupPromise;
  };
  const assertStartupActive = (): void => {
    if (!startupAbort.signal.aborted) return;
    throw startupCanceledError();
  };
  detachSignals = attachShutdownSignals(
    { stop },
    options.signalSource ?? process,
    options.onShutdownError ?? (() => undefined),
  );

  let startupFailure: unknown;
  let startedUrl: string | undefined;
  try {
    assertStartupActive();
    const provider = dependencies.parseProviderConfig(environment);
    const workspace = resolveWorkspace(cwd, environment);
    assertStartupActive();
    const modelId = await raceWithAbort(
      dependencies.probeProviderModel(provider.privateConfig, {
        signal: startupAbort.signal,
      }),
      startupAbort.signal,
    );
    assertStartupActive();
    daemon = await raceWithAbort(
      dependencies.createDaemonManager().start({
        dataDir: dataDirectoryForWorkspace(workspace.path),
        workspacePath: workspace.path,
        provider: {
          baseUrl: provider.privateConfig.baseUrl,
          apiKey: provider.privateConfig.apiKey,
          modelId,
        },
      }),
      startupAbort.signal,
      async (lateDaemon) => {
        lateDaemon.bootstrapSecret.fill(0);
        await lateDaemon.stop();
      },
    );
    assertStartupActive();
    rpcAuthenticationSecret = Buffer.from(daemon.bootstrapSecret);
    rpcClient = await raceWithAbort(
      dependencies.connectDaemonRpcClient(daemon.socketPath),
      startupAbort.signal,
      async (lateClient) => await lateClient.close(),
    );
    assertStartupActive();
    try {
      await raceWithAbort(
        rpcClient.authenticate(rpcAuthenticationSecret),
        startupAbort.signal,
      );
    } finally {
      zeroBootstrapSecret();
    }
    assertStartupActive();
    rpcController = new RpcController({
      initialClient: rpcClient,
      connect: dependencies.connectDaemonRpcClient,
      socketPath: daemon.socketPath,
      authenticationSecret: rpcAuthenticationSecret,
      sleep: dependencies.sleep,
    });
    rpcClient = undefined;
    rpcAuthenticationSecret = undefined;

    http = createServer((request, response) => {
      const handler = activeHandler;
      if (handler === undefined) {
        sendPublicError(
          response,
          503,
          'WEB_STARTING',
          'Web console is not ready',
        );
        return;
      }
      void handler(request, response).catch(() => {
        if (response.writableEnded) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendPublicError(
          response,
          500,
          'WEB_INTERNAL_ERROR',
          'Web console request failed',
        );
      });
    });
    const port = await raceWithAbort(
      listenOnLoopback(http),
      startupAbort.signal,
      async () => await closeHttpServer(http!),
    );
    assertStartupActive();
    const runtimeSecurity = createRuntimeSecurity(
      port,
      dependencies.createCsrfToken(),
    );
    const api = createHttpApiHandler({
      rpc: rpcController,
      runtimeSecurity,
      provider: {
        baseHost: provider.publicConfig.baseHost,
        modelId,
      },
      workspace,
    });
    vite = await raceWithAbort(
      dependencies.createViteServer(),
      startupAbort.signal,
      async (lateVite) => await lateVite.close(),
    );
    assertStartupActive();
    const indexHtml = await raceWithAbort(
      dependencies.loadIndexHtml(),
      startupAbort.signal,
    );
    assertStartupActive();
    activeHandler = createBrowserHandler({
      api,
      runtimeSecurity,
      vite,
      indexHtml,
    });
    const url = `http://127.0.0.1:${port}/`;
    assertStartupActive();
    dependencies.writeReady(`${JSON.stringify({ event: 'ready', url })}\n`);
    startedUrl = url;
  } catch (error) {
    zeroBootstrapSecret();
    startupFailure = shutdownRequested
      ? startupCanceledError()
      : error;
  } finally {
    resolveStartupSettled();
  }

  if (startupFailure !== undefined) {
    await stop().catch(() => undefined);
    throw startupFailure;
  }
  if (startedUrl === undefined) {
    await stop().catch(() => undefined);
    throw new Error('Web console startup did not produce a ready URL');
  }

  return Object.freeze({ url: startedUrl, stop });
};

export const attachShutdownSignals = (
  server: Pick<WebConsoleServerHandle, 'stop'>,
  signalSource: ShutdownSignalSource = process,
  onError: (error: unknown) => void = () => undefined,
): (() => void) => {
  let shutdownPromise: Promise<void> | undefined;
  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    signalSource.off('SIGINT', handleSigint);
    signalSource.off('SIGTERM', handleSigterm);
  };
  const shutdown = (): void => {
    shutdownPromise ??= server.stop();
    void shutdownPromise.then(detach, (error: unknown) => {
      detach();
      onError(error);
    });
  };
  const handleSigint = (): void => shutdown();
  const handleSigterm = (): void => shutdown();
  signalSource.once('SIGINT', handleSigint);
  signalSource.once('SIGTERM', handleSigterm);
  return detach;
};

const errorCode = (error: unknown): string => {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.length > 0
  ) {
    return error.code;
  }
  return 'WEB_CONSOLE_STARTUP_FAILED';
};

const main = async (): Promise<void> => {
  try {
    await startWebConsoleServer({
      onShutdownError: () => {
        process.stderr.write(
          `${JSON.stringify({ event: 'shutdown_error', code: 'WEB_CONSOLE_SHUTDOWN_FAILED' })}\n`,
        );
        process.exitCode = 1;
      },
    });
  } catch (error) {
    if (errorCode(error) === 'WEB_CONSOLE_STARTUP_CANCELLED') return;
    process.stderr.write(
      `${JSON.stringify({ event: 'startup_error', code: errorCode(error) })}\n`,
    );
    process.exitCode = 1;
  }
};

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  void main();
}
