import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  type BigIntStats,
  unlinkSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  encodeFrame,
  FrameCodecError,
  FrameDecoder,
  RpcEnvelopeSchema,
  RpcRequestSchema,
  type RpcRequest,
  type RpcRequestEnvelope,
  type RpcResponse,
  type ErrorCategory,
} from '@agent-workbench/protocol';
import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';

import {
  acquireRuntimeDatabase,
  initializeRuntimeDatabase,
  type OpenRuntimeDatabaseOptions,
} from './db/database.js';
import { mapRpcFailure } from './db/errors.js';
import { Authenticator } from './rpc/authenticator.js';
import { Router } from './rpc/router.js';
import { Scheduler } from './runtime/scheduler.js';
import {
  acquireRuntimeLock,
  RuntimeLock,
  RuntimeLockError,
} from './runtime/runtime-lock.js';
import {
  SessionService,
  type SessionServiceHooks,
} from './runtime/session-service.js';
import {
  recoverStartupState,
  type StartupRecovery,
  type StartupRecoveryHooks,
} from './runtime/startup-recovery.js';

const MAX_IN_FLIGHT_REQUESTS = 128;
const FULL_CLOSE_FALLBACK_MS = 500;

export interface DaemonServerOptions {
  readonly socketPath: string;
  readonly dataDir: string;
  readonly bootstrapSecret: Uint8Array;
  readonly onFatal?: (error: Error) => void;
  readonly sessionServiceHooks?: SessionServiceHooks;
  readonly startupRecoveryHooks?: StartupRecoveryHooks;
  readonly createDaemonEpoch?: () => string;
  readonly acquireDatabase?: (
    options: OpenRuntimeDatabaseOptions,
  ) => Database.Database;
  readonly initializeDatabase?: (
    database: Database.Database,
    options: OpenRuntimeDatabaseOptions,
  ) => Promise<void>;
  readonly recoverStartup?: StartupRecovery;
  readonly closeDatabase?: (database: Database.Database) => void | Promise<void>;
}

export class DaemonStartCancelledError extends Error {
  constructor() {
    super('Daemon startup was cancelled');
    this.name = 'DaemonStartCancelledError';
  }
}

type LifecycleState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

type BoundSocketIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
};

type ConnectionContext = {
  readonly authenticator: Authenticator;
  readonly decoder: FrameDecoder;
  readonly ingressQuiescence: IngressQuiescence;
  inFlightRequests: number;
  overflowed: boolean;
  overflowResponseWritten: boolean;
};

class IngressQuiescence {
  private generation = 0;
  private checkScheduled = false;
  private waiters: Array<() => void> = [];

  markActivity(): void {
    this.generation += 1;
    this.scheduleCheck();
  }

  async wait(): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      this.waiters.push(resolvePromise);
      this.scheduleCheck();
    });
  }

  private scheduleCheck(): void {
    if (this.checkScheduled || this.waiters.length === 0) {
      return;
    }

    this.checkScheduled = true;
    const observedGeneration = this.generation;
    setImmediate(() => {
      setImmediate(() => {
        this.checkScheduled = false;

        if (this.generation !== observedGeneration) {
          this.scheduleCheck();
          return;
        }

        const waiters = this.waiters;
        this.waiters = [];
        for (const resolveWaiter of waiters) {
          resolveWaiter();
        }
      });
    });
  }
}

const modeBits = (mode: number): number => mode & 0o777;
const lstatBigIntIfExists = (
  path: string,
): BigIntStats | undefined => {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};
const currentUid = (): number => {
  if (typeof process.getuid !== 'function') {
    throw new Error('Daemon requires Unix user ownership checks');
  }

  return process.getuid();
};

const createErrorResponse = (
  request: RpcRequestEnvelope,
  error: {
    readonly code: string;
    readonly category: ErrorCategory;
    readonly message: string;
    readonly retryable: boolean;
    readonly userAction?: string | null;
  },
): RpcResponse => ({
  kind: 'response',
  protocolVersion: 1,
  requestId: request.requestId,
  traceId: request.traceId,
  ok: false,
  error: {
    code: error.code,
    category: error.category,
    message: error.message,
    retryable: error.retryable,
    userAction: error.userAction ?? null,
    detailsRef: null,
    traceId: request.traceId,
  },
});

const createAuthFailureResponse = (request: RpcRequestEnvelope): RpcResponse =>
  createErrorResponse(request, {
    code: 'RPC_AUTH_FAILED',
    category: 'runtime',
    message: 'RPC authentication failed',
    retryable: false,
  });

export class DaemonServer {
  private readonly requestedSocketPath: string;
  private readonly dataDir: string;
  private readonly daemonEpoch: string;
  private readonly bootstrapSecret: Buffer;
  private readonly onFatal: (error: Error) => void;
  private readonly sessionServiceHooks: SessionServiceHooks;
  private readonly startupRecoveryHooks: StartupRecoveryHooks;
  private readonly acquireDatabase: (
    options: OpenRuntimeDatabaseOptions,
  ) => Database.Database;
  private readonly initializeDatabase: (
    database: Database.Database,
    options: OpenRuntimeDatabaseOptions,
  ) => Promise<void>;
  private readonly recoverStartup: StartupRecovery;
  private readonly closeDatabase: (
    database: Database.Database,
  ) => void | Promise<void>;
  private readonly router = {
    handle: async (request: RpcRequest): Promise<unknown> => {
      const databaseRouter = this.databaseRouter;
      if (!databaseRouter) {
        throw new Error('RPC router is unavailable');
      }
      return await databaseRouter.handle(request);
    },
  };
  private readonly connections = new Set<Socket>();
  private readonly closingSockets = new WeakSet<Socket>();
  private server: Server | undefined;
  private database: Database.Database | undefined;
  private scheduler: Scheduler | undefined;
  private databaseRouter: Router | undefined;
  private runtimeLock: RuntimeLock | undefined;
  private activeSocketPath: string | undefined;
  private boundSocketIdentity: BoundSocketIdentity | undefined;
  private lifecycleState: LifecycleState = 'idle';
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private stopRequested = false;
  private listenAbortController: AbortController | undefined;

  constructor(options: DaemonServerOptions) {
    this.requestedSocketPath = resolve(options.socketPath);
    this.dataDir = resolve(options.dataDir);
    this.daemonEpoch = options.createDaemonEpoch?.() ?? uuidv7();
    this.bootstrapSecret = Buffer.from(options.bootstrapSecret);
    this.onFatal = options.onFatal ?? (() => undefined);
    this.sessionServiceHooks = options.sessionServiceHooks ?? {};
    this.startupRecoveryHooks = options.startupRecoveryHooks ?? {};
    this.acquireDatabase = options.acquireDatabase ?? acquireRuntimeDatabase;
    this.initializeDatabase =
      options.initializeDatabase ?? initializeRuntimeDatabase;
    this.recoverStartup = options.recoverStartup ?? recoverStartupState;
    this.closeDatabase =
      options.closeDatabase ??
      ((database) => {
        database.close();
      });
  }

  async start(): Promise<void> {
    if (this.lifecycleState !== 'idle') {
      throw new Error('Daemon server can only be started once');
    }

    this.lifecycleState = 'starting';
    this.startPromise = this.performStart();
    await this.startPromise;
  }

  private async performStart(): Promise<void> {
    try {
      const runtimeLock = await acquireRuntimeLock({
        dataDir: this.dataDir,
        socketPath: this.requestedSocketPath,
        daemonEpoch: this.daemonEpoch,
        onLost: (error) => {
          this.handleRuntimeLockLost(error);
        },
      });
      this.runtimeLock = runtimeLock;
      this.throwIfStopRequested();
      runtimeLock.assertHeld();
      const databaseOptions = { dataDir: this.dataDir };
      this.database = this.acquireDatabase(databaseOptions);
      await this.initializeDatabase(this.database, databaseOptions);
      this.throwIfStopRequested();
      runtimeLock.assertHeld();
      this.recoverStartup(this.database, {
        daemonEpoch: this.daemonEpoch,
        hooks: this.startupRecoveryHooks,
      });
      this.throwIfStopRequested();
      runtimeLock.assertHeld();
      this.scheduler = new Scheduler(this.database, {
        daemonEpoch: this.daemonEpoch,
      });
      this.databaseRouter = new Router(
        new SessionService(this.database, this.sessionServiceHooks),
      );
      this.activeSocketPath = this.prepareSocketBoundary();
      this.throwIfStopRequested();
      runtimeLock.assertHeld();

      const server = createServer((socket) => {
        this.acceptConnection(socket);
      });
      this.server = server;
      this.throwIfStopRequested();

      const listenAbortController = new AbortController();
      this.listenAbortController = listenAbortController;
      await new Promise<void>((resolvePromise, rejectPromise) => {
        let settled = false;
        const finish = (action: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          server.off('error', handleError);
          server.off('listening', handleListening);
          listenAbortController.signal.removeEventListener('abort', handleAbort);
          action();
        };
        const handleError = (error: Error): void => {
          finish(() => rejectPromise(error));
        };
        const handleListening = (): void => {
          finish(resolvePromise);
        };
        const handleAbort = (): void => {
          finish(() => rejectPromise(new DaemonStartCancelledError()));
        };

        server.once('error', handleError);
        server.once('listening', handleListening);
        listenAbortController.signal.addEventListener('abort', handleAbort, {
          once: true,
        });
        server.listen({
          path: this.activeSocketPath,
          signal: listenAbortController.signal,
        });
      });
      if (this.listenAbortController === listenAbortController) {
        this.listenAbortController = undefined;
      }

      this.throwIfStopRequested();
      runtimeLock.assertHeld();
      const createdSocketStatus = lstatSync(this.activeSocketPath, {
        bigint: true,
      });
      if (
        !createdSocketStatus.isSocket() ||
        createdSocketStatus.uid !== BigInt(currentUid())
      ) {
        throw new Error('Invalid daemon socket boundary');
      }
      this.boundSocketIdentity = {
        dev: createdSocketStatus.dev,
        ino: createdSocketStatus.ino,
      };

      chmodSync(this.activeSocketPath, 0o600);
      const socketStatus = lstatSync(this.activeSocketPath, { bigint: true });

      if (
        !socketStatus.isSocket() ||
        socketStatus.uid !== BigInt(currentUid()) ||
        Number(socketStatus.mode & 0o777n) !== 0o600 ||
        socketStatus.dev !== createdSocketStatus.dev ||
        socketStatus.ino !== createdSocketStatus.ino
      ) {
        throw new Error('Invalid daemon socket boundary');
      }
      runtimeLock.assertHeld();
      this.throwIfStopRequested();
      this.lifecycleState = 'running';
    } catch (error) {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Daemon startup and cleanup both failed',
          { cause: cleanupError },
        );
      }
      if (!this.stopRequested) {
        this.lifecycleState = 'stopped';
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.listenAbortController?.abort();
    this.stopPromise ??= this.performStop();
    await this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.lifecycleState = 'stopping';
    await this.startPromise?.catch(() => undefined);
    await this.cleanup();
    this.lifecycleState = 'stopped';
  }

  private async cleanup(): Promise<void> {
    this.cleanupPromise ??= this.performCleanup();
    await this.cleanupPromise;
  }

  private async performCleanup(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    let databaseClosed = this.database === undefined;

    try {
      const server = this.server;
      const closePromise =
        server && server.listening
          ? new Promise<void>((resolvePromise) => {
              server.close(() => resolvePromise());
            })
          : Promise.resolve();

      for (const connection of this.connections) {
        connection.destroy();
      }
      try {
        await closePromise;
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        this.unlinkOwnedSocket();
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        if (this.database) {
          await this.closeDatabase(this.database);
          databaseClosed = true;
        }
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (databaseClosed) {
        try {
          await this.runtimeLock?.release();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } finally {
      this.bootstrapSecret.fill(0);
      this.listenAbortController = undefined;
    }

    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Daemon cleanup failed');
    }
  }

  private throwIfStopRequested(): void {
    if (this.stopRequested) {
      throw new DaemonStartCancelledError();
    }
  }

  private prepareSocketBoundary(): string {
    const runtimeDirectory = dirname(this.requestedSocketPath);
    mkdirSync(runtimeDirectory, { mode: 0o700, recursive: true });
    const initialStatus = lstatSync(runtimeDirectory);

    if (
      !initialStatus.isDirectory() ||
      initialStatus.isSymbolicLink() ||
      initialStatus.uid !== currentUid()
    ) {
      throw new Error('Invalid daemon runtime directory');
    }

    chmodSync(runtimeDirectory, 0o700);
    const runtimeStatus = lstatSync(runtimeDirectory);
    if (modeBits(runtimeStatus.mode) !== 0o700) {
      throw new Error('Daemon runtime directory must have mode 0700');
    }

    const canonicalRuntimeDirectory = realpathSync(runtimeDirectory);
    const socketName = basename(this.requestedSocketPath);
    const socketPath = join(canonicalRuntimeDirectory, socketName);
    const relation = relative(canonicalRuntimeDirectory, socketPath);

    if (
      relation.length === 0 ||
      relation.startsWith('..') ||
      isAbsolute(relation) ||
      dirname(relation) !== '.'
    ) {
      throw new Error('Daemon socket path escapes its runtime directory');
    }

    const runtimeLock = this.runtimeLock;
    if (!runtimeLock) {
      throw new Error('Daemon runtime lock is unavailable');
    }

    const existingSocketPath = lstatBigIntIfExists(socketPath);
    if (existingSocketPath) {
      runtimeLock.assertHeld();
      const status = existingSocketPath;

      if (
        !status.isSocket() ||
        status.isSymbolicLink() ||
        status.uid !== BigInt(currentUid())
      ) {
        throw new Error('Refusing to remove an unsafe pre-existing socket path');
      }

      runtimeLock.assertPredecessorStaleForSocket(socketPath);
      const confirmedSocketPath = lstatBigIntIfExists(socketPath);
      if (
        !confirmedSocketPath ||
        !confirmedSocketPath.isSocket() ||
        confirmedSocketPath.isSymbolicLink() ||
        confirmedSocketPath.uid !== BigInt(currentUid()) ||
        confirmedSocketPath.dev !== status.dev ||
        confirmedSocketPath.ino !== status.ino
      ) {
        throw new Error('Pre-existing daemon socket changed during recovery');
      }

      unlinkSync(socketPath);
    }

    runtimeLock.markPredecessorResolved(socketPath);

    return socketPath;
  }

  private handleRuntimeLockLost(error: RuntimeLockError): void {
    void this.stop().then(
      () => this.onFatal(error),
      () => this.onFatal(error),
    );
  }

  private acceptConnection(socket: Socket): void {
    const context: ConnectionContext = {
      authenticator: new Authenticator(this.bootstrapSecret),
      decoder: new FrameDecoder(),
      ingressQuiescence: new IngressQuiescence(),
      inFlightRequests: 0,
      overflowed: false,
      overflowResponseWritten: false,
    };
    this.connections.add(socket);
    socket.on('close', () => {
      context.authenticator.destroy();
      this.connections.delete(socket);
    });
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('data', (chunk: Buffer) => {
      context.ingressQuiescence.markActivity();
      let frames: unknown[];

      try {
        frames = context.decoder.push(chunk);
      } catch (error) {
        if (error instanceof FrameCodecError) {
          socket.destroy();
          return;
        }
        socket.destroy();
        return;
      }

      for (const frame of frames) {
        if (socket.destroyed || socket.writableEnded) {
          break;
        }
        this.handleEnvelope(socket, context, frame);
        if (context.overflowed) {
          break;
        }
      }
    });

    socket.write(
      encodeFrame({
        kind: 'notification',
        protocolVersion: 1,
        traceId: uuidv7(),
        method: 'auth.challenge',
        payload: { nonce: context.authenticator.challengeNonce },
      }),
    );
  }

  private handleEnvelope(
    socket: Socket,
    context: ConnectionContext,
    value: unknown,
  ): void {
    const transport = RpcEnvelopeSchema.safeParse(value);

    if (!transport.success || transport.data.kind !== 'request') {
      socket.destroy();
      return;
    }

    const contract = RpcRequestSchema.safeParse(transport.data);

    if (!contract.success) {
      if (context.authenticator.state === 'pending') {
        context.authenticator.reject();
        this.failAuthentication(socket, transport.data);
      } else {
        void this.writeResponse(
          socket,
          createErrorResponse(transport.data, {
            code: 'RPC_PROTOCOL_ERROR',
            category: 'validation',
            message: 'RPC request does not match its method contract',
            retryable: false,
          }),
          context,
        );
      }
      return;
    }

    const request = contract.data;

    if (context.authenticator.state === 'pending') {
      if (
        request.method !== 'auth.respond' ||
        !context.authenticator.authenticate(request.payload)
      ) {
        context.authenticator.reject();
        this.failAuthentication(socket, request);
        return;
      }

      void this.writeResponse(
        socket,
        {
          kind: 'response',
          protocolVersion: 1,
          requestId: request.requestId,
          traceId: request.traceId,
          ok: true,
          result: { authenticated: true },
        },
        context,
      );
      return;
    }

    if (
      context.authenticator.state !== 'authenticated' ||
      request.method === 'auth.respond'
    ) {
      context.authenticator.reject();
      this.failAuthentication(socket, request);
      return;
    }

    if (context.inFlightRequests >= MAX_IN_FLIGHT_REQUESTS) {
      context.overflowed = true;
      socket.pause();
      void this.writeResponse(
        socket,
        createErrorResponse(request, {
          code: 'RPC_BACKPRESSURE',
          category: 'runtime',
          message: 'RPC in-flight request limit exceeded',
          retryable: true,
        }),
        context,
      ).then(() => {
        context.overflowResponseWritten = true;
        this.endOverflowedConnectionWhenDrained(socket, context);
      });
      return;
    }

    context.inFlightRequests += 1;
    void this.dispatch(socket, context, request).finally(() => {
      context.inFlightRequests -= 1;
      this.endOverflowedConnectionWhenDrained(socket, context);
    });
  }

  private async dispatch(
    socket: Socket,
    context: ConnectionContext,
    request: RpcRequest,
  ): Promise<void> {
    try {
      if (request.method === 'app.health') {
        await context.ingressQuiescence.wait();
      }
      const result = await this.router.handle(request);
      await this.writeResponse(
        socket,
        {
          kind: 'response',
          protocolVersion: 1,
          requestId: request.requestId,
          traceId: request.traceId,
          ok: true,
          result,
        },
        context,
      );
    } catch (error) {
      await this.writeResponse(
        socket,
        createErrorResponse(
          request,
          mapRpcFailure(error),
        ),
        context,
      );
    }
  }

  private async writeResponse(
    socket: Socket,
    response: RpcResponse,
    context: ConnectionContext,
  ): Promise<void> {
    if (socket.destroyed || socket.writableEnded) {
      return;
    }

    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finishWrite = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.off('close', finishWrite);
        resolvePromise();
      };
      socket.once('close', finishWrite);

      try {
        const canContinue = socket.write(encodeFrame(response), finishWrite);
        if (!canContinue) {
          socket.pause();
          const handleClose = (): void => {
            socket.off('drain', handleDrain);
          };
          const handleDrain = (): void => {
            socket.off('close', handleClose);
            if (
              !context.overflowed &&
              !socket.destroyed &&
              !socket.writableEnded
            ) {
              socket.resume();
            }
          };
          socket.once('close', handleClose);
          socket.once('drain', handleDrain);
        }
      } catch {
        finishWrite();
      }
    });
  }

  private failAuthentication(socket: Socket, request: RpcRequestEnvelope): void {
    if (!socket.destroyed && !socket.writableEnded) {
      this.closeAfterFlush(
        socket,
        encodeFrame(createAuthFailureResponse(request)),
      );
    }
  }

  private endOverflowedConnectionWhenDrained(
    socket: Socket,
    context: ConnectionContext,
  ): void {
    if (
      context.overflowed &&
      context.overflowResponseWritten &&
      context.inFlightRequests === 0 &&
      !socket.destroyed &&
      !socket.writableEnded
    ) {
      this.closeAfterFlush(socket);
    }
  }

  private closeAfterFlush(socket: Socket, finalBytes?: Uint8Array): void {
    if (socket.destroyed || this.closingSockets.has(socket)) {
      return;
    }
    this.closingSockets.add(socket);

    const destroy = (): void => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    };
    const fallback = setTimeout(destroy, FULL_CLOSE_FALLBACK_MS);
    fallback.unref();
    socket.once('close', () => clearTimeout(fallback));

    try {
      if (finalBytes) {
        socket.end(finalBytes, destroy);
      } else {
        socket.end(destroy);
      }
    } catch {
      destroy();
    }
  }

  private unlinkOwnedSocket(): void {
    const expected = this.boundSocketIdentity;
    const socketPath = this.activeSocketPath;

    if (!expected || !socketPath) {
      return;
    }

    const current = lstatBigIntIfExists(socketPath);
    if (!current) {
      return;
    }

    if (
      current.isSocket() &&
      current.uid === BigInt(currentUid()) &&
      current.dev === expected.dev &&
      current.ino === expected.ino
    ) {
      unlinkSync(socketPath);
    }
  }
}
