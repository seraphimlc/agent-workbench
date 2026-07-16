import { createHmac, randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

import {
  AuthChallengeNotificationSchema,
  AuthRespondResultSchema,
  encodeFrame,
  FrameCodecError,
  FrameDecoder,
  RpcEnvelopeSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  type RpcMethod,
  type RpcRequestEnvelope,
  type RpcResponse,
} from '@agent-workbench/protocol';

const DEFAULT_RPC_TIMEOUT_MS = 5_000;

export type DaemonRpcClientErrorCode =
  | 'RPC_CONNECTION_FAILED'
  | 'RPC_CONNECTION_TIMEOUT'
  | 'RPC_CONNECTION_CLOSED'
  | 'RPC_CLIENT_CLOSED'
  | 'RPC_AUTH_TIMEOUT'
  | 'RPC_AUTH_FAILED'
  | 'RPC_NOT_AUTHENTICATED'
  | 'RPC_REQUEST_INVALID'
  | 'RPC_REQUEST_TIMEOUT'
  | 'RPC_DUPLICATE_REQUEST_ID'
  | 'RPC_PROTOCOL_ERROR'
  | 'RPC_CLOSE_FAILED'
  | 'RPC_CLOSE_TIMEOUT';

export class DaemonRpcClientError extends Error {
  readonly code: DaemonRpcClientErrorCode;

  constructor(code: DaemonRpcClientErrorCode, message: string) {
    super(message);
    this.name = 'DaemonRpcClientError';
    this.code = code;
  }
}

export type DaemonRpcRequestOptions = {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly clientRequestId?: string;
};

type PendingResponse = {
  readonly method: RpcMethod;
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
};

type AuthChallengeNotification = ReturnType<
  typeof AuthChallengeNotificationSchema.parse
>;

const isPositiveTimeout = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const timeoutError = (
  code: DaemonRpcClientErrorCode,
  message: string,
): DaemonRpcClientError => new DaemonRpcClientError(code, message);

const waitWithTimeout = async <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  error: DaemonRpcClientError,
): Promise<Value> => {
  if (!isPositiveTimeout(timeoutMs)) {
    throw error;
  }

  return await new Promise<Value>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(error), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (failure: unknown) => {
        clearTimeout(timer);
        rejectPromise(failure);
      },
    );
  });
};

const payloadSessionId = (payload: unknown): string | null => {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'sessionId' in payload &&
    typeof payload.sessionId === 'string'
  ) {
    return payload.sessionId;
  }

  return null;
};

const createAuthMac = (secret: Uint8Array, nonce: string): string =>
  createHmac('sha256', secret).update(`${nonce}1`, 'utf8').digest('hex');

export class DaemonRpcClient {
  private readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly challengePromise: Promise<AuthChallengeNotification>;
  private readonly socketClosePromise: Promise<void>;
  private resolveChallenge!: (challenge: AuthChallengeNotification) => void;
  private rejectChallenge!: (error: Error) => void;
  private challenge: AuthChallengeNotification | undefined;
  private authenticationPromise: Promise<void> | undefined;
  private authenticated = false;
  private failed: Error | undefined;
  private closeStarted = false;
  private closeOperation: Promise<void> | undefined;

  constructor(socket: Socket) {
    this.socket = socket;
    this.challengePromise = new Promise((resolvePromise, rejectPromise) => {
      this.resolveChallenge = resolvePromise;
      this.rejectChallenge = rejectPromise;
    });
    void this.challengePromise.catch(() => undefined);
    this.socketClosePromise = new Promise((resolvePromise) => {
      socket.once('close', resolvePromise);
    });

    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('error', () => {
      this.fail(
        new DaemonRpcClientError(
          'RPC_CONNECTION_CLOSED',
          'Daemon RPC connection failed',
        ),
      );
    });
    socket.on('close', () => {
      this.fail(
        new DaemonRpcClientError(
          this.closeStarted ? 'RPC_CLIENT_CLOSED' : 'RPC_CONNECTION_CLOSED',
          this.closeStarted
            ? 'Daemon RPC client is closed'
            : 'Daemon RPC connection closed',
        ),
      );
    });
  }

  createRequest(
    method: RpcMethod,
    payload: unknown,
    options: DaemonRpcRequestOptions = {},
  ): RpcRequestEnvelope {
    return {
      kind: 'request',
      protocolVersion: 1,
      requestId: randomUUID(),
      traceId: randomUUID(),
      sessionId: options.sessionId ?? payloadSessionId(payload),
      turnId: options.turnId ?? null,
      method,
      payload,
      clientRequestId: options.clientRequestId ?? null,
    };
  }

  authenticate(secret: Uint8Array): Promise<void> {
    if (this.authenticated) {
      return Promise.resolve();
    }
    if (this.authenticationPromise) {
      return this.authenticationPromise;
    }

    const secretCopy = Buffer.from(secret);
    this.authenticationPromise = this.performAuthentication(secretCopy).finally(
      () => secretCopy.fill(0),
    );
    return this.authenticationPromise;
  }

  async send(
    request: RpcRequestEnvelope,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<RpcResponse> {
    if (this.failed) {
      throw this.failed;
    }
    if (this.closeStarted) {
      throw new DaemonRpcClientError(
        'RPC_CLIENT_CLOSED',
        'Daemon RPC client is closed',
      );
    }

    const parsedRequest = RpcRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new DaemonRpcClientError(
        'RPC_REQUEST_INVALID',
        'Daemon RPC request does not match the protocol contract',
      );
    }
    if (request.method !== 'auth.respond' && !this.authenticated) {
      throw new DaemonRpcClientError(
        'RPC_NOT_AUTHENTICATED',
        'Daemon RPC client is not authenticated',
      );
    }
    if (this.pendingResponses.has(request.requestId)) {
      throw new DaemonRpcClientError(
        'RPC_DUPLICATE_REQUEST_ID',
        'Daemon RPC request id is already pending',
      );
    }
    if (!isPositiveTimeout(timeoutMs)) {
      throw timeoutError(
        'RPC_REQUEST_TIMEOUT',
        'Timed out waiting for the daemon RPC response',
      );
    }

    let requestFrame: Buffer;
    try {
      requestFrame = encodeFrame(parsedRequest.data);
    } catch {
      throw new DaemonRpcClientError(
        'RPC_REQUEST_INVALID',
        'Daemon RPC request cannot be encoded as a protocol frame',
      );
    }

    let pending!: PendingResponse;
    const responsePromise = new Promise<RpcResponse>(
      (resolvePromise, rejectPromise) => {
        pending = {
          method: parsedRequest.data.method,
          resolve: resolvePromise,
          reject: rejectPromise,
        };
      },
    );
    void responsePromise.catch(() => undefined);
    this.pendingResponses.set(request.requestId, pending);
    const requestTimeout = setTimeout(() => {
      pending.reject(
        timeoutError(
          'RPC_REQUEST_TIMEOUT',
          'Timed out waiting for the daemon RPC response',
        ),
      );
    }, timeoutMs);

    try {
      try {
        await this.writeBytes(requestFrame);
      } catch {
        const failure =
          this.failed ??
          new DaemonRpcClientError(
            'RPC_CONNECTION_CLOSED',
            'Daemon RPC connection closed during request write',
          );
        this.fail(failure);
      }
      return await responsePromise;
    } finally {
      clearTimeout(requestTimeout);
      if (this.pendingResponses.get(request.requestId) === pending) {
        this.pendingResponses.delete(request.requestId);
      }
    }
  }

  close(timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<void> {
    this.closeOperation ??= this.performClose(timeoutMs);
    return this.closeOperation;
  }

  private async performAuthentication(secret: Uint8Array): Promise<void> {
    try {
      if (this.failed) {
        throw this.failed;
      }
      const challenge =
        this.challenge ??
        (await waitWithTimeout(
          this.challengePromise,
          DEFAULT_RPC_TIMEOUT_MS,
          timeoutError(
            'RPC_AUTH_TIMEOUT',
            'Timed out waiting for the daemon authentication challenge',
          ),
        ));
      const response = await this.send(
        this.createRequest('auth.respond', {
          nonce: challenge.payload.nonce,
          mac: createAuthMac(secret, challenge.payload.nonce),
        }),
      );

      if (!response.ok) {
        throw new DaemonRpcClientError(
          'RPC_AUTH_FAILED',
          'Daemon RPC authentication failed',
        );
      }
      if (!AuthRespondResultSchema.safeParse(response.result).success) {
        throw new DaemonRpcClientError(
          'RPC_PROTOCOL_ERROR',
          'Daemon sent an invalid authentication response',
        );
      }

      this.authenticated = true;
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new DaemonRpcClientError(
              'RPC_AUTH_FAILED',
              'Daemon RPC authentication failed',
            );
      this.fail(failure);
      this.socket.destroy();
      throw this.failed;
    }
  }

  private handleData(chunk: Buffer): void {
    let values: unknown[];

    try {
      values = this.decoder.push(chunk);
    } catch (error) {
      this.fail(
        new DaemonRpcClientError(
          'RPC_PROTOCOL_ERROR',
          error instanceof FrameCodecError
            ? `Daemon sent an invalid RPC frame: ${error.reason}`
            : 'Daemon RPC frame decoder failed',
        ),
      );
      this.socket.destroy();
      return;
    }

    for (const value of values) {
      const envelope = RpcEnvelopeSchema.safeParse(value);
      if (!envelope.success) {
        this.fail(
          new DaemonRpcClientError(
            'RPC_PROTOCOL_ERROR',
            'Daemon sent an invalid RPC envelope',
          ),
        );
        this.socket.destroy();
        return;
      }

      if (
        envelope.data.kind === 'notification' &&
        envelope.data.method === 'auth.challenge'
      ) {
        const challenge = AuthChallengeNotificationSchema.safeParse(envelope.data);
        if (!challenge.success || this.challenge) {
          this.fail(
            new DaemonRpcClientError(
              'RPC_PROTOCOL_ERROR',
              'Daemon sent an invalid or duplicate authentication challenge',
            ),
          );
          this.socket.destroy();
          return;
        }

        this.challenge = challenge.data;
        this.resolveChallenge(challenge.data);
        continue;
      }

      if (envelope.data.kind !== 'response') {
        continue;
      }

      const response = RpcResponseSchema.safeParse(envelope.data);
      if (!response.success) {
        this.fail(
          new DaemonRpcClientError(
            'RPC_PROTOCOL_ERROR',
            'Daemon sent an invalid RPC response',
          ),
        );
        this.socket.destroy();
        return;
      }

      const pending = this.pendingResponses.get(response.data.requestId);
      if (!pending) {
        continue;
      }
      if (pending.method === 'auth.respond' && !response.data.ok) {
        this.fail(
          new DaemonRpcClientError(
            'RPC_AUTH_FAILED',
            'Daemon RPC authentication failed',
          ),
        );
        this.socket.destroy();
        return;
      }

      pending.resolve(response.data);
    }
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    if (this.socket.write(bytes)) {
      return;
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const finish = (action: () => void): void => {
        this.socket.off('drain', handleDrain);
        this.socket.off('close', handleClose);
        this.socket.off('error', handleError);
        action();
      };
      const handleDrain = (): void => finish(resolvePromise);
      const handleClose = (): void =>
        finish(() =>
          rejectPromise(
            this.failed ??
              new DaemonRpcClientError(
                'RPC_CONNECTION_CLOSED',
                'Daemon RPC connection closed during request write',
              ),
          ),
        );
      const handleError = (): void => handleClose();

      this.socket.once('drain', handleDrain);
      this.socket.once('close', handleClose);
      this.socket.once('error', handleError);
    });
  }

  private async performClose(timeoutMs: number): Promise<void> {
    this.closeStarted = true;
    this.fail(
      new DaemonRpcClientError(
        'RPC_CLIENT_CLOSED',
        'Daemon RPC client is closed',
      ),
    );

    try {
      if (!this.socket.destroyed) {
        this.socket.end();
      }
    } catch {
      const failure = new DaemonRpcClientError(
        'RPC_CLOSE_FAILED',
        'Unable to start daemon RPC socket shutdown',
      );
      this.socket.destroy();
      await this.socketClosePromise;
      throw failure;
    }

    try {
      await waitWithTimeout(
        this.socketClosePromise,
        timeoutMs,
        timeoutError('RPC_CLOSE_TIMEOUT', 'Timed out closing the daemon RPC socket'),
      );
    } catch (error) {
      this.socket.destroy();
      await this.socketClosePromise;
      throw error;
    }
  }

  private fail(error: Error): void {
    if (this.failed) {
      return;
    }

    this.failed = error;
    this.rejectChallenge(error);
    for (const pending of this.pendingResponses.values()) {
      pending.reject(error);
    }
  }
}

export const connectDaemonRpcClient = async (
  socketPath: string,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<DaemonRpcClient> => {
  const socket = createConnection({ path: socketPath });
  const client = new DaemonRpcClient(socket);

  const connected = new Promise<void>((resolvePromise, rejectPromise) => {
    const finish = (action: () => void): void => {
      socket.off('connect', handleConnect);
      socket.off('error', handleError);
      action();
    };
    const handleConnect = (): void => finish(resolvePromise);
    const handleError = (): void =>
      finish(() =>
        rejectPromise(
          new DaemonRpcClientError(
            'RPC_CONNECTION_FAILED',
            'Unable to connect to the daemon RPC socket',
          ),
        ),
      );

    socket.once('connect', handleConnect);
    socket.once('error', handleError);
  });

  try {
    await waitWithTimeout(
      connected,
      timeoutMs,
      timeoutError(
        'RPC_CONNECTION_TIMEOUT',
        'Timed out connecting to the daemon RPC socket',
      ),
    );
    return client;
  } catch (error) {
    socket.destroy();
    throw error;
  }
};
