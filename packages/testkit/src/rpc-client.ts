import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';

import {
  AuthChallengeNotificationSchema,
  encodeFrame,
  FrameCodecError,
  FrameDecoder,
  MAX_FRAME_BYTES,
  RpcEnvelopeSchema,
  RpcResponseSchema,
  type RpcEnvelope,
  type RpcMethod,
  type RpcRequestEnvelope,
  type RpcResponse,
} from '@agent-workbench/protocol';

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const MAX_RECEIVED_ENVELOPES = 1_024;
const MAX_CAPTURED_ENVELOPE_BYTES = 2 * MAX_FRAME_BYTES;

export type AuthChallengeNotification = ReturnType<
  typeof AuthChallengeNotificationSchema.parse
>;

const withFailureGuard = async <T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<T> =>
  await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for ${description}`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });

type PendingResponse = {
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
};

export const createAuthMac = (secret: Uint8Array, nonce: string): string =>
  createHmac('sha256', secret).update(`${nonce}1`, 'utf8').digest('hex');

export class RpcClient {
  private readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly capturedEnvelopes: RpcEnvelope[] = [];
  private capturedEnvelopeBytes = 0;
  private readonly closePromise: Promise<void>;
  private readonly challengePromise: Promise<AuthChallengeNotification>;
  private resolveChallenge!: (challenge: AuthChallengeNotification) => void;
  private rejectChallenge!: (error: Error) => void;
  private challenge: AuthChallengeNotification | undefined;
  private failed: Error | undefined;

  constructor(socket: Socket) {
    this.socket = socket;
    this.challengePromise = new Promise((resolvePromise, rejectPromise) => {
      this.resolveChallenge = resolvePromise;
      this.rejectChallenge = rejectPromise;
    });
    void this.challengePromise.catch(() => {
      // A caller may only be interested in connection failure.
    });
    this.closePromise = new Promise((resolvePromise) => {
      socket.once('close', () => {
        resolvePromise();
      });
    });

    socket.on('data', (chunk: Buffer) => {
      this.handleData(chunk);
    });
    socket.on('error', (error: Error) => {
      this.fail(error);
    });
    socket.on('close', () => {
      this.fail(new Error('RPC connection closed'));
    });
  }

  get receivedEnvelopes(): readonly RpcEnvelope[] {
    return this.capturedEnvelopes;
  }

  createRequest(method: RpcMethod, payload: unknown): RpcRequestEnvelope {
    return {
      kind: 'request',
      protocolVersion: 1,
      requestId: randomUUID(),
      traceId: randomUUID(),
      sessionId: null,
      turnId: null,
      method,
      payload,
      clientRequestId: null,
    };
  }

  async waitForChallenge(
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<AuthChallengeNotification> {
    if (this.challenge) {
      return this.challenge;
    }

    return await withFailureGuard(
      this.challengePromise,
      'the daemon authentication challenge',
      timeoutMs,
    );
  }

  async authenticate(secret: Uint8Array): Promise<RpcResponse> {
    const challenge = await this.waitForChallenge();
    const mac = createAuthMac(secret, challenge.payload.nonce);
    const request = this.createRequest('auth.respond', {
      nonce: challenge.payload.nonce,
      mac,
    });

    return await this.sendRequest(request);
  }

  async sendRequest(
    request: RpcRequestEnvelope,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<RpcResponse> {
    if (this.failed) {
      throw this.failed;
    }

    if (this.pendingResponses.has(request.requestId)) {
      throw new Error('Duplicate RPC request id');
    }

    let pending!: PendingResponse;
    const responsePromise = new Promise<RpcResponse>((resolvePromise, rejectPromise) => {
      pending = { resolve: resolvePromise, reject: rejectPromise };
    });
    this.pendingResponses.set(request.requestId, pending);

    try {
      await this.writeFrame(request);
      return await withFailureGuard(
        responsePromise,
        `RPC response for ${request.requestId}`,
        timeoutMs,
      );
    } finally {
      this.pendingResponses.delete(request.requestId);
    }
  }

  async sendBatch(
    requests: readonly RpcRequestEnvelope[],
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<RpcResponse[]> {
    if (this.failed) {
      throw this.failed;
    }

    const requestIds = new Set<string>();
    const responsePromises: Promise<RpcResponse>[] = [];

    for (const request of requests) {
      if (
        requestIds.has(request.requestId) ||
        this.pendingResponses.has(request.requestId)
      ) {
        throw new Error('Duplicate RPC request id in batch');
      }
      requestIds.add(request.requestId);

      let pending!: PendingResponse;
      const responsePromise = new Promise<RpcResponse>(
        (resolvePromise, rejectPromise) => {
          pending = { resolve: resolvePromise, reject: rejectPromise };
        },
      );
      this.pendingResponses.set(request.requestId, pending);
      responsePromises.push(responsePromise);
    }

    try {
      if (requests.length > 0) {
        await this.writeBytes(Buffer.concat(requests.map((request) => encodeFrame(request))));
      }
      return await withFailureGuard(
        Promise.all(responsePromises),
        `RPC batch of ${requests.length} responses`,
        timeoutMs,
      );
    } finally {
      for (const requestId of requestIds) {
        this.pendingResponses.delete(requestId);
      }
    }
  }

  async sendBatchSettled(
    requests: readonly RpcRequestEnvelope[],
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<PromiseSettledResult<RpcResponse>[]> {
    if (this.failed) {
      throw this.failed;
    }

    const requestIds = new Set<string>();
    const responsePromises: Promise<RpcResponse>[] = [];

    for (const request of requests) {
      if (
        requestIds.has(request.requestId) ||
        this.pendingResponses.has(request.requestId)
      ) {
        throw new Error('Duplicate RPC request id in batch');
      }
      requestIds.add(request.requestId);

      let pending!: PendingResponse;
      const responsePromise = new Promise<RpcResponse>(
        (resolvePromise, rejectPromise) => {
          pending = { resolve: resolvePromise, reject: rejectPromise };
        },
      );
      this.pendingResponses.set(request.requestId, pending);
      responsePromises.push(responsePromise);
    }

    try {
      if (requests.length > 0) {
        await this.writeBytes(Buffer.concat(requests.map((request) => encodeFrame(request))));
      }
      return await withFailureGuard(
        Promise.allSettled(responsePromises),
        `settled RPC batch of ${requests.length} responses`,
        timeoutMs,
      );
    } finally {
      for (const requestId of requestIds) {
        this.pendingResponses.delete(requestId);
      }
    }
  }

  async close(timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<void> {
    if (this.socket.destroyed) {
      await withFailureGuard(this.closePromise, 'RPC socket close', timeoutMs);
      return;
    }

    this.socket.end();

    try {
      await withFailureGuard(this.closePromise, 'RPC socket close', timeoutMs);
    } catch (error) {
      this.socket.destroy();
      await withFailureGuard(this.closePromise, 'forced RPC socket close', timeoutMs);
      throw error;
    }
  }

  async waitForClose(timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<void> {
    await withFailureGuard(this.closePromise, 'RPC socket close', timeoutMs);
  }

  async writeRaw(bytes: Uint8Array): Promise<void> {
    await this.writeBytes(bytes);
  }

  private handleData(chunk: Buffer): void {
    let values: unknown[];

    try {
      values = this.decoder.push(chunk);
    } catch (error) {
      const failure =
        error instanceof FrameCodecError
          ? new Error(`Daemon sent an invalid RPC frame: ${error.reason}`)
          : new Error('Daemon RPC decoder failed');
      this.fail(failure);
      this.socket.destroy();
      return;
    }

    for (const value of values) {
      const parsedEnvelope = RpcEnvelopeSchema.safeParse(value);

      if (!parsedEnvelope.success) {
        this.fail(new Error('Daemon sent an invalid RPC envelope'));
        this.socket.destroy();
        return;
      }

      const envelope = parsedEnvelope.data;
      let envelopeBytes: number;
      try {
        envelopeBytes = encodeFrame(envelope).byteLength;
      } catch {
        this.fail(new Error('RPC client could not size a received envelope'));
        this.socket.destroy();
        return;
      }
      if (
        this.capturedEnvelopes.length >= MAX_RECEIVED_ENVELOPES ||
        this.capturedEnvelopeBytes + envelopeBytes > MAX_CAPTURED_ENVELOPE_BYTES
      ) {
        this.fail(new Error('RPC client envelope capture limit exceeded'));
        this.socket.destroy();
        return;
      }
      this.capturedEnvelopes.push(envelope);
      this.capturedEnvelopeBytes += envelopeBytes;

      if (envelope.kind === 'notification' && envelope.method === 'auth.challenge') {
        const parsedChallenge = AuthChallengeNotificationSchema.safeParse(envelope);

        if (!parsedChallenge.success || this.challenge) {
          this.fail(new Error('Daemon sent an invalid or duplicate authentication challenge'));
          this.socket.destroy();
          return;
        }

        this.challenge = parsedChallenge.data;
        this.resolveChallenge(parsedChallenge.data);
        continue;
      }

      if (envelope.kind === 'response') {
        const parsedResponse = RpcResponseSchema.safeParse(envelope);

        if (!parsedResponse.success) {
          this.fail(new Error('Daemon sent an invalid RPC response'));
          this.socket.destroy();
          return;
        }

        this.pendingResponses.get(parsedResponse.data.requestId)?.resolve(
          parsedResponse.data,
        );
      }
    }
  }

  private async writeFrame(value: unknown): Promise<void> {
    await this.writeBytes(encodeFrame(value));
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    const canContinue = this.socket.write(bytes);

    if (!canContinue) {
      await withFailureGuard(
        once(this.socket, 'drain').then(() => undefined),
        'RPC socket write drain',
      );
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

export const connectRpcClient = async (
  socketPath: string,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<RpcClient> => {
  const socket = createConnection(socketPath);
  const client = new RpcClient(socket);
  const connected = new Promise<void>((resolvePromise, rejectPromise) => {
    socket.once('connect', resolvePromise);
    socket.once('error', rejectPromise);
  });

  await withFailureGuard(connected, `RPC connection to ${socketPath}`, timeoutMs);
  return client;
};
