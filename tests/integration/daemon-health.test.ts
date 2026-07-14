import { afterEach, describe, expect, it } from 'vitest';
import { encodeFrame } from '../../packages/protocol/src/index.js';

import {
  createTempRuntime,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import {
  connectRpcClient,
  type RpcClient,
} from '../../packages/testkit/src/rpc-client.js';

describe('daemon health', () => {
  let runtime: TempRuntime | undefined;
  let client: RpcClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('returns the exact ready result with request and trace correlation after authentication', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();

    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);

    const request = client.createRequest('app.health', {});
    const response = await client.sendRequest(request);

    expect(response).toEqual({
      kind: 'response',
      protocolVersion: 1,
      requestId: request.requestId,
      traceId: request.traceId,
      ok: true,
      result: {
        status: 'ready',
        protocolVersion: 1,
        pid: daemon.child.pid,
      },
    });
  });

  it('returns a correlated protocol error for an authenticated health contract violation', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);
    const invalidRequest = {
      ...client.createRequest('app.health', { unexpected: true }),
      clientRequestId: 'not-allowed-for-health',
    };

    const response = await client.sendRequest(invalidRequest);

    expect(response).toEqual({
      kind: 'response',
      protocolVersion: 1,
      requestId: invalidRequest.requestId,
      traceId: invalidRequest.traceId,
      ok: false,
      error: {
        code: 'RPC_PROTOCOL_ERROR',
        category: 'validation',
        message: 'RPC request does not match its method contract',
        retryable: false,
        userAction: null,
        detailsRef: null,
        traceId: invalidRequest.traceId,
      },
    });
  });

  it('poisons and closes the connection after a malformed frame', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();

    await client.writeRaw(Buffer.alloc(4));
    await client.waitForClose();
  });

  it('rejects an inbound response envelope at the transport-kind gate', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    await client.waitForChallenge();
    await client.authenticate(daemon.bootstrapSecret);

    await client.writeRaw(
      encodeFrame({
        kind: 'response',
        protocolVersion: 1,
        requestId: 'inbound-response',
        traceId: 'inbound-response-trace',
        ok: true,
        result: { mustNotRoute: true },
      }),
    );
    await client.waitForClose();

    expect(
      client.receivedEnvelopes.some(
        (envelope) =>
          envelope.kind === 'response' && envelope.requestId === 'inbound-response',
      ),
    ).toBe(false);
  });
});
