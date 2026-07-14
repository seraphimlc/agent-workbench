import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempRuntime,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import { DaemonServer } from '../../services/daemon/src/server.js';
import { acquireRuntimeLock } from '../../services/daemon/src/runtime/runtime-lock.js';

const CONDITION_TIMEOUT_MS = 5_000;
const REPLACEMENT_DAEMON_EPOCH = '018f0000-0000-7000-8000-000000000001';

const waitForCondition = async (
  condition: () => boolean,
  description: string,
  timeoutMs = CONDITION_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
};

const waitForOwnerPublication = async (
  dataDir: string,
  ownerPath: string,
): Promise<void> => {
  if (existsSync(ownerPath)) {
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const watcher = watch(dataDir, (_eventType, fileName) => {
      if (fileName === '.daemon-owner.json' && existsSync(ownerPath)) {
        clearTimeout(timer);
        watcher.close();
        resolvePromise();
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      rejectPromise(new Error('Timed out waiting for owner metadata publication'));
    }, CONDITION_TIMEOUT_MS);
  });
};

describe('daemon lifecycle serialization', () => {
  let runtime: TempRuntime | undefined;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('makes an immediate stop wait for pending start cancellation and full cleanup', async () => {
    runtime = createTempRuntime();
    const ownerPath = join(runtime.dataDir, '.daemon-owner.json');
    const server = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: Buffer.alloc(32, 0x61),
    });
    let startOutcome: 'fulfilled' | 'rejected' | undefined;
    const observedStart = server.start().then(
      () => {
        startOutcome = 'fulfilled';
      },
      () => {
        startOutcome = 'rejected';
      },
    );

    try {
      await server.stop();

      expect(startOutcome).toBe('rejected');
      expect(existsSync(runtime.socketPath)).toBe(false);
      expect(existsSync(ownerPath)).toBe(false);

      const replacementLock = await acquireRuntimeLock({
        dataDir: runtime.dataDir,
        socketPath: runtime.socketPath,
        daemonEpoch: REPLACEMENT_DAEMON_EPOCH,
        onLost: () => undefined,
      });
      await replacementLock.release();
      expect(existsSync(ownerPath)).toBe(false);
    } finally {
      await observedStart;
      await (
        server as unknown as { performStop(): Promise<void> }
      ).performStop();
    }
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'closes an early-start child and its lock helper after %s',
    async (signal) => {
      runtime = createTempRuntime();
      const ownerPath = join(runtime.dataDir, '.daemon-owner.json');
      const ownerPublished = waitForOwnerPublication(runtime.dataDir, ownerPath);
      const daemon = runtime.spawnDaemon();
      await ownerPublished;

      const exit = await daemon.stop(signal);

      expect(exit.code).toBe(0);
      await waitForCondition(
        () => !existsSync(ownerPath) && !existsSync(runtime?.socketPath ?? ''),
        `${signal} shutdown cleanup`,
      );

      const replacement = runtime.spawnDaemon();
      await replacement.waitForReady();
    },
    12_000,
  );
});
