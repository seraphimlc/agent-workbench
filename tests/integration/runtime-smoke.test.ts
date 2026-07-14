import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SessionGetSnapshotResultSchema,
  type SessionSnapshot,
} from '../../packages/protocol/src/index.js';
import { assertCleanDaemonExit } from '../../scripts/runtime-smoke.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const finalStopFailureFixture = fileURLToPath(
  new URL('../fixtures/runtime-smoke-final-stop-failure.ts', import.meta.url),
);
const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');
const rootPackage = JSON.parse(
  readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
) as { readonly scripts?: Record<string, string> };

type SmokeResult = {
  readonly status: 'ok';
  readonly health: {
    readonly status: 'ready';
    readonly protocolVersion: 1;
    readonly pid: number;
  };
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly highWaterSeq: number;
  readonly restoredSessionId: string;
  readonly restoredRuntimeStatus: string;
  readonly restoredMessageCount: number;
  readonly restoredTurnCount: number;
  readonly restoredEventCount: number;
  readonly restoredSnapshot: SessionSnapshot;
  readonly databasePath: string;
  readonly dataDir: string;
  readonly rootDir: string;
  readonly keptData: boolean;
};

type ChildResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

const runChild = async (
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ChildResult> =>
  await new Promise<ChildResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...arguments_], {
      cwd: repositoryRoot,
      detached: process.platform !== 'win32',
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      if (child.pid !== undefined && process.platform !== 'win32') {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
      rejectPromise(new Error('Timed out waiting for runtime smoke child to close'));
    }, 30_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });

const runSmoke = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ChildResult> =>
  await runChild(
    'pnpm',
    ['--silent', 'smoke:runtime', '--', ...arguments_],
    environment,
  );

const runTsxEntry = async (
  entryPoint: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ChildResult> =>
  await runChild(
    process.execPath,
    ['--conditions=development', '--import', 'tsx', entryPoint, ...arguments_],
    environment,
  );

const parseOnlyJsonObject = (stdout: string): SmokeResult => {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0] as string) as unknown;
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);
  expect(typeof parsed).toBe('object');
  return parsed as SmokeResult;
};

const assertSafeSmokeRoot = (
  rootDir: string,
  operatingSystemTemp = realpathSync(tmpdir()),
): void => {
  const smokeRoot = realpathSync(rootDir);
  const relation = relative(operatingSystemTemp, smokeRoot);

  expect(relation).not.toBe('');
  expect(relation.startsWith('..')).toBe(false);
};

const createChildTemp = (): string => realpathSync(mkdtempSync('/tmp/as-'));
const runtimeRootsWithin = (directory: string): string[] =>
  readdirSync(directory).filter((entry) => entry.startsWith('awb-'));

describe('runtime smoke clean exit validation', () => {
  it.each([
    {
      exit: { code: 1, signal: null },
      diagnostic: 'Replacement Daemon did not stop cleanly: code=1 signal=null',
    },
    {
      exit: { code: null, signal: 'SIGKILL' as const },
      diagnostic:
        'Replacement Daemon did not stop cleanly: code=null signal=SIGKILL',
    },
  ])('rejects a non-clean daemon exit: $exit', ({ exit, diagnostic }) => {
    expect(() => assertCleanDaemonExit('Replacement Daemon', exit)).toThrow(
      diagnostic,
    );
  });
});

describe('runtime smoke command', () => {
  it('uses the source-resolving root package entry point', () => {
    expect(rootPackage.scripts?.['smoke:runtime']).toBe(
      'node --conditions=development --import tsx scripts/runtime-smoke.ts',
    );
  });

  it('fails instead of reporting ok when the replacement Daemon exits non-zero', async () => {
    const childTemp = createChildTemp();

    try {
      const result = await runTsxEntry(finalStopFailureFixture, [], {
        ...process.env,
        TMPDIR: childTemp,
      });

      expect(result).toMatchObject({ code: 1, signal: null, stdout: '' });
      expect(result.stderr).toContain(
        'Replacement Daemon did not stop cleanly: code=1 signal=null',
      );
      expect(runtimeRootsWithin(childTemp)).toEqual([]);
    } finally {
      rmSync(childTemp, { force: true, recursive: true });
    }
  }, 40_000);

  it('runs the source daemon through authenticated restart recovery and retains inspectable data', async () => {
    const childTemp = createChildTemp();
    let retainedRoot: string | undefined;

    try {
      const result = await runSmoke(['--keep-data'], {
        ...process.env,
        TMPDIR: childTemp,
      });

      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      const output = parseOnlyJsonObject(result.stdout);
      retainedRoot = output.rootDir;
      expect(output).toMatchObject({
        status: 'ok',
        health: {
          status: 'ready',
          protocolVersion: 1,
          pid: expect.any(Number),
        },
        workspaceId: expect.any(String),
        sessionId: expect.any(String),
        turnId: expect.any(String),
        highWaterSeq: 2,
        restoredSessionId: output.sessionId,
        restoredRuntimeStatus: 'queued',
        restoredMessageCount: 1,
        restoredTurnCount: 1,
        restoredEventCount: 2,
        databasePath: join(output.dataDir, 'runtime.sqlite3'),
        dataDir: join(output.rootDir, 'd'),
        keptData: true,
      });
      expect(output.health.pid).toBeGreaterThan(0);
      expect(output.workspaceId.length).toBeGreaterThan(0);
      expect(output.sessionId.length).toBeGreaterThan(0);
      expect(output.turnId.length).toBeGreaterThan(0);
      expect(output.restoredSnapshot).toBeDefined();
      const restoredSnapshot = SessionGetSnapshotResultSchema.parse(
        output.restoredSnapshot,
      );
      expect(restoredSnapshot.session).toMatchObject({
        id: output.sessionId,
        workspaceId: output.workspaceId,
        runtimeStatus: 'queued',
        currentTurnId: null,
      });
      expect(restoredSnapshot.messages).toEqual([
        expect.objectContaining({
          sessionId: output.sessionId,
          turnId: output.turnId,
          role: 'user',
          status: 'completed',
          content: 'Persist this queued turn across a graceful daemon restart.',
        }),
      ]);
      expect(restoredSnapshot.turns).toEqual([
        expect.objectContaining({
          id: output.turnId,
          sessionId: output.sessionId,
          ordinal: 1,
          queueKind: 'normal',
          status: 'queued',
          executionFence: 0,
          startedAt: null,
          finishedAt: null,
          resultMessageId: null,
        }),
      ]);
      expect(restoredSnapshot.turns[0]?.inputMessageId).toBe(
        restoredSnapshot.messages[0]?.id,
      );
      expect(restoredSnapshot.highWaterSeq).toBe(output.highWaterSeq);
      expect(
        restoredSnapshot.events.map(({ seq, type, turnId }) => ({
          seq,
          type,
          turnId,
        })),
      ).toEqual([
        { seq: 1, type: 'session.created', turnId: null },
        { seq: 2, type: 'turn.queued', turnId: output.turnId },
      ]);
      expect(output.restoredSessionId).toBe(restoredSnapshot.session.id);
      expect(output.restoredRuntimeStatus).toBe(
        restoredSnapshot.session.runtimeStatus,
      );
      expect(output.restoredMessageCount).toBe(restoredSnapshot.messages.length);
      expect(output.restoredTurnCount).toBe(restoredSnapshot.turns.length);
      expect(output.restoredEventCount).toBe(restoredSnapshot.events.length);
      assertSafeSmokeRoot(output.rootDir, childTemp);
      expect(dirname(output.dataDir)).toBe(output.rootDir);
      expect(existsSync(output.rootDir)).toBe(true);
      expect(existsSync(output.dataDir)).toBe(true);
      expect(existsSync(join(output.rootDir, 'workspace'))).toBe(true);
      expect(existsSync(output.databasePath)).toBe(true);
      expect(existsSync(join(output.rootDir, 'r', 'd.sock'))).toBe(false);
      expect(existsSync(join(output.dataDir, '.daemon-owner.json'))).toBe(false);

      const database = new Database(output.databasePath, { readonly: true });
      try {
        expect(
          database
            .prepare('SELECT version FROM schema_migrations ORDER BY version')
            .all(),
        ).toEqual([
          { version: 1 },
          { version: 2 },
          { version: 3 },
          { version: 4 },
        ]);
        expect(database.pragma('foreign_key_check')).toEqual([]);
        expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(database.prepare('SELECT id FROM sessions').all()).toEqual([
          { id: output.sessionId },
        ]);
        expect(database.prepare('SELECT id FROM messages').all()).toHaveLength(
          output.restoredMessageCount,
        );
        const turns = database
          .prepare('SELECT id, status, execution_fence FROM turns')
          .all();
        expect(turns).toHaveLength(output.restoredTurnCount);
        expect(turns).toEqual([
          { id: output.turnId, status: 'queued', execution_fence: 0 },
        ]);
        for (const table of [
          'model_calls',
          'model_attempts',
          'model_tool_calls',
          'tool_runs',
          'tracked_files',
          'fs_write_effects',
          'audit_events',
          'effect_resolutions',
          'blobs',
          'artifacts',
          'artifact_versions',
        ]) {
          expect(
            database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
          ).toEqual({ count: 0 });
        }
        const events = database
          .prepare('SELECT seq FROM session_events ORDER BY seq')
          .all();
        expect(events).toHaveLength(output.restoredEventCount);
        expect(events).toEqual([{ seq: 1 }, { seq: 2 }]);
        expect(database.prepare('SELECT * FROM scheduler_slots').all()).toEqual([
          {
            slot_no: 1,
            state: 'free',
            owner_turn_id: null,
            updated_at: expect.any(String),
          },
        ]);
      } finally {
        database.close();
      }
    } finally {
      if (retainedRoot !== undefined && existsSync(retainedRoot)) {
        assertSafeSmokeRoot(retainedRoot, childTemp);
        rmSync(retainedRoot, { force: true, recursive: true });
      }
      rmSync(childTemp, { force: true, recursive: true });
    }
  }, 40_000);

  it('removes its temporary root after a successful default run', async () => {
    const childTemp = createChildTemp();

    try {
      const result = await runSmoke([], {
        ...process.env,
        TMPDIR: childTemp,
      });

      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      const output = parseOnlyJsonObject(result.stdout);
      expect(output).toMatchObject({
        status: 'ok',
        restoredSessionId: output.sessionId,
        restoredRuntimeStatus: 'queued',
        keptData: false,
      });
      expect(dirname(output.rootDir)).toBe(childTemp);
      expect(existsSync(output.databasePath)).toBe(false);
      expect(existsSync(output.dataDir)).toBe(false);
      expect(existsSync(output.rootDir)).toBe(false);
      expect(runtimeRootsWithin(childTemp)).toEqual([]);
    } finally {
      rmSync(childTemp, { force: true, recursive: true });
    }
  }, 40_000);

  it.each([
    {
      arguments: ['--unknown'],
      diagnostic: 'Unknown runtime smoke option: --unknown',
    },
    {
      arguments: ['--keep-data', '--keep-data'],
      diagnostic: 'Duplicate runtime smoke option: --keep-data',
    },
  ])(
    'rejects invalid arguments before creating runtime data: $arguments',
    async ({ arguments: arguments_, diagnostic }) => {
      const childTemp = createChildTemp();

      try {
        const result = await runSmoke(arguments_, {
          ...process.env,
          TMPDIR: childTemp,
        });

        expect(result).toEqual({
          code: 1,
          signal: null,
          stdout: '',
          stderr: `Runtime smoke failed: ${diagnostic}\n`,
        });
        expect(runtimeRootsWithin(childTemp)).toEqual([]);
      } finally {
        rmSync(childTemp, { force: true, recursive: true });
      }
    },
    10_000,
  );
});
