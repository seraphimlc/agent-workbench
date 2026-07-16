import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DaemonProcessManager, type DaemonProcessHandle } from './daemon-process.js';

const webConsoleRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureEntryPoint = fileURLToPath(
  new URL('../../../../tests/fixtures/run-web-console-daemon.ts', import.meta.url),
);
const temporaryRoots: string[] = [];
let activeHandle: DaemonProcessHandle | undefined;

const modeBits = (path: string): number => lstatSync(path).mode & 0o777;
const provider = {
  baseUrl: 'https://provider.example.test/v1',
  apiKey: 'controlled-provider-key',
  modelId: 'controlled-provider-model',
} as const;
const providerForMode = (mode: string) => ({
  ...provider,
  modelId: `fixture-mode-${mode}`,
});
const expectSecretZeroed = (secret: Buffer): void => {
  expect(secret.every((byte) => byte === 0)).toBe(true);
};

type LaunchSnapshot = {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
};

const createPaths = (): {
  readonly rootPath: string;
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly workspacePath: string;
} => {
  const rootPath = mkdtempSync(join(tmpdir(), 'awb-web-daemon-'));
  temporaryRoots.push(rootPath);
  const workspacePath = join(rootPath, 'workspace');
  mkdirSync(workspacePath, { mode: 0o700 });
  return {
    rootPath,
    dataDir: join(rootPath, 'data'),
    runtimeDir: join(rootPath, 'runtime'),
    workspacePath,
  };
};

const withEnvironment = async <Value>(
  values: Readonly<Record<string, string | undefined>>,
  operation: () => Promise<Value>,
): Promise<Value> => {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]] as const),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const readLaunchSnapshot = (dataDir: string): LaunchSnapshot =>
  JSON.parse(
    readFileSync(join(dataDir, 'web-console-daemon-launch.json'), 'utf8'),
  ) as LaunchSnapshot;

const snapshotOption = (
  snapshot: LaunchSnapshot,
  name: '--socket' | '--data-dir',
): string => {
  const index = snapshot.argv.indexOf(name);
  const value = index >= 0 ? snapshot.argv[index + 1] : undefined;
  if (value === undefined) throw new Error(`Snapshot option ${name} is missing`);
  return value;
};

const waitFor = async (
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
};

const processExited = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
};

const expectFixtureCleanup = async (snapshot: LaunchSnapshot): Promise<void> => {
  const socketPath = snapshotOption(snapshot, '--socket');
  const runtimeDir = dirname(socketPath);
  await waitFor(() => processExited(snapshot.pid), 'daemon process exit');
  await waitFor(() => !existsSync(runtimeDir), 'runtime directory cleanup');
  expect(existsSync(socketPath)).toBe(false);
};

const expectCode = async (
  operation: Promise<unknown>,
  code: string,
): Promise<Error> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return error as Error;
  }
  throw new Error(`Expected operation to reject with ${code}`);
};

const waitForFailure = async (
  handle: DaemonProcessHandle,
): Promise<Error> =>
  await new Promise<Error>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error('Timed out waiting for daemon failure')),
      2_000,
    );
    handle.failure.then((error) => {
      clearTimeout(timer);
      resolvePromise(error);
    });
  });

afterEach(async () => {
  await activeHandle?.stop().catch(() => undefined);
  activeHandle = undefined;
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

const resolvePackage = (
  specifier: string,
  conditions: readonly string[] = [],
): string => {
  const result = spawnSync(
    process.execPath,
    [
      ...conditions.flatMap((condition) => ['--conditions', condition]),
      '--input-type=module',
      '--eval',
      `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`,
    ],
    {
      cwd: webConsoleRoot,
      encoding: 'utf8',
      shell: false,
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || 'Package resolution failed');
  }
  return result.stdout;
};

describe('daemon process package wiring', () => {
  it('resolves daemon composition and Session Runner without executing either entry', () => {
    expect(
      resolvePackage('@agent-workbench/daemon/composition', ['development']),
    ).toMatch(/\/src\/index\.ts$/);
    expect(resolvePackage('@agent-workbench/daemon/composition')).toMatch(
      /\/dist\/index\.js$/,
    );
    expect(resolvePackage('@agent-workbench/session-runner', ['development'])).toMatch(
      /\/src\/index\.ts$/,
    );
    expect(resolvePackage('@agent-workbench/session-runner')).toMatch(/\/dist\/index\.js$/);
  });
});

describe('DaemonProcessManager', () => {
  it('returns ready with fd 3 secret transport and reaps the daemon on stop', async () => {
    const { dataDir, workspacePath } = createPaths();
    const inheritedSecretKey = 'AGENT_WORKBENCH_TEST_BOOTSTRAP_SECRET';
    activeHandle = await withEnvironment(
      {
        [inheritedSecretKey]: 'forbidden-inherited-bootstrap-secret',
        AWS_SECRET_ACCESS_KEY: 'forbidden-aws-secret',
        OPENAI_API_KEY: 'forbidden-openai-secret',
        UNRELATED_CHILD_VALUE: 'forbidden-unrelated-value',
      },
      async () =>
        await new DaemonProcessManager({ entryPoint: fixtureEntryPoint }).start({
          dataDir,
          workspacePath,
          provider,
        }),
    );

    const handle = activeHandle;
    const runtimeDir = dirname(handle.socketPath);
    const launchSnapshotText = readFileSync(
      join(dataDir, 'web-console-daemon-launch.json'),
      'utf8',
    );
    const launchSnapshot = JSON.parse(launchSnapshotText) as LaunchSnapshot;

    expect(handle.bootstrapSecret).toHaveLength(32);
    expect(handle.pid).toBe(launchSnapshot.pid);
    expect(Buffer.byteLength(handle.socketPath)).toBeLessThanOrEqual(100);
    expect(modeBits(dataDir)).toBe(0o700);
    expect(modeBits(runtimeDir)).toBe(0o700);
    expect(existsSync(handle.socketPath)).toBe(true);
    expect(launchSnapshot.environment[inheritedSecretKey]).toBeUndefined();
    expect(launchSnapshot.environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(launchSnapshot.environment.OPENAI_API_KEY).toBeUndefined();
    expect(launchSnapshot.environment.UNRELATED_CHILD_VALUE).toBeUndefined();
    if (process.env.PATH !== undefined) {
      expect(launchSnapshot.environment.PATH).toBe(process.env.PATH);
    }
    expect(launchSnapshot.environment).toMatchObject({
      AGENT_WORKBENCH_PROVIDER_BASE_URL: 'https://provider.example.test/v1',
      AGENT_WORKBENCH_PROVIDER_API_KEY: 'controlled-provider-key',
      AGENT_WORKBENCH_PROVIDER_MODEL: 'controlled-provider-model',
      AGENT_WORKBENCH_DEMO_WORKSPACE: workspacePath,
    });
    for (const secret of [
      handle.bootstrapSecret.toString('utf8'),
      handle.bootstrapSecret.toString('hex'),
      handle.bootstrapSecret.toString('base64'),
    ].filter((value) => value.length > 0)) {
      expect(launchSnapshot.argv.join('\0')).not.toContain(secret);
      expect(launchSnapshotText).not.toContain(secret);
    }

    const pid = handle.pid;
    await handle.stop();
    await handle.stop();
    activeHandle = undefined;

    expectSecretZeroed(handle.bootstrapSecret);
    expect(existsSync(handle.socketPath)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);
    try {
      process.kill(pid, 0);
      throw new Error('Daemon process remained live after stop');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ESRCH' });
    }
  });

  it('times out a daemon that never emits ready and cleans its child and runtime', async () => {
    const { dataDir, workspacePath } = createPaths();
    const operation = new DaemonProcessManager({
      entryPoint: fixtureEntryPoint,
      startupTimeoutMs: 1_000,
      stopTimeoutMs: 150,
    }).start({ dataDir, workspacePath, provider: providerForMode('hang') });

    await expectCode(operation, 'DAEMON_STARTUP_TIMEOUT');
    await expectFixtureCleanup(readLaunchSnapshot(dataDir));
  });

  it('reports an early exit with bounded redacted stderr and cleans runtime state', async () => {
    const { dataDir, workspacePath } = createPaths();
    const operation = new DaemonProcessManager({
      entryPoint: fixtureEntryPoint,
      stopTimeoutMs: 150,
    }).start({ dataDir, workspacePath, provider: providerForMode('early-exit') });

    const error = await expectCode(operation, 'DAEMON_EXITED_BEFORE_READY');
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain(provider.apiKey);
    expect(Buffer.byteLength(error.message)).toBeLessThan(66 * 1024);
    await expectFixtureCleanup(readLaunchSnapshot(dataDir));
  });

  it('rejects duplicate ready emitted inside the startup stability window', async () => {
    const { dataDir, workspacePath } = createPaths();
    const operation = new DaemonProcessManager({
      entryPoint: fixtureEntryPoint,
      stopTimeoutMs: 150,
    }).start({
      dataDir,
      workspacePath,
      provider: providerForMode('duplicate-ready'),
    });

    await expectCode(operation, 'DAEMON_READY_INVALID');
    await expectFixtureCleanup(readLaunchSnapshot(dataDir));
  });

  it('marks a duplicate ready after handle return fatal and terminates the daemon', async () => {
    const { dataDir, workspacePath } = createPaths();
    activeHandle = await new DaemonProcessManager({
      entryPoint: fixtureEntryPoint,
      stopTimeoutMs: 150,
    }).start({
      dataDir,
      workspacePath,
      provider: providerForMode('late-duplicate-ready'),
    });
    const snapshot = readLaunchSnapshot(dataDir);

    await expect(waitForFailure(activeHandle)).resolves.toMatchObject({
      code: 'DAEMON_READY_INVALID',
    });
    await expectFixtureCleanup(snapshot);
    expectSecretZeroed(activeHandle.bootstrapSecret);
    await activeHandle.stop();
    activeHandle = undefined;
  });

  it('escalates an ignored SIGTERM to SIGKILL and cleans the socket and child', async () => {
    const { dataDir, workspacePath } = createPaths();
    activeHandle = await new DaemonProcessManager({
      entryPoint: fixtureEntryPoint,
      stopTimeoutMs: 150,
    }).start({
      dataDir,
      workspacePath,
      provider: providerForMode('ignore-sigterm'),
    });
    const handle = activeHandle;
    const runtimeDir = dirname(handle.socketPath);
    const pid = handle.pid;

    await handle.stop();
    activeHandle = undefined;

    expect(readFileSync(join(dataDir, 'sigterm-observed'), 'utf8')).toBe('ignored');
    expectSecretZeroed(handle.bootstrapSecret);
    expect(processExited(pid)).toBe(true);
    expect(existsSync(handle.socketPath)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);
  });

  it('zeroes the bootstrap copy when the daemon exits after ready', async () => {
    const { dataDir, workspacePath } = createPaths();
    activeHandle = await new DaemonProcessManager({
      entryPoint: fixtureEntryPoint,
      stopTimeoutMs: 150,
    }).start({
      dataDir,
      workspacePath,
      provider: providerForMode('late-exit'),
    });
    const handle = activeHandle;
    const snapshot = readLaunchSnapshot(dataDir);

    await expect(waitForFailure(handle)).resolves.toMatchObject({
      code: 'DAEMON_EXITED_AFTER_READY',
    });

    expectSecretZeroed(handle.bootstrapSecret);
    await expectFixtureCleanup(snapshot);
    await handle.stop();
    activeHandle = undefined;
  });

  it('starts the real configured daemon entry with Provider, Runner, and Tool composition', async () => {
    const { dataDir, workspacePath } = createPaths();
    const runtimeDir = mkdtempSync(join(realpathSync('/tmp'), 'awb-runtime-'));
    temporaryRoots.push(runtimeDir);
    const sentinelPath = join(runtimeDir, 'sentinel.txt');
    writeFileSync(sentinelPath, 'keep', { mode: 0o600 });
    const canonicalRuntimeRoot = realpathSync(runtimeDir);
    activeHandle = await new DaemonProcessManager().start({
      dataDir,
      runtimeDir,
      workspacePath,
      provider,
    });
    const handle = activeHandle;
    const ownedRuntimeDir = dirname(handle.socketPath);

    expect(dirname(ownedRuntimeDir)).toBe(canonicalRuntimeRoot);
    expect(ownedRuntimeDir).not.toBe(canonicalRuntimeRoot);
    expect(existsSync(handle.socketPath)).toBe(true);
    expect(handle.bootstrapSecret).toHaveLength(32);

    await handle.stop();
    activeHandle = undefined;

    expectSecretZeroed(handle.bootstrapSecret);
    expect(existsSync(handle.socketPath)).toBe(false);
    expect(existsSync(ownedRuntimeDir)).toBe(false);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('keep');
    expect(readdirSync(runtimeDir)).toEqual(['sentinel.txt']);
    expect(processExited(handle.pid)).toBe(true);
  });

  it('removes only its owned runtime child when the socket path is too long', async () => {
    const { rootPath, dataDir, workspacePath } = createPaths();
    const runtimeRoot = join(rootPath, 'r'.repeat(96));
    mkdirSync(runtimeRoot, { mode: 0o700 });
    const sentinelPath = join(runtimeRoot, 'sentinel.txt');
    writeFileSync(sentinelPath, 'keep', { mode: 0o600 });

    await expectCode(
      new DaemonProcessManager({ entryPoint: fixtureEntryPoint }).start({
        dataDir,
        runtimeDir: runtimeRoot,
        workspacePath,
        provider,
      }),
      'DAEMON_SOCKET_PATH_TOO_LONG',
    );

    expect(readFileSync(sentinelPath, 'utf8')).toBe('keep');
    expect(readdirSync(runtimeRoot)).toEqual(['sentinel.txt']);
  });
});
