import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempRuntime,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import {
  createAuthMac,
  connectRpcClient,
  type RpcClient,
} from '../../packages/testkit/src/rpc-client.js';
import type {
  RpcRequestEnvelope,
  RpcResponse,
} from '@agent-workbench/protocol';
import { computeAuthMac } from '../../services/daemon/src/rpc/authenticator.js';

const permissionBits = (path: string): number => lstatSync(path).mode & 0o777;
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

  afterEach(async () => {
    await client?.close();
    client = undefined;
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
    const daemon = runtime.spawnDaemon({ bootstrapSecret });
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
});
