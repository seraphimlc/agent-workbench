import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempRuntime,
  DaemonProcess,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import {
  createAuthMac,
  connectRpcClient,
  RpcClient,
} from '../../packages/testkit/src/rpc-client.js';
import type {
  RpcRequest,
  RpcRequestEnvelope,
  RpcResponse,
} from '@agent-workbench/protocol';
import { computeAuthMac } from '../../services/daemon/src/rpc/authenticator.js';
import { DaemonServer } from '../../services/daemon/src/server.js';

const permissionBits = (path: string): number => lstatSync(path).mode & 0o777;
const daemonEntryPoint = fileURLToPath(
  new URL('../../services/daemon/src/index.ts', import.meta.url),
);
const tsxImport = import.meta.resolve('tsx');
const spawnDaemonWithRawOptions = (
  runtime: TempRuntime,
  daemonOptions: readonly string[],
  bootstrapSecret = Buffer.alloc(32, 0x71),
): DaemonProcess => {
  const launchArguments = [
    '--conditions=development',
    '--import',
    tsxImport,
    daemonEntryPoint,
    ...daemonOptions,
  ];
  const child = spawn(process.execPath, launchArguments, {
    cwd: runtime.rootDir,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const daemon = new DaemonProcess(
    child,
    bootstrapSecret,
    launchArguments,
    process.env,
  );
  const secretPipe = child.stdio[3] as Writable;
  secretPipe.end(bootstrapSecret);
  return daemon;
};
const connectAllowHalfOpenRpcClient = async (
  socketPath: string,
): Promise<{ readonly client: RpcClient; readonly socket: Socket }> => {
  const socket = createConnection({ path: socketPath, allowHalfOpen: true });
  const rpcClient = new RpcClient(socket);
  await once(socket, 'connect');
  return { client: rpcClient, socket };
};
const waitForCondition = async (
  condition: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
};
const serverConnectionCount = (server: DaemonServer): number =>
  (
    server as unknown as {
      readonly connections: ReadonlySet<Socket>;
    }
  ).connections.size;
const expectNoDaemonRuntimeState = (runtime: TempRuntime): void => {
  expect(readdirSync(runtime.dataDir)).toEqual([]);
  expect(existsSync(runtime.socketPath)).toBe(false);
};

const expectAuthFailure = (
  response: RpcResponse,
  request: RpcRequestEnvelope,
): void => {
  expect(response).toEqual({
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
  });
};

describe('daemon authentication', () => {
  let runtime: TempRuntime | undefined;
  let client: RpcClient | undefined;
  let allowHalfOpenSocket: Socket | undefined;
  let directServer: DaemonServer | undefined;

  afterEach(async () => {
    allowHalfOpenSocket?.destroy();
    allowHalfOpenSocket = undefined;
    await client?.close();
    client = undefined;
    await directServer?.stop();
    directServer = undefined;
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('matches an independently fixed HMAC-SHA256 nonce-plus-version vector', () => {
    const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const nonce = 'fixed-nonce-0123456789';
    const expected =
      '9378bbf324601e1ee84f5783928c88b7b46703a566451003dde0f78a0da46996';

    expect(createAuthMac(secret, nonce)).toBe(expected);
    expect(computeAuthMac(secret, nonce).toString('hex')).toBe(expected);
  });

  it('creates isolated runtime fixtures only under the operating-system temp directory', () => {
    runtime = createTempRuntime();

    const tempRoot = realpathSync(tmpdir());
    const fixtureRoot = realpathSync(runtime.rootDir);
    const relation = relative(tempRoot, fixtureRoot);

    expect(relation).not.toBe('');
    expect(relation.startsWith('..')).toBe(false);
    expect(resolve(tempRoot, relation)).toBe(fixtureRoot);
    expect(permissionBits(runtime.dataDir)).toBe(0o700);
    expect(permissionBits(runtime.runtimeDir)).toBe(0o700);
  });

  it('spawns native Node with development exports and transports the bootstrap secret only on fd 3', async () => {
    runtime = createTempRuntime();
    const bootstrapSecret = Buffer.alloc(32, 0x73);
    const daemon = runtime.spawnDaemon({
      bootstrapSecret,
      entryPoint: daemonEntryPoint,
    });
    const secretText = bootstrapSecret.toString('utf8');

    expect(daemon.launchArguments).toEqual(
      expect.arrayContaining([
        '--conditions=development',
        '--import',
        'tsx',
        expect.stringMatching(/services\/daemon\/src\/index\.ts$/),
        '--socket',
        runtime.socketPath,
        '--data-dir',
        runtime.dataDir,
      ]),
    );
    expect(daemon.launchArguments.join('\u0000')).not.toContain(secretText);
    expect(Object.values(daemon.launchEnvironment).join('\u0000')).not.toContain(
      secretText,
    );
    expect(daemon.child.stdio[3]).not.toBeNull();

    await daemon.stop('SIGKILL');
  });

  it('sends exactly one challenge, authenticates the correct HMAC, and secures the socket boundary', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();

    client = await connectRpcClient(runtime.socketPath);
    const challenge = await client.waitForChallenge();

    expect(client.receivedEnvelopes).toEqual([challenge]);
    expect(challenge).toMatchObject({
      kind: 'notification',
      protocolVersion: 1,
      method: 'auth.challenge',
      payload: { nonce: expect.any(String) },
    });
    expect(challenge.payload.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(permissionBits(runtime.runtimeDir)).toBe(0o700);
    expect(permissionBits(runtime.socketPath)).toBe(0o600);

    const response = await client.authenticate(daemon.bootstrapSecret);

    expect(response).toMatchObject({
      kind: 'response',
      protocolVersion: 1,
      ok: true,
      result: { authenticated: true },
    });
  });

  it('rejects a pre-authentication health request canonically and closes without routing it', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();

    const request = client.createRequest('app.health', {});
    const response = await client.sendRequest(request);

    expectAuthFailure(response, request);
    await client.waitForClose();
  });

  it.each([
    ['session.list', {}, null, null],
    ['turn.cancel', { sessionId: 'session-1', turnId: 'turn-1' }, 'session-1', 'cancel-key'],
  ])(
    'rejects unauthenticated %s before it can read, mutate, or wake execution',
    async (method, payload, sessionId, clientRequestId) => {
      runtime = createTempRuntime();
      const daemon = runtime.spawnDaemon();
      await daemon.waitForReady();
      client = await connectRpcClient(runtime.socketPath);
      await client.waitForChallenge();
      const request = {
        ...client.createRequest(method as 'session.list' | 'turn.cancel', payload),
        sessionId,
        clientRequestId,
      };

      const response = await client.sendRequest(request);

      expectAuthFailure(response, request);
      await client.waitForClose();
    },
  );

  it('full-closes an allow-half-open peer after flushing a canonical authentication failure', async () => {
    runtime = createTempRuntime();
    directServer = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: Buffer.alloc(32, 0x41),
    });
    await directServer.start();
    const connection = await connectAllowHalfOpenRpcClient(runtime.socketPath);
    client = connection.client;
    allowHalfOpenSocket = connection.socket;
    await client.waitForChallenge();

    const request = client.createRequest('app.health', {});
    const response = await client.sendRequest(request);

    expectAuthFailure(response, request);
    expect(allowHalfOpenSocket.writableEnded).toBe(false);
    await waitForCondition(
      () => serverConnectionCount(directServer as DaemonServer) === 0,
      'server authentication-failure connection cleanup',
    );
  });

  it('consumes the nonce on a wrong MAC and returns no retryable authentication detail', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    const challenge = await client.waitForChallenge();
    const request = client.createRequest('auth.respond', {
      nonce: challenge.payload.nonce,
      mac: '00'.repeat(32),
    });

    const response = await client.sendRequest(request);

    expectAuthFailure(response, request);
    await client.waitForClose();
  });

  it('rejects a noncanonical MAC encoding and closes permanently', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    const challenge = await client.waitForChallenge();
    const request = client.createRequest('auth.respond', {
      nonce: challenge.payload.nonce,
      mac: 'A'.repeat(64),
    });

    const response = await client.sendRequest(request);

    expectAuthFailure(response, request);
    await client.waitForClose();
  });

  it('rejects a second authentication response as a replay and closes the connection', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    const challenge = await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);
    const replay = client.createRequest('auth.respond', {
      nonce: challenge.payload.nonce,
      mac: createAuthMac(daemon.bootstrapSecret, challenge.payload.nonce),
    });

    const response = await client.sendRequest(replay);

    expectAuthFailure(response, replay);
    await client.waitForClose();
  });

  it('rejects a nonce and MAC from an older connection', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const firstClient = await connectRpcClient(runtime.socketPath);
    const oldChallenge = await firstClient.waitForChallenge();
    await firstClient.close();

    client = await connectRpcClient(runtime.socketPath);
    const newChallenge = await client.waitForChallenge();
    expect(newChallenge.payload.nonce).not.toBe(oldChallenge.payload.nonce);
    const replay = client.createRequest('auth.respond', {
      nonce: oldChallenge.payload.nonce,
      mac: createAuthMac(daemon.bootstrapSecret, oldChallenge.payload.nonce),
    });

    const response = await client.sendRequest(replay);

    expectAuthFailure(response, replay);
    await client.waitForClose();
  });

  it('processes a correct authentication response before health from the same batch', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    const challenge = await client.waitForChallenge();
    const authentication = client.createRequest('auth.respond', {
      nonce: challenge.payload.nonce,
      mac: createAuthMac(daemon.bootstrapSecret, challenge.payload.nonce),
    });
    const health = client.createRequest('app.health', {});

    const [authenticationResponse, healthResponse] = await client.sendBatch([
      authentication,
      health,
    ]);

    expect(authenticationResponse).toMatchObject({
      requestId: authentication.requestId,
      ok: true,
      result: { authenticated: true },
    });
    expect(healthResponse).toMatchObject({
      requestId: health.requestId,
      ok: true,
      result: { status: 'ready', protocolVersion: 1 },
    });
  });

  it('consumes a wrong authentication attempt and ignores a correct replay in the same batch', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    const challenge = await client.waitForChallenge();
    const wrong = client.createRequest('auth.respond', {
      nonce: challenge.payload.nonce,
      mac: '00'.repeat(32),
    });
    const replay = client.createRequest('auth.respond', {
      nonce: challenge.payload.nonce,
      mac: createAuthMac(daemon.bootstrapSecret, challenge.payload.nonce),
    });

    const [wrongResult, replayResult] = await client.sendBatchSettled([
      wrong,
      replay,
    ]);

    expect(wrongResult).toMatchObject({
      status: 'fulfilled',
      value: { requestId: wrong.requestId, ok: false },
    });
    expect(replayResult?.status).toBe('rejected');
    expect(
      client.receivedEnvelopes.filter(
        (envelope) => envelope.kind === 'response' && envelope.requestId === replay.requestId,
      ),
    ).toHaveLength(0);
    await client.waitForClose();
  });

  it.each([31, 33])(
    'fails startup when fd 3 contains %i bytes instead of exactly 32 plus EOF',
    async (secretLength) => {
      runtime = createTempRuntime();
      const invalidSecret = Buffer.alloc(secretLength, 0x66);
      const daemon = runtime.spawnDaemon({
        bootstrapSecret: invalidSecret,
      });

      const exit = await daemon.waitForExit(1_500);

      expect(exit.code).not.toBe(0);
      expectNoDaemonRuntimeState(runtime);
      const output = `${daemon.stdout}\n${daemon.stderr}`;
      expect(output).not.toContain(invalidSecret.toString('utf8'));
      expect(output).not.toContain(invalidSecret.toString('hex'));
      expect(output).not.toContain(invalidSecret.toString('base64'));
    },
  );

  it('accepts an exactly 32-byte fd 3 secret fragmented across writes before EOF', async () => {
    runtime = createTempRuntime();
    const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
    const daemon = runtime.spawnDaemon({
      bootstrapSecretChunks: [
        secret.subarray(0, 1),
        secret.subarray(1, 9),
        secret.subarray(9, 17),
        secret.subarray(17),
      ],
    });

    expect(daemon.bootstrapSecret).toEqual(secret);
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    const response = await client.authenticate(secret);
    expect(response).toMatchObject({ ok: true, result: { authenticated: true } });
  });

  it('fails startup when fd 3 is missing', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon({ omitBootstrapFd: true });

    const exit = await daemon.waitForExit(1_500);

    expect(exit.code).not.toBe(0);
    expectNoDaemonRuntimeState(runtime);
  });

  it.each([
    ['split', ['--bootstrap-secret', 'forbidden-argv-value']],
    ['equals', ['--bootstrap-secret=forbidden-argv-value']],
  ])(
    'rejects the %s argv bootstrap-secret transport without echoing its value',
    async (_form, additionalArguments) => {
      runtime = createTempRuntime();
      const daemon = runtime.spawnDaemon({ additionalArguments });

      const exit = await daemon.waitForExit(1_500);

      expect(exit.code).not.toBe(0);
      expect(`${daemon.stdout}\n${daemon.stderr}`).not.toContain(
        'forbidden-argv-value',
      );
      expectNoDaemonRuntimeState(runtime);
    },
  );

  it('rejects a forbidden bootstrap-secret token consumed as the --socket value before creating runtime state', async () => {
    runtime = createTempRuntime();
    const forbiddenValue = '--bootstrap-secret=forbidden-argv-value';
    const daemon = spawnDaemonWithRawOptions(runtime, [
      '--socket',
      forbiddenValue,
      '--data-dir',
      runtime.dataDir,
    ]);

    try {
      const exit = await daemon.waitForExit(1_500);

      expect(exit.code).not.toBe(0);
      expect(readdirSync(runtime.dataDir)).toEqual([]);
      expect(existsSync(join(runtime.rootDir, forbiddenValue))).toBe(false);
      const output = `${daemon.stdout}\n${daemon.stderr}`;
      expect(output).not.toContain('forbidden-argv-value');
      expect(output).not.toContain(
        Buffer.from('forbidden-argv-value').toString('hex'),
      );
      expect(output).not.toContain(
        Buffer.from('forbidden-argv-value').toString('base64'),
      );
    } finally {
      await daemon.stop('SIGKILL');
    }
  });

  it('rejects an option token consumed as a separated daemon option value', async () => {
    runtime = createTempRuntime();
    const disguisedSocketValue = '--data-dir';
    const daemon = spawnDaemonWithRawOptions(runtime, [
      '--socket',
      disguisedSocketValue,
      '--data-dir',
      runtime.dataDir,
    ]);

    try {
      const exit = await daemon.waitForExit(1_500);

      expect(exit.code).not.toBe(0);
      expect(readdirSync(runtime.dataDir)).toEqual([]);
      expect(existsSync(join(runtime.rootDir, disguisedSocketValue))).toBe(false);
    } finally {
      await daemon.stop('SIGKILL');
    }
  });

  it.each([
    'AGENT_WORKBENCH_BOOTSTRAP_SECRET',
    'AGENT_BOOTSTRAP_RPC_SECRET',
    'rpc_bootstrap_secret',
    'Rpc-Bootstrap-Secret',
  ])(
    'rejects bootstrap-secret-intent environment key %s without echoing its value',
    async (environmentKey) => {
      runtime = createTempRuntime();
      const daemon = runtime.spawnDaemon({
        environment: { [environmentKey]: 'forbidden-environment-value' },
      });

      const exit = await daemon.waitForExit(1_500);

      expect(exit.code).not.toBe(0);
      expect(`${daemon.stdout}\n${daemon.stderr}`).not.toContain(
        'forbidden-environment-value',
      );
      expectNoDaemonRuntimeState(runtime);
    },
  );

  it('does not reject an unrelated environment secret', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon({
      environment: { DATABASE_SECRET: 'unrelated-environment-value' },
    });

    await daemon.waitForReady();

    expect(existsSync(runtime.socketPath)).toBe(true);
  });

  it('rejects the first overflow above 128 in-flight requests without queuing more work', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);
    const requests = Array.from({ length: 129 }, () =>
      client?.createRequest('app.health', {}),
    ).filter((request): request is RpcRequestEnvelope => request !== undefined);

    const responses = await client.sendBatch(requests);
    const overflowResponses = responses.filter(
      (response) => !response.ok && response.error.code === 'RPC_BACKPRESSURE',
    );
    const acceptedResponses = responses.filter((response) => response.ok);

    expect(requests).toHaveLength(129);
    expect(overflowResponses, daemon.stderr).toHaveLength(1);
    expect(acceptedResponses).toHaveLength(128);
    for (const response of overflowResponses) {
      expect(response.error.retryable).toBe(true);
      expect(response.error.traceId).toBe(response.traceId);
    }
    await client.waitForClose();
  });

  it('full-closes an allow-half-open peer after flushing the overflow response', async () => {
    runtime = createTempRuntime();
    const bootstrapSecret = Buffer.alloc(32, 0x42);
    const pendingHealthHandlers: Array<() => void> = [];
    directServer = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret,
    });
    const router = (
      directServer as unknown as {
        readonly router: {
          handle(request: RpcRequest): Promise<unknown>;
        };
      }
    ).router;
    router.handle = async (request: RpcRequest): Promise<unknown> => {
      if (request.method !== 'app.health') {
        throw new Error('Unexpected routed method in overflow test');
      }
      await new Promise<void>((resolvePromise) => {
        pendingHealthHandlers.push(resolvePromise);
      });
      return {
        status: 'ready',
        protocolVersion: 1,
        pid: process.pid,
      };
    };
    await directServer.start();
    const connection = await connectAllowHalfOpenRpcClient(runtime.socketPath);
    client = connection.client;
    allowHalfOpenSocket = connection.socket;
    await client.waitForChallenge();
    await client.authenticate(bootstrapSecret);
    const requests = Array.from({ length: 129 }, () =>
      client?.createRequest('app.health', {}),
    ).filter((request): request is RpcRequestEnvelope => request !== undefined);

    const batchResponses = client.sendBatch(requests);
    try {
      await waitForCondition(
        () =>
          client?.receivedEnvelopes.some(
            (envelope) =>
              envelope.kind === 'response' &&
              !envelope.ok &&
              envelope.error.code === 'RPC_BACKPRESSURE',
          ) === true,
        'overflow response while accepted requests remain in flight',
      );
      await waitForCondition(
        () => pendingHealthHandlers.length === 128,
        'all accepted health handlers to be deferred',
      );
      let expectedSuccessfulResponses = client.receivedEnvelopes.filter(
        (envelope) => envelope.kind === 'response' && envelope.ok,
      ).length;
      while (pendingHealthHandlers.length > 0) {
        const releaseBatch = pendingHealthHandlers.splice(0, 4);
        expectedSuccessfulResponses += releaseBatch.length;
        for (const releaseHandler of releaseBatch) {
          releaseHandler();
        }
        await waitForCondition(
          () =>
            client?.receivedEnvelopes.filter(
              (envelope) => envelope.kind === 'response' && envelope.ok,
            ).length === expectedSuccessfulResponses,
          'released health responses to flush',
        );
      }
    } finally {
      for (const releaseHandler of pendingHealthHandlers.splice(0)) {
        releaseHandler();
      }
    }
    const responses = await batchResponses;

    expect(
      responses.filter(
        (response) => !response.ok && response.error.code === 'RPC_BACKPRESSURE',
      ),
    ).toHaveLength(1);
    expect(allowHalfOpenSocket.writableEnded).toBe(false);
    await waitForCondition(
      () => serverConnectionCount(directServer as DaemonServer) === 0,
      'server overflow connection cleanup',
    );
  });
});
