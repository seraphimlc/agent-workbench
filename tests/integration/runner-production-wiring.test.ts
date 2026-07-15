import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SessionCreateResultSchema,
  WorkspaceRegisterResultSchema,
  type RpcRequestEnvelope,
} from '../../packages/protocol/src/index.js';
import { connectRpcClient, type RpcClient } from '../../packages/testkit/src/rpc-client.js';
import {
  createTempRuntime,
  type DaemonProcess,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import { openRuntimeDatabase } from '../../services/daemon/src/db/database.js';

const fixtureEntryPoint = fileURLToPath(
  new URL('../fixtures/run-daemon-runner-wiring.ts', import.meta.url),
);

const mutationRequest = (
  client: RpcClient,
  method: 'workspace.register' | 'session.create',
  payload: unknown,
  clientRequestId: string,
): RpcRequestEnvelope => ({
  ...client.createRequest(method, payload),
  sessionId: null,
  clientRequestId,
});

const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe('runDaemon Runner production wiring', () => {
  let runtime: TempRuntime | undefined;
  let daemon: DaemonProcess | undefined;
  let client: RpcClient | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.stop().catch(() => undefined);
    await runtime?.cleanup();
    client = undefined;
    daemon = undefined;
    runtime = undefined;
  });

  it('constructs the Runner execution driver in the real runDaemon entry path', async () => {
    runtime = createTempRuntime();
    daemon = runtime.spawnDaemon({ entryPoint: fixtureEntryPoint });
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    const auth = await client.authenticate(daemon.bootstrapSecret);
    expect(auth.ok).toBe(true);
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const workspaceResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: workspacePath },
        'production-wiring-workspace',
      ),
    );
    if (!workspaceResponse.ok) throw new Error('workspace.register failed');
    const workspace = WorkspaceRegisterResultSchema.parse(workspaceResponse.result);
    const sessionResponse = await client.sendRequest(
      mutationRequest(
        client,
        'session.create',
        {
          workspaceId: workspace.workspaceId,
          title: 'Production Runner wiring',
          prompt: 'Complete through the real runDaemon wiring.',
        },
        'production-wiring-session',
      ),
    );
    if (!sessionResponse.ok) throw new Error('session.create failed');
    const created = SessionCreateResultSchema.parse(sessionResponse.result);
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });

    try {
      await waitFor(
        () =>
          (
            database.prepare('SELECT status FROM turns WHERE id = ?').get(created.turnId) as {
              readonly status: string;
            }
          ).status === 'succeeded',
        'the real runDaemon Runner chain to complete the Turn',
      );
      expect(
        database
          .prepare("SELECT content FROM messages WHERE turn_id = ? AND role = 'assistant'")
          .get(created.turnId),
      ).toEqual({ content: 'Production wiring complete' });
    } finally {
      database.close();
    }
  });
});
