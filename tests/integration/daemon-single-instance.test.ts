import {
  existsSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempRuntime,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import {
  acquireRuntimeLock,
  getProcessStartIdentity,
  type RuntimeLockError,
} from '../../services/daemon/src/runtime/runtime-lock.js';

const ownerMetadataPath = (runtime: TempRuntime): string =>
  join(runtime.dataDir, '.daemon-owner.json');

describe('daemon single-instance lifecycle', () => {
  let runtime: TempRuntime | undefined;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('rejects a live second daemon before creating its different socket and preserves the first socket', async () => {
    runtime = createTempRuntime();
    const first = runtime.spawnDaemon();
    await first.waitForReady();
    const firstSocket = lstatSync(runtime.socketPath, { bigint: true });

    const second = runtime.spawnDaemon({ socketPath: runtime.alternateSocketPath });
    const secondExit = await second.waitForExit(2_000);

    expect(secondExit.code).not.toBe(0);
    expect(existsSync(runtime.alternateSocketPath)).toBe(false);
    const currentFirstSocket = lstatSync(runtime.socketPath, { bigint: true });
    expect(currentFirstSocket.isSocket()).toBe(true);
    expect(currentFirstSocket.dev).toBe(firstSocket.dev);
    expect(currentFirstSocket.ino).toBe(firstSocket.ino);
  });

  it('recovers the same owned socket and stale owner metadata after SIGKILL', async () => {
    runtime = createTempRuntime();
    const first = runtime.spawnDaemon();
    await first.waitForReady();
    await first.stop('SIGKILL');
    expect(existsSync(runtime.socketPath)).toBe(true);

    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();

    const recoveredSocket = lstatSync(runtime.socketPath);
    expect(recoveredSocket.isSocket()).toBe(true);
    expect(recoveredSocket.mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(ownerMetadataPath(runtime), 'utf8')).predecessor,
    ).toEqual([]);
  });

  it('refuses and preserves a regular file even when stale owner evidence exists', async () => {
    runtime = createTempRuntime();
    const first = runtime.spawnDaemon();
    await first.waitForReady();
    await first.stop('SIGKILL');
    unlinkSync(runtime.socketPath);
    writeFileSync(runtime.socketPath, 'do-not-delete', { mode: 0o600 });

    const daemon = runtime.spawnDaemon();
    const exit = await daemon.waitForExit(2_000);

    expect(exit.code).not.toBe(0);
    expect(lstatSync(runtime.socketPath).isFile()).toBe(true);
    expect(readFileSync(runtime.socketPath, 'utf8')).toBe('do-not-delete');
  });

  it('refuses and preserves a pre-existing symlink', async () => {
    runtime = createTempRuntime();
    const first = runtime.spawnDaemon();
    await first.waitForReady();
    await first.stop('SIGKILL');
    unlinkSync(runtime.socketPath);
    const targetPath = `${runtime.socketPath}.target`;
    writeFileSync(targetPath, 'target', { mode: 0o600 });
    symlinkSync(targetPath, runtime.socketPath);

    const daemon = runtime.spawnDaemon();
    const exit = await daemon.waitForExit(2_000);

    expect(exit.code).not.toBe(0);
    expect(lstatSync(runtime.socketPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetPath, 'utf8')).toBe('target');
  });

  it('lets exactly one concurrent contender recover after a SIGKILL', async () => {
    runtime = createTempRuntime();
    const first = runtime.spawnDaemon();
    await first.waitForReady();
    await first.stop('SIGKILL');

    const contenders = Array.from({ length: 3 }, () => runtime?.spawnDaemon()).filter(
      (daemon) => daemon !== undefined,
    );
    const outcomes = await Promise.allSettled(
      contenders.map(async (daemon) => await daemon.waitForReady(4_000)),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(2);
    expect(lstatSync(runtime.socketPath).isSocket()).toBe(true);
  });

  it('treats a live PID with a different process-start identity as stale PID reuse', async () => {
    runtime = createTempRuntime();
    const first = runtime.spawnDaemon();
    await first.waitForReady();
    await first.stop('SIGKILL');
    const ownerPath = ownerMetadataPath(runtime);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
    owner.pid = process.pid;
    owner.processStartIdentity = 'definitely-not-this-process-start';
    writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });

    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();

    expect(lstatSync(runtime.socketPath).isSocket()).toBe(true);
  });

  it('fails closed when owner metadata names a still-live PID and matching start identity', async () => {
    runtime = createTempRuntime();
    const first = runtime.spawnDaemon();
    await first.waitForReady();
    await first.stop('SIGKILL');
    const ownerPath = ownerMetadataPath(runtime);
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
    owner.pid = process.pid;
    owner.processStartIdentity = getProcessStartIdentity(process.pid);
    writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    const staleSocket = lstatSync(runtime.socketPath, { bigint: true });

    const blocked = runtime.spawnDaemon();
    const exit = await blocked.waitForExit(2_000);

    expect(exit.code).not.toBe(0);
    const preservedSocket = lstatSync(runtime.socketPath, { bigint: true });
    expect(preservedSocket.dev).toBe(staleSocket.dev);
    expect(preservedSocket.ino).toBe(staleSocket.ino);
  });

  it('fails closed on malformed authoritative owner metadata', async () => {
    runtime = createTempRuntime();
    writeFileSync(ownerMetadataPath(runtime), '{"invalid":true}', { mode: 0o600 });

    const daemon = runtime.spawnDaemon();
    const exit = await daemon.waitForExit(2_000);

    expect(exit.code).not.toBe(0);
    expect(readFileSync(ownerMetadataPath(runtime), 'utf8')).toBe(
      '{"invalid":true}',
    );
    expect(existsSync(runtime.socketPath)).toBe(false);
  });

  it('reports an unexpected kernel-lock helper exit through the loss callback', async () => {
    runtime = createTempRuntime();
    let resolveLoss!: (error: RuntimeLockError) => void;
    const loss = new Promise<RuntimeLockError>((resolvePromise) => {
      resolveLoss = resolvePromise;
    });
    const lock = await acquireRuntimeLock({
      dataDir: runtime.dataDir,
      socketPath: runtime.socketPath,
      daemonEpoch: '01890f3e-7b1c-7cc0-8f00-000000000001',
      onLost: resolveLoss,
    });

    process.kill(lock.helperPid, 'SIGKILL');
    const error = await loss;

    expect(error.code).toBe('DAEMON_RUNTIME_LOCK_FAILED');
    await lock.release();

    const ownerPath = ownerMetadataPath(runtime);
    const staleOwner = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    staleOwner.processStartIdentity = 'released-helper-stale-identity';
    writeFileSync(ownerPath, JSON.stringify(staleOwner), { mode: 0o600 });
    const replacement = await acquireRuntimeLock({
      dataDir: runtime.dataDir,
      socketPath: runtime.socketPath,
      daemonEpoch: '01890f3e-7b1c-7cc0-8f00-000000000002',
      onLost: () => undefined,
    });
    await replacement.release();
  });

  it('stops the full daemon and permits stale recovery when its lock helper is killed', async () => {
    runtime = createTempRuntime();
    const first = runtime.spawnDaemon();
    await first.waitForReady();
    const childProcesses = spawnSync(
      '/bin/ps',
      ['-axo', 'pid=,ppid='],
      { encoding: 'utf8', shell: false },
    );
    const helperPids = childProcesses.stdout
      .split('\n')
      .map((value) => value.trim().split(/\s+/).map(Number))
      .filter(([, parentPid]) => parentPid === first.child.pid)
      .map(([pid]) => pid)
      .filter((value): value is number => Number.isInteger(value) && value > 0);
    expect(childProcesses.status).toBe(0);
    expect(helperPids).toHaveLength(1);

    process.kill(helperPids[0] as number, 'SIGKILL');
    const firstExit = await first.waitForExit(4_000);

    expect(firstExit.code).not.toBe(0);
    expect(existsSync(runtime.socketPath)).toBe(false);

    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady(4_000);
    expect(lstatSync(runtime.socketPath).isSocket()).toBe(true);
  });
});
