import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionService } from '../runtime/session-service.js';
import { configureDatabase, openRuntimeDatabase } from './database.js';
import { SessionRepository } from './session-repository.js';

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
  const rootDir = mkdtempSync(join(tmpdir(), 'awb-session-repository-'));
  const dataDir = join(rootDir, 'data');
  chmodSync(rootDir, 0o700);
  mkdirSync(dataDir, { mode: 0o700 });
  return {
    rootDir,
    dataDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
};

describe('SessionRepository read transactions', () => {
  let runtime: TempRuntime | undefined;

  afterEach(async () => {
    runtime?.cleanup();
    runtime = undefined;
  });

  const createInitialSession = (
    service: SessionService,
    workspacePath: string,
  ): { readonly sessionId: string; readonly turnId: string } => {
    const workspace = service.registerWorkspace(
      { path: workspacePath },
      'read-workspace',
    );
    return service.createSession(
      {
        workspaceId: workspace.workspaceId,
        title: 'Read transaction',
        prompt: 'Initial prompt',
      },
      'read-session',
    );
  };

  it('keeps Snapshot facts on the view established by the first SELECT', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const readerDatabase = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const writerDatabase = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(writerDatabase);
    const readerService = new SessionService(readerDatabase);
    const writerService = new SessionService(writerDatabase);
    const created = createInitialSession(readerService, workspacePath);
    let writerCommitted = false;
    const repository = new SessionRepository(readerDatabase, {
      afterSnapshotSessionRead: () => {
        if (writerCommitted) {
          return;
        }
        writerService.enqueueTurn(
          { sessionId: created.sessionId, prompt: 'Committed by WAL writer' },
          'snapshot-writer',
        );
        writerCommitted = true;
      },
    } as never);

    try {
      const snapshot = repository.getSnapshot(created.sessionId);
      expect(writerCommitted).toBe(true);
      expect(snapshot.session.nextTurnOrdinal).toBe(2);
      expect(snapshot.session.nextEventSeq).toBe(3);
      expect(snapshot.turns.map((turn) => turn.ordinal)).toEqual([1]);
      expect(snapshot.messages.map((message) => message.content)).toEqual([
        'Initial prompt',
      ]);
      expect(snapshot.highWaterSeq).toBe(2);
      expect(snapshot.events.map((event) => event.seq)).toEqual([1, 2]);

      const nextSnapshot = readerService.getSnapshot(created.sessionId);
      expect(nextSnapshot.turns.map((turn) => turn.ordinal)).toEqual([1, 2]);
      expect(nextSnapshot.messages.map((message) => message.content)).toEqual([
        'Initial prompt',
        'Committed by WAL writer',
      ]);
      expect(nextSnapshot.highWaterSeq).toBe(3);
    } finally {
      writerDatabase.close();
      readerDatabase.close();
    }
  });

  it('keeps event page and high-water on one view when a WAL writer appends after capture', async () => {
    runtime = createTempRuntime();
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const readerDatabase = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const writerDatabase = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(writerDatabase);
    const readerService = new SessionService(readerDatabase);
    const writerService = new SessionService(writerDatabase);
    const created = createInitialSession(readerService, workspacePath);
    let writerCommitted = false;
    const repository = new SessionRepository(readerDatabase, {
      afterEventHighWaterRead: () => {
        if (writerCommitted) {
          return;
        }
        writerService.enqueueTurn(
          { sessionId: created.sessionId, prompt: 'Appended after high-water' },
          'page-writer',
        );
        writerCommitted = true;
      },
    } as never);

    try {
      const page = repository.listEventsAfter({
        sessionId: created.sessionId,
        afterSeq: 0,
        limit: 10,
      });
      expect(writerCommitted).toBe(true);
      expect(page.highWaterSeq).toBe(2);
      expect(page.events.map((event) => event.seq)).toEqual([1, 2]);

      const nextPage = readerService.listEventsAfter({
        sessionId: created.sessionId,
        afterSeq: 0,
        limit: 10,
      });
      expect(nextPage.highWaterSeq).toBe(3);
      expect(nextPage.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    } finally {
      writerDatabase.close();
      readerDatabase.close();
    }
  });
});
