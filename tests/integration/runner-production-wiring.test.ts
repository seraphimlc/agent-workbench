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
import {
  RUNNER_PRODUCTION_BOOTSTRAP_BASE64,
  RUNNER_PRODUCTION_BOOTSTRAP_HEX,
  RUNNER_PRODUCTION_BOOTSTRAP_SECRET,
} from '../fixtures/runner-production-secrets.js';

const fixtureEntryPoint = fileURLToPath(
  new URL('../fixtures/run-daemon-runner-wiring.ts', import.meta.url),
);
const PROVIDER_API_KEY = 'production-wiring-key';
const REDACTED_TOOL_CONTENT = '[REDACTED]:[REDACTED]:[REDACTED]:visible';

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

  it('redacts bootstrap and Provider secrets through the real runDaemon Tool chain', async () => {
    runtime = createTempRuntime();
    daemon = runtime.spawnDaemon({
      entryPoint: fixtureEntryPoint,
      bootstrapSecret: RUNNER_PRODUCTION_BOOTSTRAP_SECRET,
    });
    const launchEnvironmentValues = Object.values(daemon.launchEnvironment).filter(
      (value): value is string => typeof value === 'string',
    );
    expect(Object.hasOwn(daemon.launchEnvironment, 'TEST_TOOL_RESULT_HEX')).toBe(false);
    expect(
      launchEnvironmentValues.some(
        (value) =>
          value.includes(RUNNER_PRODUCTION_BOOTSTRAP_HEX) ||
          value.includes(RUNNER_PRODUCTION_BOOTSTRAP_BASE64),
      ),
    ).toBe(false);
    await daemon.waitForReady();
    client = await connectRpcClient(runtime.socketPath);
    const auth = await client.authenticate(RUNNER_PRODUCTION_BOOTSTRAP_SECRET);
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
      const assistant = database
        .prepare("SELECT content FROM messages WHERE turn_id = ? AND role = 'assistant'")
        .get(created.turnId) as { readonly content: string };
      expect(assistant.content === REDACTED_TOOL_CONTENT).toBe(true);
      const toolRun = database
        .prepare('SELECT result_json AS resultJson FROM tool_runs WHERE turn_id = ?')
        .get(created.turnId) as { readonly resultJson: string };
      expect(toolRun.resultJson === JSON.stringify({ content: REDACTED_TOOL_CONTENT })).toBe(true);
      const modelInputs = database
        .prepare(
          `SELECT input_json AS inputJson
           FROM model_calls WHERE turn_id = ? ORDER BY ordinal`,
        )
        .all(created.turnId) as Array<{ readonly inputJson: string }>;
      expect(modelInputs).toHaveLength(2);
      expect(modelInputs[1]?.inputJson.includes(REDACTED_TOOL_CONTENT)).toBe(true);
      const persisted = JSON.stringify({
        toolRuns: database.prepare('SELECT * FROM tool_runs WHERE turn_id = ?').all(created.turnId),
        events: database
          .prepare('SELECT * FROM session_events WHERE turn_id = ? ORDER BY seq')
          .all(created.turnId),
        modelCalls: database
          .prepare('SELECT * FROM model_calls WHERE turn_id = ? ORDER BY ordinal')
          .all(created.turnId),
        messages: database.prepare('SELECT * FROM messages WHERE turn_id = ?').all(created.turnId),
      });
      expect(persisted.includes(RUNNER_PRODUCTION_BOOTSTRAP_HEX)).toBe(false);
      expect(persisted.includes(RUNNER_PRODUCTION_BOOTSTRAP_BASE64)).toBe(false);
      expect(persisted.includes(PROVIDER_API_KEY)).toBe(false);
    } finally {
      database.close();
    }
  });
});
