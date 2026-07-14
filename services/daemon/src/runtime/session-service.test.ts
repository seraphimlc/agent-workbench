import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  configureDatabase,
  openRuntimeDatabase,
} from '../db/database.js';
import { SessionService } from './session-service.js';

const requireFromDaemon = createRequire(
  new URL('../../package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

type TempRuntime = {
  readonly rootDir: string;
  readonly dataDir: string;
  cleanup(): void;
};

const createTempRuntime = (): TempRuntime => {
  const rootDir = mkdtempSync(join(tmpdir(), 'awb-session-service-'));
  const dataDir = join(rootDir, 'data');
  chmodSync(rootDir, 0o700);
  mkdirSync(dataDir, { mode: 0o700 });
  return {
    rootDir,
    dataDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
};

describe('SessionService transaction boundaries', () => {
  let runtime: TempRuntime | undefined;

  afterEach(async () => {
    runtime?.cleanup();
    runtime = undefined;
  });

  it('holds a write reservation immediately after an idempotency miss', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const competingWriter = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(competingWriter);
    competingWriter.pragma('busy_timeout = 0');
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    let competingCode: string | undefined;
    let competingWriteSucceeded = false;
    const service = new SessionService(database, {
      afterIdempotencyMiss: () => {
        try {
          competingWriter
            .prepare("UPDATE scheduler_slots SET updated_at = 'competing-writer'")
            .run();
          competingWriteSucceeded = true;
        } catch (error) {
          competingCode =
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : undefined;
        }
      },
    } as never);

    try {
      const result = service.registerWorkspace(
        { path: workspacePath },
        'immediate-transaction-key',
      );

      expect(result.workspaceId).toEqual(expect.any(String));
      expect(competingWriteSucceeded).toBe(false);
      expect(competingCode).toMatch(/^SQLITE_BUSY/);
      expect(
        database.prepare('SELECT updated_at FROM scheduler_slots').get(),
      ).not.toEqual({ updated_at: 'competing-writer' });
    } finally {
      competingWriter.close();
      database.close();
    }
  });
});
