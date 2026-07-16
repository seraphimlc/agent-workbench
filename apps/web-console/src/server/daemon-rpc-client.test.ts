import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';

import {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_BYTES,
  RpcRequestSchema,
  type RpcRequest,
  type RpcRequestEnvelope,
  type RpcResponse,
} from '@agent-workbench/protocol';
import {
  createTempRuntime,
  type DaemonProcess,
  type TempRuntime,
} from '@agent-workbench/testkit/temp-runtime';
import { afterEach, describe, expect, it } from 'vitest';

type RequestOptions = {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly clientRequestId?: string;
};

type DaemonRpcClient = {
  createRequest(
    method: RpcRequest['method'],
    payload: unknown,
    options?: RequestOptions,
  ): RpcRequestEnvelope;
  authenticate(secret: Uint8Array): Promise<void>;
  send(request: RpcRequestEnvelope, timeoutMs?: number): Promise<RpcResponse>;
  close(timeoutMs?: number): Promise<void>;
};

type RpcClientModule = {
  connectDaemonRpcClient(socketPath: string, timeoutMs?: number): Promise<DaemonRpcClient>;
};

type FixtureBehavior =
  | 'respond'
  | 'ignore'
  | 'close'
  | 'invalid-response';

type RpcFixture = {
  readonly server: Server;
  readonly sockets: ReadonlySet<Socket>;
};

const loadRpcClient = async (): Promise<RpcClientModule> =>
  (await import('./daemon-rpc-client.js')) as unknown as RpcClientModule;

const fixtureSecret = Buffer.alloc(32, 0x5a);
const fixtureNonce = 'fixture-authentication-nonce';

const authMac = (secret: Uint8Array, nonce: string): string =>
  createHmac('sha256', secret).update(`${nonce}1`, 'utf8').digest('hex');

const startRpcFixture = async (
  socketPath: string,
  behavior: FixtureBehavior,
): Promise<RpcFixture> => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const decoder = new FrameDecoder();

    socket.on('data', (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) {
        const request = RpcRequestSchema.parse(value);
        if (request.method === 'auth.respond') {
          const authenticated =
            request.payload.nonce === fixtureNonce &&
            request.payload.mac === authMac(fixtureSecret, fixtureNonce);
          socket.write(
            encodeFrame(
              authenticated
                ? {
                    kind: 'response',
                    protocolVersion: 1,
                    requestId: request.requestId,
                    traceId: request.traceId,
                    ok: true,
                    result: { authenticated: true },
                  }
                : {
                    kind: 'response',
                    protocolVersion: 1,
                    requestId: request.requestId,
                    traceId: request.traceId,
                    ok: false,
                    error: {
                      code: 'RPC_AUTH_FAILED',
                      category: 'runtime',
                      message: 'RPC authentication failed',
                      retryable: false,
                      userAction: null,
                      detailsRef: null,
                      traceId: request.traceId,
                    },
                  },
            ),
          );
          return;
        }

        if (behavior === 'ignore') return;
        if (behavior === 'close') {
          socket.destroy();
          return;
        }
        if (behavior === 'invalid-response') {
          socket.write(
            encodeFrame({
              kind: 'response',
              protocolVersion: 1,
              requestId: request.requestId,
              traceId: request.traceId,
              ok: true,
            }),
          );
          return;
        }

        socket.write(
          encodeFrame({
            kind: 'response',
            protocolVersion: 1,
            requestId: request.requestId,
            traceId: request.traceId,
            ok: true,
            result: { status: 'ready', protocolVersion: 1, pid: process.pid },
          }),
        );
      }
    });

    socket.write(
      encodeFrame({
        kind: 'notification',
        protocolVersion: 1,
        traceId: 'fixture-challenge-trace',
        method: 'auth.challenge',
        payload: { nonce: fixtureNonce },
      }),
    );
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return { server, sockets };
};

const startOversizedFrameFixture = async (socketPath: string): Promise<RpcFixture> => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1);
    socket.write(header);
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return { server, sockets };
};

const stopRpcFixture = async (fixture: RpcFixture | undefined): Promise<void> => {
  if (!fixture) return;
  for (const socket of fixture.sockets) socket.destroy();
  if (!fixture.server.listening) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    fixture.server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
};

describe('production daemon RPC client', () => {
  let runtime: TempRuntime | undefined;
  let daemon: DaemonProcess | undefined;
  let client: DaemonRpcClient | undefined;
  let fixture: RpcFixture | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await stopRpcFixture(fixture);
    fixture = undefined;
    await daemon?.stop();
    daemon = undefined;
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('connects to the real daemon, authenticates, sends a request, and closes idempotently', async () => {
    runtime = createTempRuntime();
    daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const { connectDaemonRpcClient } = await loadRpcClient();
    client = await connectDaemonRpcClient(runtime.socketPath);

    await client.authenticate(daemon.bootstrapSecret);
    const request = client.createRequest('app.health', {});
    const response = await client.send(request);

    expect(response).toMatchObject({
      requestId: request.requestId,
      ok: true,
      result: { status: 'ready', protocolVersion: 1 },
    });
    await Promise.all([client.close(), client.close()]);
  });

  it('rejects a wrong bootstrap secret and permanently fails the connection', async () => {
    runtime = createTempRuntime();
    daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const { connectDaemonRpcClient } = await loadRpcClient();
    client = await connectDaemonRpcClient(runtime.socketPath);

    const authenticationError = await client
      .authenticate(Buffer.alloc(32, 0))
      .catch((error: unknown) => error);
    const laterError = await client
      .send(client.createRequest('app.health', {}))
      .catch((error: unknown) => error);

    expect(authenticationError).toMatchObject({ code: 'RPC_AUTH_FAILED' });
    expect(laterError).toBe(authenticationError);
  });

  it('times out an unanswered request and removes its pending request id', async () => {
    runtime = createTempRuntime();
    fixture = await startRpcFixture(runtime.socketPath, 'ignore');
    const { connectDaemonRpcClient } = await loadRpcClient();
    client = await connectDaemonRpcClient(runtime.socketPath);
    await client.authenticate(fixtureSecret);
    const request = client.createRequest('app.health', {});

    await expect(client.send(request, 50)).rejects.toMatchObject({
      code: 'RPC_REQUEST_TIMEOUT',
    });
    await expect(client.send(request, 50)).rejects.toMatchObject({
      code: 'RPC_REQUEST_TIMEOUT',
    });
  });

  it('rejects a duplicate in-flight request id without disturbing the original request', async () => {
    runtime = createTempRuntime();
    fixture = await startRpcFixture(runtime.socketPath, 'ignore');
    const { connectDaemonRpcClient } = await loadRpcClient();
    client = await connectDaemonRpcClient(runtime.socketPath);
    await client.authenticate(fixtureSecret);
    const request = client.createRequest('app.health', {});
    const original = client.send(request, 100);

    await expect(client.send(request, 100)).rejects.toMatchObject({
      code: 'RPC_DUPLICATE_REQUEST_ID',
    });
    await expect(original).rejects.toMatchObject({ code: 'RPC_REQUEST_TIMEOUT' });
  });

  it('rejects pending and future requests with the same failure when the connection closes', async () => {
    runtime = createTempRuntime();
    fixture = await startRpcFixture(runtime.socketPath, 'close');
    const { connectDaemonRpcClient } = await loadRpcClient();
    client = await connectDaemonRpcClient(runtime.socketPath);
    await client.authenticate(fixtureSecret);
    const firstError = await client
      .send(client.createRequest('app.health', {}), 500)
      .catch((error: unknown) => error);
    const laterError = await client
      .send(client.createRequest('app.health', {}), 500)
      .catch((error: unknown) => error);

    expect(firstError).toMatchObject({ code: 'RPC_CONNECTION_CLOSED' });
    expect(laterError).toBe(firstError);
  });

  it('fails closed when the daemon declares a frame above the protocol bound', async () => {
    runtime = createTempRuntime();
    fixture = await startOversizedFrameFixture(runtime.socketPath);
    const { connectDaemonRpcClient } = await loadRpcClient();
    client = await connectDaemonRpcClient(runtime.socketPath);

    await expect(client.authenticate(fixtureSecret)).rejects.toMatchObject({
      code: 'RPC_PROTOCOL_ERROR',
    });
  });

  it('fails closed when a response does not match the protocol response schema', async () => {
    runtime = createTempRuntime();
    fixture = await startRpcFixture(runtime.socketPath, 'invalid-response');
    const { connectDaemonRpcClient } = await loadRpcClient();
    client = await connectDaemonRpcClient(runtime.socketPath);
    await client.authenticate(fixtureSecret);

    await expect(
      client.send(client.createRequest('app.health', {}), 500),
    ).rejects.toMatchObject({ code: 'RPC_PROTOCOL_ERROR' });
  });
});
