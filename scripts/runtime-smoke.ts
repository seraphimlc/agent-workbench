import { deepStrictEqual, strictEqual } from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AppHealthResultSchema,
  AuthRespondResultSchema,
  SessionCreateResultSchema,
  SessionGetSnapshotResultSchema,
  WorkspaceRegisterResultSchema,
  type RpcRequestEnvelope,
} from '../packages/protocol/src/index.js';
import {
  createTempRuntime,
  type DaemonProcess,
  type ProcessExit,
  type TempRuntime,
} from '../packages/testkit/src/temp-runtime.js';
import {
  connectRpcClient,
  type RpcClient,
} from '../packages/testkit/src/rpc-client.js';

type CliOptions = {
  readonly keepData: boolean;
};

type ResultSchema<T> = {
  parse(value: unknown): T;
};

export type RuntimeSmokeDependencies = {
  readonly spawnSecondDaemon?: (
    runtime: TempRuntime,
    bootstrapSecret: Buffer,
  ) => DaemonProcess;
};

export const assertCleanDaemonExit = (
  description: string,
  exit: ProcessExit,
): void => {
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(
      `${description} did not stop cleanly: code=${String(exit.code)} signal=${String(exit.signal)}`,
    );
  }
};

const parseCli = (arguments_: readonly string[]): CliOptions => {
  let keepData = false;
  const optionArguments =
    arguments_[0] === '--' ? arguments_.slice(1) : arguments_;

  for (const argument of optionArguments) {
    if (argument !== '--keep-data') {
      throw new Error(`Unknown runtime smoke option: ${argument}`);
    }
    if (keepData) {
      throw new Error('Duplicate runtime smoke option: --keep-data');
    }
    keepData = true;
  }

  return { keepData };
};

const mutationRequest = (
  client: RpcClient,
  method: 'workspace.register' | 'session.create',
  payload: unknown,
): RpcRequestEnvelope => ({
  ...client.createRequest(method, payload),
  clientRequestId: randomUUID(),
});

const sendSuccessfulRequest = async <T>(
  client: RpcClient,
  request: RpcRequestEnvelope,
  schema: ResultSchema<T>,
): Promise<T> => {
  const response = await client.sendRequest(request);
  if (!response.ok) {
    throw new Error(`${request.method} failed with ${response.error.code}`);
  }
  return schema.parse(response.result);
};

const connectAuthenticatedClient = async (
  runtime: TempRuntime,
  bootstrapSecret: Uint8Array,
): Promise<RpcClient> => {
  const client = await connectRpcClient(runtime.socketPath);
  try {
    await client.waitForChallenge();
    const response = await client.authenticate(bootstrapSecret);
    if (!response.ok) {
      throw new Error(`auth.respond failed with ${response.error.code}`);
    }
    AuthRespondResultSchema.parse(response.result);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
};

const collectCleanupError = async (
  errors: unknown[],
  cleanup: () => Promise<unknown>,
): Promise<void> => {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
};

const stopDaemonCleanly = async (
  daemon: DaemonProcess,
  description: string,
): Promise<void> => {
  const exit = await daemon.stop();
  assertCleanDaemonExit(description, exit);
};

const executeSmoke = async (
  options: CliOptions,
  dependencies: RuntimeSmokeDependencies,
) => {
  const bootstrapSecret = randomBytes(32);
  const runtime = createTempRuntime();
  const workspacePath = join(runtime.rootDir, 'workspace');
  const databasePath = join(runtime.dataDir, 'runtime.sqlite3');
  let firstDaemon: DaemonProcess | undefined;
  let secondDaemon: DaemonProcess | undefined;
  let client: RpcClient | undefined;
  let result: Record<string, unknown> | undefined;
  const errors: unknown[] = [];

  try {
    mkdirSync(workspacePath, { mode: 0o700 });

    firstDaemon = runtime.spawnDaemon({ bootstrapSecret });
    await firstDaemon.waitForReady();
    client = await connectAuthenticatedClient(runtime, bootstrapSecret);

    const health = await sendSuccessfulRequest(
      client,
      client.createRequest('app.health', {}),
      AppHealthResultSchema,
    );
    const workspace = await sendSuccessfulRequest(
      client,
      mutationRequest(client, 'workspace.register', { path: workspacePath }),
      WorkspaceRegisterResultSchema,
    );
    const created = await sendSuccessfulRequest(
      client,
      mutationRequest(client, 'session.create', {
        workspaceId: workspace.workspaceId,
        title: 'Runtime Foundation Smoke',
        prompt: 'Persist this queued turn across a graceful daemon restart.',
      }),
      SessionCreateResultSchema,
    );
    const initialSnapshot = await sendSuccessfulRequest(
      client,
      {
        ...client.createRequest('session.getSnapshot', {
          sessionId: created.sessionId,
        }),
        sessionId: created.sessionId,
      },
      SessionGetSnapshotResultSchema,
    );

    strictEqual(initialSnapshot.session.id, created.sessionId);
    strictEqual(initialSnapshot.session.runtimeStatus, 'queued');
    strictEqual(initialSnapshot.messages.length, 1);
    strictEqual(initialSnapshot.turns.length, 1);
    strictEqual(initialSnapshot.turns[0]?.id, created.turnId);
    strictEqual(initialSnapshot.turns[0]?.status, 'queued');
    strictEqual(initialSnapshot.events.length, initialSnapshot.highWaterSeq);

    await client.close();
    client = undefined;
    const firstExit = await firstDaemon.stop();
    firstDaemon = undefined;
    assertCleanDaemonExit('Initial Daemon', firstExit);

    secondDaemon = dependencies.spawnSecondDaemon
      ? dependencies.spawnSecondDaemon(runtime, bootstrapSecret)
      : runtime.spawnDaemon({ bootstrapSecret });
    await secondDaemon.waitForReady();
    client = await connectAuthenticatedClient(runtime, bootstrapSecret);
    const restoredSnapshot = await sendSuccessfulRequest(
      client,
      {
        ...client.createRequest('session.getSnapshot', {
          sessionId: created.sessionId,
        }),
        sessionId: created.sessionId,
      },
      SessionGetSnapshotResultSchema,
    );

    deepStrictEqual(restoredSnapshot, initialSnapshot);
    strictEqual(restoredSnapshot.session.id, created.sessionId);
    strictEqual(restoredSnapshot.session.runtimeStatus, 'queued');
    strictEqual(restoredSnapshot.turns[0]?.id, created.turnId);
    strictEqual(restoredSnapshot.turns[0]?.status, 'queued');
    strictEqual(restoredSnapshot.highWaterSeq, initialSnapshot.highWaterSeq);

    result = {
      status: 'ok',
      health,
      workspaceId: workspace.workspaceId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      highWaterSeq: initialSnapshot.highWaterSeq,
      restoredSessionId: restoredSnapshot.session.id,
      restoredRuntimeStatus: restoredSnapshot.session.runtimeStatus,
      restoredMessageCount: restoredSnapshot.messages.length,
      restoredTurnCount: restoredSnapshot.turns.length,
      restoredEventCount: restoredSnapshot.events.length,
      restoredSnapshot,
      databasePath,
      dataDir: runtime.dataDir,
      rootDir: runtime.rootDir,
      keptData: options.keepData,
    };
  } catch (error) {
    errors.push(error);
  } finally {
    if (client !== undefined) {
      await collectCleanupError(errors, async () => await client?.close());
    }
    if (secondDaemon !== undefined) {
      const daemon = secondDaemon;
      await collectCleanupError(
        errors,
        async () => await stopDaemonCleanly(daemon, 'Replacement Daemon'),
      );
    }
    if (firstDaemon !== undefined) {
      const daemon = firstDaemon;
      await collectCleanupError(
        errors,
        async () => await stopDaemonCleanly(daemon, 'Initial Daemon'),
      );
    }
    bootstrapSecret.fill(0);

    if (!options.keepData) {
      await collectCleanupError(errors, async () => await runtime.cleanup());
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Runtime smoke and cleanup failed');
  }
  if (result === undefined) {
    throw new Error('Runtime smoke completed without a result');
  }

  return result;
};

const formatError = (error: unknown): string => {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map(formatError)].join('; ');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown runtime smoke failure';
};

export const runRuntimeSmokeCli = async (
  arguments_: readonly string[] = process.argv.slice(2),
  dependencies: RuntimeSmokeDependencies = {},
): Promise<void> => {
  try {
    const options = parseCli(arguments_);
    const result = await executeSmoke(options, dependencies);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Runtime smoke failed: ${formatError(error)}\n`);
    process.exitCode = 1;
  }
};

const isMainEntryPoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainEntryPoint) {
  void runRuntimeSmokeCli();
}
