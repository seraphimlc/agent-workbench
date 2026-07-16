import {
  RpcMethodSchema,
  type RpcMethod,
  type RpcRequestEnvelope,
  type RpcResponse,
} from '@agent-workbench/protocol';

import {
  type DaemonRpcClient,
  type DaemonRpcRequestOptions,
} from './daemon-rpc-client.js';
import {
  type HttpApiRpc,
  type HttpApiRpcCall,
  type HttpApiRpcReply,
  HttpApiRpcUnavailableError,
} from './http-api.js';

const MAX_RPC_RECONNECT_ATTEMPTS = 3;
const RPC_RECONNECT_DELAY_MS = 25;

export type RpcControllerClient = Pick<
  DaemonRpcClient,
  'authenticate' | 'createRequest' | 'send' | 'close'
>;

type ClientGeneration = {
  readonly id: number;
  readonly client: RpcControllerClient;
};

export type RpcControllerOptions = {
  readonly initialClient: RpcControllerClient;
  readonly connect: (socketPath: string) => Promise<RpcControllerClient>;
  readonly socketPath: string;
  readonly authenticationSecret: Buffer;
  readonly sleep: (milliseconds: number) => Promise<void>;
};

const connectionErrorCodes = new Set([
  'RPC_CONNECTION_FAILED',
  'RPC_CONNECTION_TIMEOUT',
  'RPC_CONNECTION_CLOSED',
  'RPC_CLIENT_CLOSED',
  'RPC_NOT_AUTHENTICATED',
  'RPC_REQUEST_TIMEOUT',
]);

const isConnectionError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string' &&
  connectionErrorCodes.has(error.code);

const requestOptions = (input: HttpApiRpcCall): DaemonRpcRequestOptions => ({
  ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  ...(input.clientRequestId === undefined
    ? {}
    : { clientRequestId: input.clientRequestId }),
});

export class RpcController implements HttpApiRpc {
  private generationSequence = 1;
  private current: ClientGeneration | undefined;
  private reconnectPromise: Promise<ClientGeneration> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: RpcControllerOptions) {
    this.current = { id: this.generationSequence, client: options.initialClient };
  }

  async call(input: HttpApiRpcCall): Promise<HttpApiRpcReply> {
    const generation = await this.currentGeneration();
    const method: RpcMethod = RpcMethodSchema.parse(input.method);
    const request: RpcRequestEnvelope = generation.client.createRequest(
      method,
      input.payload,
      requestOptions(input),
    );
    const response = await this.send(request, generation);
    return response.ok
      ? { ok: true, result: response.result }
      : { ok: false, error: response.error };
  }

  async reconnect(): Promise<void> {
    await this.reconnectFrom(this.current);
  }

  async close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closePromise = (async () => {
        this.closed = true;
        await this.reconnectPromise?.catch(() => undefined);
        const current = this.current;
        this.current = undefined;
        await this.closeClient(current?.client);
        this.options.authenticationSecret.fill(0);
      })();
    }
    await this.closePromise;
  }

  private async send(
    request: RpcRequestEnvelope,
    generation: ClientGeneration,
  ): Promise<RpcResponse> {
    try {
      return await generation.client.send(request);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      const retryGeneration = await this.reconnectFrom(generation);
      try {
        return await retryGeneration.client.send(request);
      } catch (retryError) {
        if (!isConnectionError(retryError)) throw retryError;
        if (this.current === retryGeneration) {
          this.current = undefined;
          await this.closeClient(retryGeneration.client);
        }
        throw new HttpApiRpcUnavailableError();
      }
    }
  }

  private async currentGeneration(): Promise<ClientGeneration> {
    if (this.closed) throw new HttpApiRpcUnavailableError();
    return this.current ?? (await this.reconnectFrom(undefined));
  }

  private async reconnectFrom(
    failedGeneration: ClientGeneration | undefined,
  ): Promise<ClientGeneration> {
    if (this.closed) throw new HttpApiRpcUnavailableError();
    if (
      failedGeneration !== undefined &&
      this.current !== undefined &&
      this.current !== failedGeneration
    ) {
      return this.current;
    }
    if (this.reconnectPromise === undefined) {
      const operation = this.performReconnect(failedGeneration);
      this.reconnectPromise = operation;
      void operation.then(
        () => this.clearReconnect(operation),
        () => this.clearReconnect(operation),
      );
    }
    return await this.reconnectPromise;
  }

  private async performReconnect(
    failedGeneration: ClientGeneration | undefined,
  ): Promise<ClientGeneration> {
    for (let attempt = 0; attempt < MAX_RPC_RECONNECT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await this.options.sleep(RPC_RECONNECT_DELAY_MS);
      let candidate: RpcControllerClient | undefined;
      try {
        candidate = await this.options.connect(this.options.socketPath);
        await candidate.authenticate(this.options.authenticationSecret);
        if (this.closed) {
          await this.closeClient(candidate);
          throw new HttpApiRpcUnavailableError();
        }
        if (
          failedGeneration !== undefined &&
          this.current !== undefined &&
          this.current !== failedGeneration
        ) {
          const current = this.current;
          await this.closeClient(candidate);
          return current;
        }
        const replacement = {
          id: ++this.generationSequence,
          client: candidate,
        };
        const previous = this.current;
        this.current = replacement;
        await this.closeClient(previous?.client);
        return replacement;
      } catch {
        await this.closeClient(candidate);
        if (this.closed) throw new HttpApiRpcUnavailableError();
      }
    }
    if (
      failedGeneration !== undefined &&
      this.current !== undefined &&
      this.current !== failedGeneration
    ) {
      return this.current;
    }
    throw new HttpApiRpcUnavailableError();
  }

  private clearReconnect(operation: Promise<ClientGeneration>): void {
    if (this.reconnectPromise === operation) this.reconnectPromise = undefined;
  }

  private async closeClient(
    client: RpcControllerClient | undefined,
  ): Promise<void> {
    if (client === undefined) return;
    await client.close().catch(() => undefined);
  }
}
