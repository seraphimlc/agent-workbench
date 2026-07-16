import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
    const rootPath = mkdtempSync(join(tmpdir(), 'awb-web-daemon-'));
    temporaryRoots.push(rootPath);
    const dataDir = join(rootPath, 'data');
    const workspacePath = join(rootPath, 'workspace');
    mkdirSync(workspacePath, { mode: 0o700 });
    const inheritedSecretKey = 'AGENT_WORKBENCH_TEST_BOOTSTRAP_SECRET';
    const previousInheritedSecret = process.env[inheritedSecretKey];
    process.env[inheritedSecretKey] = 'forbidden-inherited-bootstrap-secret';

    try {
      activeHandle = await new DaemonProcessManager({
        entryPoint: fixtureEntryPoint,
      }).start({
        dataDir,
        workspacePath,
        provider: {
          baseUrl: 'https://provider.example.test/v1',
          apiKey: 'controlled-provider-key',
          modelId: 'controlled-provider-model',
        },
      });
    } finally {
      if (previousInheritedSecret === undefined) {
        delete process.env[inheritedSecretKey];
      } else {
        process.env[inheritedSecretKey] = previousInheritedSecret;
      }
    }

    const handle = activeHandle;
    const runtimeDir = dirname(handle.socketPath);
    const launchSnapshotText = readFileSync(
      join(dataDir, 'web-console-daemon-launch.json'),
      'utf8',
    );
    const launchSnapshot = JSON.parse(launchSnapshotText) as {
      readonly pid: number;
      readonly argv: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
    };

    expect(handle.bootstrapSecret).toHaveLength(32);
    expect(handle.pid).toBe(launchSnapshot.pid);
    expect(Buffer.byteLength(handle.socketPath)).toBeLessThanOrEqual(100);
    expect(modeBits(dataDir)).toBe(0o700);
    expect(modeBits(runtimeDir)).toBe(0o700);
    expect(existsSync(handle.socketPath)).toBe(true);
    expect(launchSnapshot.environment[inheritedSecretKey]).toBeUndefined();
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
    activeHandle = undefined;

    expect(existsSync(handle.socketPath)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);
    try {
      process.kill(pid, 0);
      throw new Error('Daemon process remained live after stop');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ESRCH' });
    }
  });
});
