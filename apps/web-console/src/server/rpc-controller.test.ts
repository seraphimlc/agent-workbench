import { describe, expect, it } from 'vitest';

type Request = {
  readonly requestId: string;
  readonly method: string;
  readonly payload: unknown;
  readonly clientRequestId: string | null;
};

type Client = {
  authenticate(secret: Uint8Array): Promise<void>;
  createRequest(
    method: string,
    payload: unknown,
    options?: { readonly clientRequestId?: string },
  ): Request;
  send(request: Request): Promise<unknown>;
  close(): Promise<void>;
};

type RpcControllerModule = {
  RpcController: new (options: {
    readonly initialClient: Client;
    readonly connect: (socketPath: string) => Promise<Client>;
    readonly socketPath: string;
    readonly authenticationSecret: Buffer;
    readonly sleep: (milliseconds: number) => Promise<void>;
  }) => {
    call(input: {
      readonly method: string;
      readonly payload: unknown;
      readonly clientRequestId?: string;
    }): Promise<unknown>;
    close(): Promise<void>;
  };
};

const loadController = async (): Promise<RpcControllerModule> =>
  (await import('./rpc-controller.js')) as unknown as RpcControllerModule;

const connectionClosed = () =>
  Object.assign(new Error('connection closed'), {
    code: 'RPC_CONNECTION_CLOSED',
  });

const protocolError = () =>
  Object.assign(new Error('protocol failed'), { code: 'RPC_PROTOCOL_ERROR' });

const successResponse = (request: Request, result: unknown) => ({
  kind: 'response',
  protocolVersion: 1,
  requestId: request.requestId,
  traceId: 'trace-1',
  ok: true,
  result,
});

const deferred = <Value>() => {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

describe('RpcController', () => {
  it('retries a connection failure once with the exact same request object', async () => {
    const { RpcController } = await loadController();
    const sent: Request[] = [];
    let requestSequence = 0;
    let reconnects = 0;
    let replacementAuthentications = 0;
    const createRequest = (
      method: string,
      payload: unknown,
      options: { readonly clientRequestId?: string } = {},
    ): Request => ({
      requestId: `request-${++requestSequence}`,
      method,
      payload,
      clientRequestId: options.clientRequestId ?? null,
    });
    const initial: Client = {
      authenticate: async () => undefined,
      createRequest,
      send: async (request) => {
        sent.push(request);
        throw connectionClosed();
      },
      close: async () => undefined,
    };
    const replacement: Client = {
      authenticate: async (secret) => {
        replacementAuthentications += 1;
        expect(Buffer.from(secret)).toEqual(Buffer.alloc(32, 4));
      },
      createRequest,
      send: async (request) => {
        sent.push(request);
        return successResponse(request, {
          sessionId: 'session-1',
          turnId: 'turn-1',
        });
      },
      close: async () => undefined,
    };
    const controller = new RpcController({
      initialClient: initial,
      connect: async () => {
        reconnects += 1;
        return replacement;
      },
      socketPath: '/tmp/daemon.sock',
      authenticationSecret: Buffer.alloc(32, 4),
      sleep: async () => undefined,
    });

    const result = await controller.call({
      method: 'session.create',
      payload: {
        workspaceId: 'workspace-1',
        title: 'Read README.md',
        prompt: 'Read README.md',
      },
      clientRequestId: 'web:session:123e4567-e89b-42d3-a456-426614174000',
    });

    expect(result).toEqual({
      ok: true,
      result: { sessionId: 'session-1', turnId: 'turn-1' },
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(sent[0]?.clientRequestId).toBe(
      'web:session:123e4567-e89b-42d3-a456-426614174000',
    );
    expect(reconnects).toBe(1);
    expect(replacementAuthentications).toBe(1);
    await controller.close();
  });

  it('does not reconnect or retry non-connection failures', async () => {
    const { RpcController } = await loadController();
    const failure = protocolError();
    let reconnects = 0;
    let sends = 0;
    const initial: Client = {
      authenticate: async () => undefined,
      createRequest: (method, payload) => ({
        requestId: 'request-1',
        method,
        payload,
        clientRequestId: null,
      }),
      send: async () => {
        sends += 1;
        throw failure;
      },
      close: async () => undefined,
    };
    const controller = new RpcController({
      initialClient: initial,
      connect: async () => {
        reconnects += 1;
        return initial;
      },
      socketPath: '/tmp/daemon.sock',
      authenticationSecret: Buffer.alloc(32, 4),
      sleep: async () => undefined,
    });

    await expect(
      controller.call({ method: 'app.health', payload: {} }),
    ).rejects.toBe(failure);
    expect(sends).toBe(1);
    expect(reconnects).toBe(0);
    await controller.close();
  });

  it('shares one reconnect across concurrent connection failures', async () => {
    const { RpcController } = await loadController();
    const firstFailure = deferred<unknown>();
    const secondFailure = deferred<unknown>();
    const failures = [firstFailure, secondFailure];
    let reconnects = 0;
    let requestSequence = 0;
    const createRequest = (method: string, payload: unknown): Request => ({
      requestId: `request-${++requestSequence}`,
      method,
      payload,
      clientRequestId: null,
    });
    const initial: Client = {
      authenticate: async () => undefined,
      createRequest,
      send: async () => await failures.shift()!.promise,
      close: async () => undefined,
    };
    const replacement: Client = {
      authenticate: async () => undefined,
      createRequest,
      send: async (request) => successResponse(request, { status: 'ready' }),
      close: async () => undefined,
    };
    const controller = new RpcController({
      initialClient: initial,
      connect: async () => {
        reconnects += 1;
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        return replacement;
      },
      socketPath: '/tmp/daemon.sock',
      authenticationSecret: Buffer.alloc(32, 4),
      sleep: async () => undefined,
    });

    const first = controller.call({ method: 'app.health', payload: {} });
    const second = controller.call({ method: 'app.health', payload: {} });
    firstFailure.reject(connectionClosed());
    secondFailure.reject(connectionClosed());

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, result: { status: 'ready' } },
      { ok: true, result: { status: 'ready' } },
    ]);
    expect(reconnects).toBe(1);
    await controller.close();
  });

  it('does not replace or close a newer generation after an old late failure', async () => {
    const { RpcController } = await loadController();
    const lateFailure = deferred<unknown>();
    let reconnects = 0;
    let replacementCloses = 0;
    let requestSequence = 0;
    const createRequest = (method: string, payload: unknown): Request => ({
      requestId: `request-${++requestSequence}`,
      method,
      payload,
      clientRequestId: null,
    });
    const initial: Client = {
      authenticate: async () => undefined,
      createRequest,
      send: async (request) => {
        if (request.payload === 'late') return await lateFailure.promise;
        throw connectionClosed();
      },
      close: async () => undefined,
    };
    const replacement: Client = {
      authenticate: async () => undefined,
      createRequest,
      send: async (request) => successResponse(request, request.payload),
      close: async () => {
        replacementCloses += 1;
      },
    };
    const controller = new RpcController({
      initialClient: initial,
      connect: async () => {
        reconnects += 1;
        return replacement;
      },
      socketPath: '/tmp/daemon.sock',
      authenticationSecret: Buffer.alloc(32, 4),
      sleep: async () => undefined,
    });

    const late = controller.call({ method: 'app.health', payload: 'late' });
    await expect(
      controller.call({ method: 'app.health', payload: 'fast' }),
    ).resolves.toEqual({ ok: true, result: 'fast' });
    lateFailure.reject(connectionClosed());

    await expect(late).resolves.toEqual({ ok: true, result: 'late' });
    expect(reconnects).toBe(1);
    expect(replacementCloses).toBe(0);
    await controller.close();
    expect(replacementCloses).toBe(1);
  });
});
