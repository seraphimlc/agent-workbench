import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireRuntimeDatabase,
  configureDatabase,
  initializeRuntimeDatabase,
  openRuntimeDatabase,
} from '../../services/daemon/src/db/database.js';
import {
  discoverMigrations,
  migrateDatabase,
} from '../../services/daemon/src/db/migrations.js';
import { SessionRepository } from '../../services/daemon/src/db/session-repository.js';
import {
  createTempRuntime,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import { acquireRuntimeLock } from '../../services/daemon/src/runtime/runtime-lock.js';

const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceMigrationPath = fileURLToPath(
  new URL(
    '../../services/daemon/src/db/migrations/001_runtime_foundation.sql',
    import.meta.url,
  ),
);
const sourceSchedulerMigrationPath = fileURLToPath(
  new URL(
    '../../services/daemon/src/db/migrations/002_scheduler_invariants.sql',
    import.meta.url,
  ),
);
const sourceExecutionMigrationPath = fileURLToPath(
  new URL(
    '../../services/daemon/src/db/migrations/003_execution_ledger.sql',
    import.meta.url,
  ),
);
const sourceArtifactMigrationPath = fileURLToPath(
  new URL(
    '../../services/daemon/src/db/migrations/004_artifact_store.sql',
    import.meta.url,
  ),
);
const committedWalProducerEntryPoint = fileURLToPath(
  new URL('../fixtures/committed-wal-producer-daemon.ts', import.meta.url),
);
const testMigrationsDaemonEntryPoint = fileURLToPath(
  new URL('../fixtures/test-migrations-daemon.ts', import.meta.url),
);

const createMigrationDirectory = (
  runtime: TempRuntime,
  files: Readonly<Record<string, string>>,
): string => {
  const directory = join(runtime.rootDir, `migrations-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  for (const [filename, sql] of Object.entries(files)) {
    writeFileSync(join(directory, filename), sql, { mode: 0o600 });
  }
  return directory;
};

const tableExists = (
  database: import('better-sqlite3').Database,
  name: string,
): boolean =>
  database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name) !== undefined;

const openConfiguredDatabase = (
  path: string,
): import('better-sqlite3').Database => {
  const database = new Database(path);
  configureDatabase(database);
  return database;
};

type TestDatabase = import('better-sqlite3').Database;

const seedTurn = (
  database: TestDatabase,
  suffix: string,
  status: 'queued' | 'running' | 'succeeded' = 'running',
): { readonly sessionId: string; readonly turnId: string } => {
  const workspaceId = `workspace-${suffix}`;
  const sessionId = `session-${suffix}`;
  const messageId = `message-${suffix}`;
  const turnId = `turn-${suffix}`;
  const insert = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO workspaces (id, path, canonical_path, created_at)
         VALUES (?, ?, ?, 'now')`,
      )
      .run(workspaceId, `/workspace/${suffix}`, `/canonical/${suffix}`);
    database
      .prepare(
        `INSERT INTO sessions (
          id, title, workspace_id, lifecycle_status, runtime_status,
          queue_block_reason, recovery_episode, recovery_source_turn_id,
          current_turn_id, mode, access_mode, next_turn_ordinal, next_event_seq,
          revision, created_at, updated_at
        ) VALUES (?, 'title', ?, 'active', ?, NULL, 0, NULL, NULL, 'craft',
          'full_access', 2, 1, 0, 'now', 'now')`,
      )
      .run(sessionId, workspaceId, status === 'running' ? 'running' : 'queued');
    database
      .prepare(
        `INSERT INTO messages (
          id, session_id, turn_id, role, status, content, created_at, completed_at
        ) VALUES (?, ?, ?, 'user', 'completed', 'prompt', 'now', 'now')`,
      )
      .run(messageId, sessionId, turnId);
    database
      .prepare(
        `INSERT INTO turns (
          id, session_id, ordinal, client_request_id, queue_kind, status,
          input_message_id, mode_snapshot, access_mode_snapshot, queued_at,
          started_at, finished_at, error_code, error_message, result_message_id,
          execution_fence
        ) VALUES (?, ?, 1, ?, 'normal', ?, ?, 'craft', 'full_access', 'now',
          NULL, NULL, NULL, NULL, NULL, 0)`,
      )
      .run(turnId, sessionId, `request-${suffix}`, status, messageId);
  });
  insert.immediate();
  return { sessionId, turnId };
};

const insertModelCall = (
  database: TestDatabase,
  values: {
    readonly id: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly ordinal?: number;
    readonly status?: 'running' | 'succeeded' | 'failed' | 'interrupted';
    readonly successfulAttemptId?: string | null;
  },
): void => {
  database
    .prepare(
      `INSERT INTO model_calls (
        id, session_id, turn_id, ordinal, kind, status, profile_snapshot_json,
        input_json, result_json, successful_attempt_id, error_code,
        error_message, created_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, 'craft', ?, '{}', '{}', NULL, ?, NULL, NULL,
        'now', 'now', NULL)`,
    )
    .run(
      values.id,
      values.sessionId,
      values.turnId,
      values.ordinal ?? 1,
      values.status ?? 'running',
      values.successfulAttemptId ?? null,
    );
};

const insertModelAttempt = (
  database: TestDatabase,
  values: {
    readonly id: string;
    readonly modelCallId: string;
    readonly attempt?: number;
    readonly status?: 'running' | 'succeeded' | 'failed' | 'interrupted';
  },
): void => {
  database
    .prepare(
      `INSERT INTO model_attempts (
        id, model_call_id, attempt, status, provider_request_id,
        partial_output_json, result_json, finish_reason, input_tokens,
        output_tokens, cached_tokens, latency_ms, error_code, error_message,
        retryable, started_at, finished_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 'now', NULL)`,
    )
    .run(
      values.id,
      values.modelCallId,
      values.attempt ?? 1,
      values.status ?? 'running',
    );
};

type ToolRunValues = {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly logicalCallId: string;
  readonly sourceModelCallId: string;
  readonly sourceModelAttemptId: string;
  readonly attempt: number;
  readonly operationId: string | null;
  readonly idempotencyKey: string | null;
  readonly sourceHandle: string | null;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly executionMode: string;
  readonly sideEffectClass: string;
  readonly status: string;
  readonly dispatchState: string | null;
  readonly dispatchNonce: string | null;
  readonly normalizedInputHash: string;
  readonly effectState: string;
};

const toolRunValues = (
  suffix: string,
  ownership: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly sourceModelCallId: string;
    readonly sourceModelAttemptId: string;
  },
  overrides: Partial<ToolRunValues> = {},
): ToolRunValues => ({
  id: `tool-run-${suffix}`,
  sessionId: ownership.sessionId,
  turnId: ownership.turnId,
  ordinal: 1,
  logicalCallId: `logical-call-${suffix}`,
  sourceModelCallId: ownership.sourceModelCallId,
  sourceModelAttemptId: ownership.sourceModelAttemptId,
  attempt: 1,
  operationId: `operation-${suffix}`,
  idempotencyKey: null,
  sourceHandle: null,
  toolId: 'fs.read_text',
  toolVersion: '1',
  executionMode: 'read_inline',
  sideEffectClass: 'read',
  status: 'failed',
  dispatchState: null,
  dispatchNonce: null,
  normalizedInputHash: 'a'.repeat(64),
  effectState: 'not_applied',
  ...overrides,
});

const insertToolRun = (database: TestDatabase, values: ToolRunValues): void => {
  database
    .prepare(
      `INSERT INTO tool_runs (
        id, session_id, turn_id, ordinal, logical_call_id,
        source_model_call_id, source_model_attempt_id, attempt, operation_id,
        idempotency_key, source_handle, tool_id, tool_version, execution_mode,
        side_effect_class, status, dispatch_state, dispatch_nonce,
        normalized_input_hash, input_json, result_json, effect_state, pid,
        process_start_identity, error_code, error_message, queued_at,
        started_at, finished_at
      ) VALUES (
        @id, @sessionId, @turnId, @ordinal, @logicalCallId,
        @sourceModelCallId, @sourceModelAttemptId, @attempt, @operationId,
        @idempotencyKey, @sourceHandle, @toolId, @toolVersion, @executionMode,
        @sideEffectClass, @status, @dispatchState, @dispatchNonce,
        @normalizedInputHash, '{}', NULL, @effectState, NULL, NULL, NULL, NULL,
        'now', NULL, NULL
      )`,
    )
    .run(values);
};

describe('daemon SQLite migrations', () => {
  let runtime: TempRuntime | undefined;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('creates and configures a fresh runtime database without a backup', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    await daemon.stop();

    const databasePath = join(runtime.dataDir, 'runtime.sqlite3');
    expect(existsSync(databasePath)).toBe(true);
    expect(lstatSync(databasePath).mode & 0o777).toBe(0o600);

    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000);
      expect(database.pragma('synchronous', { simple: true })).toBe(1);
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
    } finally {
      database.close();
    }

    const backupDirectory = join(runtime.dataDir, 'backups');
    expect(
      existsSync(backupDirectory) ? readdirSync(backupDirectory) : [],
    ).toEqual([]);
  });

  it('rejects a symlink database boundary before opening native SQLite', () => {
    runtime = createTempRuntime();
    const targetPath = join(runtime.rootDir, 'outside-target.sqlite3');
    const databasePath = join(runtime.dataDir, 'runtime.sqlite3');
    writeFileSync(targetPath, 'must-not-open', { mode: 0o640 });
    chmodSync(targetPath, 0o640);
    symlinkSync(targetPath, databasePath);
    let acquired: import('better-sqlite3').Database | undefined;

    try {
      expect(() => {
        acquired = acquireRuntimeDatabase({ dataDir: runtime?.dataDir ?? '' });
      }).toThrow();
      expect(lstatSync(databasePath).isSymbolicLink()).toBe(true);
      expect(readFileSync(targetPath, 'utf8')).toBe('must-not-open');
      expect(lstatSync(targetPath).mode & 0o777).toBe(0o640);
      expect(existsSync(`${databasePath}-wal`)).toBe(false);
      expect(existsSync(`${databasePath}-shm`)).toBe(false);
    } finally {
      acquired?.close();
    }
  });

  it.each([
    {
      name: 'a preflight-to-native-open symlink replacement',
      replaceAfterPreflight: true,
      replaceAfterNativeOpen: false,
      replacementKind: 'symlink' as const,
      expectsNativeHandle: true,
    },
    {
      name: 'a native-open-to-post-check symlink replacement',
      replaceAfterPreflight: false,
      replaceAfterNativeOpen: true,
      replacementKind: 'symlink' as const,
      expectsNativeHandle: true,
    },
    {
      name: 'a preflight-to-native-open regular-file replacement',
      replaceAfterPreflight: true,
      replaceAfterNativeOpen: false,
      replacementKind: 'regular' as const,
      expectsNativeHandle: true,
    },
    {
      name: 'a native-open-to-post-check regular-file replacement',
      replaceAfterPreflight: false,
      replaceAfterNativeOpen: true,
      replacementKind: 'regular' as const,
      expectsNativeHandle: true,
    },
    {
      name: 'an unlink after preflight',
      replaceAfterPreflight: true,
      replaceAfterNativeOpen: false,
      replacementKind: 'unlink' as const,
      expectsNativeHandle: false,
    },
  ])(
    'rejects $name, closes SQLite, and never initializes',
    async ({
      replaceAfterPreflight,
      replaceAfterNativeOpen,
      replacementKind,
      expectsNativeHandle,
    }) => {
      runtime = createTempRuntime();
      const databasePath = join(runtime.dataDir, 'runtime.sqlite3');
      const externalTarget = join(runtime.rootDir, 'external-target.sqlite3');
      const regularReplacement = join(
        runtime.rootDir,
        'regular-replacement.sqlite3',
      );
      writeFileSync(externalTarget, 'external-must-stay-unchanged', {
        mode: 0o640,
      });
      chmodSync(externalTarget, 0o640);
      const replacementDatabase = new Database(regularReplacement);
      try {
        replacementDatabase.exec(
          'CREATE TABLE replacement_fact (value TEXT NOT NULL)',
        );
        replacementDatabase
          .prepare('INSERT INTO replacement_fact (value) VALUES (?)')
          .run('regular-replacement-unchanged');
      } finally {
        replacementDatabase.close();
      }
      chmodSync(regularReplacement, 0o600);
      let capturedDatabase: import('better-sqlite3').Database | undefined;
      let initializeCalled = false;
      const replaceCurrentPath = (): void => {
        rmSync(databasePath, { force: true });
        if (replacementKind === 'symlink') {
          symlinkSync(externalTarget, databasePath);
        } else if (replacementKind === 'regular') {
          renameSync(regularReplacement, databasePath);
        }
      };

      const acquireAndInitialize = async (): Promise<void> => {
        const database = acquireRuntimeDatabase(
          { dataDir: runtime?.dataDir ?? '' },
          {
            afterPreflight: () => {
              if (replaceAfterPreflight) {
                replaceCurrentPath();
              }
            },
            afterNativeOpen: ({ database: openedDatabase }) => {
              capturedDatabase = openedDatabase;
              if (replaceAfterNativeOpen) {
                replaceCurrentPath();
              }
            },
          },
        );
        try {
          initializeCalled = true;
          await initializeRuntimeDatabase(database, {
            dataDir: runtime?.dataDir ?? '',
          });
        } finally {
          database.close();
        }
      };

      await expect(acquireAndInitialize()).rejects.toThrow();
      expect(initializeCalled).toBe(false);
      expect(capturedDatabase !== undefined).toBe(expectsNativeHandle);
      if (capturedDatabase) {
        expect(capturedDatabase.open).toBe(false);
      }
      expect(existsSync(databasePath)).toBe(replacementKind !== 'unlink');
      if (replacementKind === 'symlink') {
        expect(lstatSync(databasePath).isSymbolicLink()).toBe(true);
      } else if (replacementKind === 'regular') {
        expect(lstatSync(databasePath).isFile()).toBe(true);
        expect(lstatSync(databasePath).mode & 0o777).toBe(0o600);
        const replacementReader = new Database(databasePath, { readonly: true });
        try {
          expect(
            replacementReader.prepare('SELECT * FROM replacement_fact').all(),
          ).toEqual([{ value: 'regular-replacement-unchanged' }]);
        } finally {
          replacementReader.close();
        }
      }
      expect(readFileSync(externalTarget, 'utf8')).toBe(
        'external-must-stay-unchanged',
      );
      expect(lstatSync(externalTarget).mode & 0o777).toBe(0o640);
      expect(existsSync(`${databasePath}-wal`)).toBe(false);
      expect(existsSync(`${databasePath}-shm`)).toBe(false);
      expect(existsSync(`${externalTarget}-wal`)).toBe(false);
      expect(existsSync(`${externalTarget}-shm`)).toBe(false);
      expect(existsSync(join(runtime.dataDir, 'backups'))).toBe(false);
    },
  );

  it('preserves path validation when SQLite and descriptor cleanup both fail', () => {
    runtime = createTempRuntime();
    const databasePath = join(runtime.dataDir, 'runtime.sqlite3');
    const externalTarget = join(runtime.rootDir, 'cleanup-target.sqlite3');
    writeFileSync(externalTarget, 'cleanup-target-must-stay-unchanged', {
      mode: 0o640,
    });
    const sqliteCloseFailure = new Error('injected SQLite close failure');
    const descriptorCloseFailure = new Error(
      'injected descriptor close failure',
    );
    let capturedDatabase: import('better-sqlite3').Database | undefined;
    let descriptorCloseCalls = 0;
    let failure: unknown;

    try {
      acquireRuntimeDatabase(
        { dataDir: runtime.dataDir },
        {
          afterNativeOpen: ({ database }) => {
            capturedDatabase = database;
            const closeDatabase = database.close.bind(database);
            Object.defineProperty(database, 'close', {
              configurable: true,
              value: () => {
                closeDatabase();
                throw sqliteCloseFailure;
              },
            });
            rmSync(databasePath, { force: true });
            symlinkSync(externalTarget, databasePath);
          },
          closeDescriptor: (descriptor) => {
            descriptorCloseCalls += 1;
            closeSync(descriptor);
            throw descriptorCloseFailure;
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected aggregated acquisition cleanup failure');
    }
    expect(failure.errors).toHaveLength(3);
    expect(failure.errors).toContain(sqliteCloseFailure);
    expect(failure.errors).toContain(descriptorCloseFailure);
    expect(descriptorCloseCalls).toBe(1);
    expect(capturedDatabase?.open).toBe(false);
    expect(readFileSync(externalTarget, 'utf8')).toBe(
      'cleanup-target-must-stay-unchanged',
    );
  });

  it('does not create a missing data directory without the runtime lock boundary', () => {
    runtime = createTempRuntime();
    const missingDataDir = runtime.dataDir;
    rmSync(missingDataDir, { recursive: true });
    let acquired: import('better-sqlite3').Database | undefined;

    try {
      expect(() => {
        acquired = acquireRuntimeDatabase({ dataDir: missingDataDir });
      }).toThrow();
    } finally {
      acquired?.close();
    }
    expect(existsSync(missingDataDir)).toBe(false);
  });

  it('does not create a database artifact when the kernel lock is already held', async () => {
    runtime = createTempRuntime();
    const lock = await acquireRuntimeLock({
      dataDir: runtime.dataDir,
      socketPath: runtime.socketPath,
      daemonEpoch: '018f0000-0000-7000-8000-000000000099',
      onLost: () => undefined,
    });
    try {
      const loser = runtime.spawnDaemon({
        socketPath: runtime.alternateSocketPath,
      });
      const exit = await loser.waitForExit(2_000);
      expect(exit.code).not.toBe(0);
      expect(existsSync(join(runtime.dataDir, 'runtime.sqlite3'))).toBe(false);
      expect(existsSync(runtime.alternateSocketPath)).toBe(false);
    } finally {
      await lock.release();
    }
  });

  it('installs the exact foundation and execution tables with six deferred references', async () => {
    runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    await daemon.stop();

    const database = openConfiguredDatabase(
      join(runtime.dataDir, 'runtime.sqlite3'),
    );
    try {
      const tableRows = database
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ readonly name: string; readonly sql: string }>;
      expect(tableRows.map((row) => row.name)).toEqual([
        'artifact_versions',
        'artifacts',
        'audit_events',
        'blobs',
        'effect_resolutions',
        'fs_write_effects',
        'messages',
        'model_attempts',
        'model_calls',
        'model_tool_calls',
        'rpc_idempotency',
        'runner_leases',
        'scheduler_slots',
        'schema_migrations',
        'session_events',
        'sessions',
        'sqlite_sequence',
        'tool_runs',
        'tracked_files',
        'turns',
        'workspaces',
      ]);
      const createSql = Object.fromEntries(
        tableRows.map((row) => [row.name, row.sql]),
      );
      expect(
        Object.values(createSql)
          .join('\n')
          .match(/DEFERRABLE\s+INITIALLY\s+DEFERRED/gi),
      ).toHaveLength(6);
      expect(createSql.messages).toMatch(
        /turn_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES\s+turns\s*\(id\)\s+DEFERRABLE\s+INITIALLY\s+DEFERRED/i,
      );
      expect(createSql.turns).toMatch(
        /input_message_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES\s+messages\s*\(id\)\s+DEFERRABLE\s+INITIALLY\s+DEFERRED/i,
      );
      expect(createSql.turns).toMatch(
        /result_message_id\s+TEXT\s+REFERENCES\s+messages\s*\(id\)\s+DEFERRABLE\s+INITIALLY\s+DEFERRED/i,
      );
      expect(createSql.sessions).toMatch(
        /current_turn_id\s+TEXT\s+REFERENCES\s+turns\s*\(id\)\s+DEFERRABLE\s+INITIALLY\s+DEFERRED/i,
      );
      expect(createSql.model_calls).toMatch(
        /successful_attempt_id\s+TEXT\s+REFERENCES\s+model_attempts\s*\(id\)\s+DEFERRABLE\s+INITIALLY\s+DEFERRED/i,
      );
      expect(createSql.artifacts).toMatch(
        /FOREIGN\s+KEY\s*\(\s*id\s*,\s*current_version_id\s*\)\s+REFERENCES\s+artifact_versions\s*\(\s*artifact_id\s*,\s*id\s*\)\s+DEFERRABLE\s+INITIALLY\s+DEFERRED/i,
      );
      expect(
        database
          .pragma('table_info(turns)')
          .find((column: { readonly name: string }) =>
            column.name === 'execution_fence'),
      ).toMatchObject({
        name: 'execution_fence',
        type: 'INTEGER',
        notnull: 1,
        dflt_value: '0',
      });
      expect(
        database
          .pragma('table_info(runner_leases)')
          .slice(-3)
          .map((column: { readonly name: string }) => column.name),
      ).toEqual(['runner_instance_id', 'pid', 'process_start_identity']);
      expect(createSql.turns).not.toMatch(
        /UNIQUE\s*\(\s*session_id\s*,\s*client_request_id\s*\)/i,
      );
      expect(
        database.prepare('SELECT * FROM scheduler_slots').all(),
      ).toEqual([
        {
          slot_no: 1,
          state: 'free',
          owner_turn_id: null,
          updated_at: expect.any(String),
        },
      ]);

      expect(() => {
        database
          .prepare(
            `INSERT INTO sessions (
              id, title, workspace_id, lifecycle_status, runtime_status,
              queue_block_reason, recovery_episode, recovery_source_turn_id,
              current_turn_id, mode, access_mode, next_turn_ordinal,
              next_event_seq, revision, created_at, updated_at
            ) VALUES (
              'missing-parent-session', 'title', 'missing-workspace', 'active',
              'queued', NULL, 0, NULL, NULL, 'craft', 'full_access', 2, 3, 1,
              'now', 'now'
            )`,
          )
          .run();
      }).toThrow();

      const insertCircularFacts = database.transaction(() => {
        database
          .prepare(
            "INSERT INTO workspaces VALUES ('workspace-1', '/path', '/canonical', 'now')",
          )
          .run();
        database
          .prepare(
            `INSERT INTO sessions VALUES (
              'session-1', 'title', 'workspace-1', 'active', 'queued', NULL, 0,
              NULL, 'turn-1', 'craft', 'full_access', 2, 3, 1, 'now', 'now'
            )`,
          )
          .run();
        database
          .prepare(
            `INSERT INTO messages VALUES (
              'message-input', 'session-1', 'turn-1', 'user', 'completed',
              'input', 'now', 'now'
            )`,
          )
          .run();
        database
          .prepare(
            `INSERT INTO messages VALUES (
              'message-result', 'session-1', 'turn-1', 'assistant', 'completed',
              'result', 'now', 'now'
            )`,
          )
          .run();
        database
          .prepare(
            `INSERT INTO turns VALUES (
              'turn-1', 'session-1', 1, 'key', 'normal', 'succeeded',
              'message-input', 'craft', 'full_access', 'now', 'now', 'now',
              NULL, NULL, 'message-result', 0
            )`,
          )
          .run();
      });
      expect(() => insertCircularFacts.immediate()).not.toThrow();

      const incompleteDeferredFacts = database.transaction(() => {
        database
          .prepare(
            "INSERT INTO workspaces VALUES ('workspace-2', '/path-2', '/canonical-2', 'now')",
          )
          .run();
        database
          .prepare(
            `INSERT INTO sessions VALUES (
              'session-2', 'title', 'workspace-2', 'active', 'queued', NULL, 0,
              NULL, 'missing-turn', 'craft', 'full_access', 2, 3, 1, 'now', 'now'
            )`,
          )
          .run();
      });
      expect(() => incompleteDeferredFacts.immediate()).toThrow();
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = 'session-2'")
          .get(),
      ).toEqual({ count: 0 });
      expect(database.pragma('foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rejects every execution-ledger partial and declared unique owner conflict', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    try {
      const turns = Array.from({ length: 12 }, (_value, index) =>
        seedTurn(database, `unique-${index + 1}`),
      );
      const first = turns[0]!;
      insertModelCall(database, {
        id: 'model-call-active',
        ...first,
      });
      expect(() =>
        insertModelCall(database, {
          id: 'model-call-active-conflict',
          ...first,
          ordinal: 2,
        }),
      ).toThrow();
      expect(() =>
        insertModelCall(database, {
          id: 'model-call-ordinal-conflict',
          ...first,
          status: 'failed',
        }),
      ).toThrow();

      const second = turns[1]!;
      insertModelCall(database, { id: 'model-call-attempts', ...second });
      insertModelAttempt(database, {
        id: 'model-attempt-active',
        modelCallId: 'model-call-attempts',
      });
      expect(() =>
        insertModelAttempt(database, {
          id: 'model-attempt-number-conflict',
          modelCallId: 'model-call-attempts',
          status: 'failed',
        }),
      ).toThrow();
      expect(() =>
        insertModelAttempt(database, {
          id: 'model-attempt-active-conflict',
          modelCallId: 'model-call-attempts',
          attempt: 2,
        }),
      ).toThrow();
      database
        .prepare(
          "UPDATE model_attempts SET status = 'succeeded' WHERE id = 'model-attempt-active'",
        )
        .run();
      expect(() =>
        insertModelAttempt(database, {
          id: 'model-attempt-succeeded-conflict',
          modelCallId: 'model-call-attempts',
          attempt: 2,
          status: 'succeeded',
        }),
      ).toThrow();

      database
        .prepare(
          `INSERT INTO model_tool_calls (
            model_attempt_id, logical_call_id, call_index, tool_id,
            arguments_json, normalized_input_hash
          ) VALUES ('model-attempt-active', 'logical-1', 0, 'fs.read_text',
            '{}', ?)` ,
        )
        .run('a'.repeat(64));
      expect(() =>
        database
          .prepare(
            `INSERT INTO model_tool_calls VALUES (
              'model-attempt-active', 'logical-1', 1, 'fs.read_text', '{}', ?
            )`,
          )
          .run('b'.repeat(64)),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO model_tool_calls VALUES (
              'model-attempt-active', 'logical-2', 0, 'fs.read_text', '{}', ?
            )`,
          )
          .run('c'.repeat(64)),
      ).toThrow();

      const sourceOwnership = {
        sourceModelCallId: 'model-call-attempts',
        sourceModelAttemptId: 'model-attempt-active',
      };
      const third = turns[2]!;
      const activeTool = toolRunValues('active', {
        ...third,
        ...sourceOwnership,
      }, { status: 'queued' });
      insertToolRun(database, activeTool);
      expect(() =>
        insertToolRun(
          database,
          toolRunValues(
            'active-conflict',
            { ...third, ...sourceOwnership },
            { ordinal: 2, status: 'running' },
          ),
        ),
      ).toThrow();
      expect(() =>
        insertToolRun(
          database,
          toolRunValues(
            'turn-ordinal-conflict',
            { ...third, ...sourceOwnership },
            { ordinal: 1, status: 'failed' },
          ),
        ),
      ).toThrow();

      const fourth = turns[3]!;
      expect(() =>
        insertToolRun(
          database,
          toolRunValues(
            'source-owner-conflict',
            { ...fourth, ...sourceOwnership },
            {
              logicalCallId: activeTool.logicalCallId,
              attempt: activeTool.attempt,
            },
          ),
        ),
      ).toThrow();
      expect(() =>
        insertToolRun(
          database,
          toolRunValues(
            'operation-conflict',
            { ...fourth, ...sourceOwnership },
            { operationId: activeTool.operationId },
          ),
        ),
      ).toThrow();

      const fifth = turns[4]!;
      const effectOwner = toolRunValues(
        'effect-owner',
        { ...fifth, ...sourceOwnership },
        {
          toolId: 'fs.write_text',
          executionMode: 'worker',
          sideEffectClass: 'local_write',
          idempotencyKey: 'shared-effect-key',
          dispatchState: 'acknowledged',
          dispatchNonce: 'dispatch-owner',
          effectState: 'unknown',
        },
      );
      insertToolRun(database, effectOwner);
      const sixth = turns[5]!;
      expect(() =>
        insertToolRun(
          database,
          toolRunValues(
            'effect-owner-conflict',
            { ...sixth, ...sourceOwnership },
            {
              toolId: 'fs.write_text',
              executionMode: 'worker',
              sideEffectClass: 'local_write',
              idempotencyKey: 'shared-effect-key',
              dispatchState: 'acknowledged',
              dispatchNonce: 'dispatch-other',
              effectState: 'unknown',
            },
          ),
        ),
      ).toThrow();
      const seventh = turns[6]!;
      expect(() =>
        insertToolRun(
          database,
          toolRunValues(
            'dispatch-conflict',
            { ...seventh, ...sourceOwnership },
            {
              toolId: 'fs.write_text',
              executionMode: 'worker',
              sideEffectClass: 'local_write',
              idempotencyKey: 'dispatch-conflict-key',
              dispatchState: 'acknowledged',
              dispatchNonce: effectOwner.dispatchNonce,
              effectState: 'unknown',
            },
          ),
        ),
      ).toThrow();

      const eighth = turns[7]!;
      const handleOwner = toolRunValues(
        'handle-owner',
        { ...eighth, ...sourceOwnership },
        {
          toolId: 'fs.write_text',
          executionMode: 'worker',
          sideEffectClass: 'local_write',
          status: 'succeeded',
          idempotencyKey: 'handle-owner-key',
          sourceHandle: 'source-handle-shared',
          dispatchState: 'acknowledged',
          dispatchNonce: 'dispatch-handle-owner',
          effectState: 'applied',
        },
      );
      insertToolRun(database, handleOwner);
      const ninth = turns[8]!;
      expect(() =>
        insertToolRun(
          database,
          toolRunValues(
            'handle-conflict',
            { ...ninth, ...sourceOwnership },
            {
              toolId: 'fs.write_text',
              executionMode: 'worker',
              sideEffectClass: 'local_write',
              status: 'succeeded',
              idempotencyKey: 'handle-conflict-key',
              sourceHandle: handleOwner.sourceHandle,
              dispatchState: 'acknowledged',
              dispatchNonce: 'dispatch-handle-other',
              effectState: 'applied',
            },
          ),
        ),
      ).toThrow();

      const tenth = turns[9]!;
      database
        .prepare(
          `INSERT INTO runner_leases (
            id, daemon_epoch, lease_epoch, session_id, current_turn_id, status,
            heartbeat_at, lease_expires_at, runner_instance_id, pid,
            process_start_identity
          ) VALUES ('lease-active', 'daemon-1', 1, ?, ?, 'active', 'now',
            'later', NULL, NULL, NULL)`,
        )
        .run(tenth.sessionId, tenth.turnId);
      expect(() =>
        database
          .prepare(
            `INSERT INTO runner_leases (
              id, daemon_epoch, lease_epoch, session_id, current_turn_id,
              status, heartbeat_at, lease_expires_at, runner_instance_id, pid,
              process_start_identity
            ) VALUES ('lease-active-conflict', 'daemon-2', 1, ?, ?, 'active',
              'now', 'later', NULL, NULL, NULL)`,
          )
          .run(tenth.sessionId, tenth.turnId),
      ).toThrow();
      const eleventh = turns[10]!;
      expect(() =>
        database
          .prepare(
            `INSERT INTO runner_leases (
              id, daemon_epoch, lease_epoch, session_id, current_turn_id,
              status, heartbeat_at, lease_expires_at, runner_instance_id, pid,
              process_start_identity
            ) VALUES ('lease-epoch-conflict', 'daemon-1', 1, ?, ?, 'expired',
              'now', 'later', NULL, NULL, NULL)`,
          )
          .run(eleventh.sessionId, eleventh.turnId),
      ).toThrow();

      database
        .prepare(
          `INSERT INTO tracked_files (
            session_id, canonical_path, requested_path, content_sha256, size,
            mtime_ms, device, inode, baseline_source, last_source_tool_run_id,
            updated_at
          ) VALUES (?, '/canonical/file', 'file', ?, 1, 1, 'dev', 'inode',
            'read', ?, 'now')`,
        )
        .run(first.sessionId, 'a'.repeat(64), activeTool.id);
      expect(() =>
        database
          .prepare(
            `INSERT INTO tracked_files VALUES (
              ?, '/canonical/file', 'other', ?, 2, 2, 'dev', 'inode-2',
              'write', ?, 'later'
            )`,
          )
          .run(first.sessionId, 'b'.repeat(64), handleOwner.id),
      ).toThrow();

      database
        .prepare(
          `INSERT INTO fs_write_effects VALUES (
            ?, 'summary.md', '/canonical/summary.md', 1, ?, ?, 12
          )`,
        )
        .run(handleOwner.id, 'a'.repeat(64), 'b'.repeat(64));
      expect(() =>
        database
          .prepare(
            `INSERT INTO fs_write_effects VALUES (
              ?, 'other.md', '/canonical/other.md', 0, NULL, ?, 1
            )`,
          )
          .run(handleOwner.id, 'c'.repeat(64)),
      ).toThrow();

      database
        .prepare(
          `INSERT INTO audit_events (
            id, session_id, turn_id, operation_key, phase, action,
            payload_json, created_at
          ) VALUES ('audit-1', ?, ?, 'operation-audit', 'intent', 'tool.write',
            '{}', 'now')`,
        )
        .run(first.sessionId, first.turnId);
      expect(() =>
        database
          .prepare(
            `INSERT INTO audit_events (
              id, session_id, turn_id, operation_key, phase, action,
              payload_json, created_at
            ) VALUES ('audit-2', ?, ?, 'operation-audit', 'intent',
              'tool.write', '{}', 'now')`,
          )
          .run(first.sessionId, first.turnId),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO audit_events (
              id, session_id, turn_id, operation_key, phase, action,
              payload_json, created_at
            ) VALUES ('audit-1', ?, ?, 'operation-other', 'outcome',
              'tool.write', '{}', 'now')`,
          )
          .run(first.sessionId, first.turnId),
      ).toThrow();

      database
        .prepare(
          `INSERT INTO effect_resolutions (
            id, resolution_key, tool_run_id, resolution, evidence_json, actor,
            created_at
          ) VALUES ('resolution-1', 'resolution-key', ?,
            'confirmed_applied', '{}', 'daemon', 'now')`,
        )
        .run(effectOwner.id);
      expect(() =>
        database
          .prepare(
            `INSERT INTO effect_resolutions VALUES (
              'resolution-2', 'resolution-key', ?, 'confirmed_not_applied',
              '{}', 'daemon', 'now'
            )`,
          )
          .run(handleOwner.id),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('rejects missing execution parents, invalid scalar checks, and every cross-mode ToolRun combination', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    try {
      const owner = seedTurn(database, 'checks');
      insertModelCall(database, { id: 'model-call-checks', ...owner });
      insertModelAttempt(database, {
        id: 'model-attempt-checks',
        modelCallId: 'model-call-checks',
      });
      const ownership = {
        ...owner,
        sourceModelCallId: 'model-call-checks',
        sourceModelAttemptId: 'model-attempt-checks',
      };

      expect(() =>
        insertModelCall(database, {
          id: 'model-call-missing-session',
          sessionId: 'missing-session',
          turnId: owner.turnId,
        }),
      ).toThrow();
      expect(() =>
        insertModelAttempt(database, {
          id: 'model-attempt-missing-call',
          modelCallId: 'missing-model-call',
        }),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO model_tool_calls VALUES (
              'missing-attempt', 'logical', 0, 'fs.read_text', '{}', ?
            )`,
          )
          .run('a'.repeat(64)),
      ).toThrow();
      expect(() =>
        insertToolRun(
          database,
          toolRunValues('missing-source', {
            ...owner,
            sourceModelCallId: 'missing-model-call',
            sourceModelAttemptId: 'missing-model-attempt',
          }),
        ),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO tracked_files VALUES (
              'missing-session', '/missing', 'missing', ?, 0, 0, 'dev',
              'inode', 'read', NULL, 'now'
            )`,
          )
          .run('a'.repeat(64)),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO fs_write_effects VALUES (
              'missing-tool-run', 'file', '/file', 0, NULL, ?, 0
            )`,
          )
          .run('a'.repeat(64)),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO audit_events (
              id, session_id, turn_id, operation_key, phase, action,
              payload_json, created_at
            ) VALUES ('audit-missing', 'missing-session', 'missing-turn',
              'operation', 'intent', 'action', '{}', 'now')`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO effect_resolutions VALUES (
              'resolution-missing', 'resolution-missing', 'missing-tool-run',
              'confirmed_applied', '{}', 'daemon', 'now'
            )`,
          )
          .run(),
      ).toThrow();

      expect(() =>
        database
          .prepare('UPDATE turns SET execution_fence = -1 WHERE id = ?')
          .run(owner.turnId),
      ).toThrow();
      for (const statement of [
        "UPDATE model_calls SET ordinal = 0 WHERE id = 'model-call-checks'",
        "UPDATE model_calls SET kind = 'summary' WHERE id = 'model-call-checks'",
        "UPDATE model_calls SET status = 'queued' WHERE id = 'model-call-checks'",
        "UPDATE model_attempts SET attempt = 0 WHERE id = 'model-attempt-checks'",
        "UPDATE model_attempts SET input_tokens = -1 WHERE id = 'model-attempt-checks'",
        "UPDATE model_attempts SET output_tokens = -1 WHERE id = 'model-attempt-checks'",
        "UPDATE model_attempts SET cached_tokens = -1 WHERE id = 'model-attempt-checks'",
        "UPDATE model_attempts SET latency_ms = -1 WHERE id = 'model-attempt-checks'",
        "UPDATE model_attempts SET retryable = 2 WHERE id = 'model-attempt-checks'",
      ]) {
        expect(() => database.exec(statement)).toThrow();
      }
      expect(() =>
        database
          .prepare(
            `INSERT INTO model_tool_calls VALUES (
              'model-attempt-checks', 'negative-index', -1, 'fs.read_text',
              '{}', ?
            )`,
          )
          .run('a'.repeat(64)),
      ).toThrow();

      const invalidModes: Array<{
        readonly name: string;
        readonly overrides: Partial<ToolRunValues>;
      }> = [
        {
          name: 'read_inline local_write',
          overrides: { sideEffectClass: 'local_write' },
        },
        {
          name: 'read_inline dispatch state',
          overrides: {
            dispatchState: 'prepared',
            dispatchNonce: 'read-dispatch',
          },
        },
        {
          name: 'read_inline applied effect',
          overrides: { effectState: 'applied' },
        },
        {
          name: 'worker read side effect',
          overrides: {
            executionMode: 'worker',
            sideEffectClass: 'read',
            idempotencyKey: 'worker-read',
            dispatchState: 'prepared',
            dispatchNonce: 'worker-read',
          },
        },
        {
          name: 'worker missing operation',
          overrides: {
            executionMode: 'worker',
            sideEffectClass: 'local_write',
            operationId: null,
            idempotencyKey: 'worker-operation',
            dispatchState: 'prepared',
            dispatchNonce: 'worker-operation',
          },
        },
        {
          name: 'worker missing idempotency',
          overrides: {
            executionMode: 'worker',
            sideEffectClass: 'local_write',
            dispatchState: 'prepared',
            dispatchNonce: 'worker-idempotency',
          },
        },
        {
          name: 'worker missing dispatch state',
          overrides: {
            executionMode: 'worker',
            sideEffectClass: 'local_write',
            idempotencyKey: 'worker-state',
            dispatchNonce: 'worker-state',
          },
        },
        {
          name: 'worker missing dispatch nonce',
          overrides: {
            executionMode: 'worker',
            sideEffectClass: 'local_write',
            idempotencyKey: 'worker-nonce',
            dispatchState: 'prepared',
          },
        },
        {
          name: 'transactional intrinsic dispatch state',
          overrides: {
            executionMode: 'transactional_intrinsic',
            sideEffectClass: 'local_write',
            dispatchState: 'prepared',
            dispatchNonce: 'intrinsic-state',
          },
        },
        {
          name: 'transactional intrinsic dispatch nonce',
          overrides: {
            executionMode: 'transactional_intrinsic',
            sideEffectClass: 'local_write',
            dispatchNonce: 'intrinsic-nonce',
          },
        },
        {
          name: 'transactional intrinsic applied effect',
          overrides: {
            executionMode: 'transactional_intrinsic',
            sideEffectClass: 'local_write',
            effectState: 'applied',
          },
        },
        {
          name: 'source handle on another Tool',
          overrides: {
            status: 'succeeded',
            sourceHandle: 'source-handle-wrong-tool',
          },
        },
        {
          name: 'source handle on failed fs.write_text',
          overrides: {
            toolId: 'fs.write_text',
            executionMode: 'worker',
            sideEffectClass: 'local_write',
            idempotencyKey: 'failed-handle',
            sourceHandle: 'source-handle-failed',
            dispatchState: 'acknowledged',
            dispatchNonce: 'failed-handle',
            effectState: 'unknown',
          },
        },
        { name: 'unknown execution mode', overrides: { executionMode: 'fork' } },
        { name: 'unknown status', overrides: { status: 'waiting' } },
        { name: 'unknown effect state', overrides: { effectState: 'maybe' } },
      ];
      for (const { name, overrides } of invalidModes) {
        expect(
          () =>
            insertToolRun(
              database,
              toolRunValues(`invalid-${name.replaceAll(' ', '-')}`, ownership, overrides),
            ),
          name,
        ).toThrow();
      }

      const validTool = toolRunValues('check-valid', ownership);
      insertToolRun(database, validTool);
      database
        .prepare(
          `INSERT INTO tracked_files VALUES (
            ?, '/canonical/check', 'check', ?, 1, 1, 'dev', 'inode', 'read',
            ?, 'now'
          )`,
        )
        .run(owner.sessionId, 'a'.repeat(64), validTool.id);
      for (const statement of [
        "UPDATE tracked_files SET size = -1 WHERE canonical_path = '/canonical/check'",
        "UPDATE tracked_files SET mtime_ms = -1 WHERE canonical_path = '/canonical/check'",
        "UPDATE tracked_files SET baseline_source = 'scan' WHERE canonical_path = '/canonical/check'",
      ]) {
        expect(() => database.exec(statement)).toThrow();
      }
      database
        .prepare(
          `INSERT INTO fs_write_effects VALUES (
            ?, 'check', '/canonical/check', 1, ?, ?, 1
          )`,
        )
        .run(validTool.id, 'a'.repeat(64), 'b'.repeat(64));
      expect(() =>
        database
          .prepare('UPDATE fs_write_effects SET target_existed_before = 2')
          .run(),
      ).toThrow();
      expect(() =>
        database.prepare('UPDATE fs_write_effects SET expected_size = -1').run(),
      ).toThrow();

      database
        .prepare(
          `INSERT INTO audit_events (
            id, session_id, turn_id, operation_key, phase, action,
            payload_json, created_at
          ) VALUES ('audit-check', ?, ?, 'audit-check', 'intent', 'check',
            '{}', 'now')`,
        )
        .run(owner.sessionId, owner.turnId);
      expect(() =>
        database.prepare("UPDATE audit_events SET phase = 'middle'").run(),
      ).toThrow();
      database
        .prepare(
          `INSERT INTO effect_resolutions VALUES (
            'resolution-check', 'resolution-check', ?, 'confirmed_applied',
            '{}', 'daemon', 'now'
          )`,
        )
        .run(validTool.id);
      expect(() =>
        database
          .prepare("UPDATE effect_resolutions SET resolution = 'accepted_unknown'")
          .run(),
      ).toThrow();
      expect(() =>
        database.prepare("UPDATE effect_resolutions SET actor = 'user'").run(),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('enforces Blob and Artifact checks, uniqueness, and the deferred current-Version relation', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    try {
      const owner = seedTurn(database, 'artifact', 'succeeded');
      insertModelCall(database, {
        id: 'model-call-artifact',
        ...owner,
        status: 'succeeded',
      });
      insertModelAttempt(database, {
        id: 'model-attempt-artifact',
        modelCallId: 'model-call-artifact',
        status: 'succeeded',
      });
      const sourceTool = toolRunValues('artifact-source', {
        ...owner,
        sourceModelCallId: 'model-call-artifact',
        sourceModelAttemptId: 'model-attempt-artifact',
      }, { status: 'succeeded' });
      insertToolRun(database, sourceTool);
      const blobSha256 = 'a'.repeat(64);
      database
        .prepare(
          `INSERT INTO blobs (sha256, size, storage_relpath, created_at)
           VALUES (?, 12, 'sha256/aa/blob-a', 'now')`,
        )
        .run(blobSha256);
      expect(() =>
        database
          .prepare(
            `INSERT INTO blobs VALUES (?, 1, 'sha256/aa/blob-a', 'now')`,
          )
          .run('b'.repeat(64)),
      ).toThrow();
      expect(() =>
        database
          .prepare("INSERT INTO blobs VALUES ('short', 1, 'short', 'now')")
          .run(),
      ).toThrow();
      expect(() =>
        database
          .prepare('INSERT INTO blobs VALUES (?, -1, ?, ?)')
          .run('c'.repeat(64), 'negative', 'now'),
      ).toThrow();

      const incompleteArtifact = database.transaction(() => {
        database
          .prepare(
            `INSERT INTO artifacts (
              id, session_id, logical_name, current_version_id, created_at,
              updated_at
            ) VALUES ('artifact-incomplete', ?, 'incomplete',
              'missing-version', 'now', 'now')`,
          )
          .run(owner.sessionId);
      });
      expect(() => incompleteArtifact.immediate()).toThrow();
      expect(
        database
          .prepare("SELECT id FROM artifacts WHERE id = 'artifact-incomplete'")
          .get(),
      ).toBeUndefined();

      const insertArtifact = (
        artifactId: string,
        versionId: string,
        logicalName: string,
        version: number,
        registrationKey: string,
      ): void => {
        const transaction = database.transaction(() => {
          database
            .prepare(
              `INSERT INTO artifacts (
                id, session_id, logical_name, current_version_id, created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, 'now', 'now')`,
            )
            .run(artifactId, owner.sessionId, logicalName, versionId);
          database
            .prepare(
              `INSERT INTO artifact_versions (
                id, artifact_id, version, source_turn_id, source_tool_run_id,
                blob_sha256, visibility, artifact_type, mime_type, filename,
                size, validation_status, registration_key,
                registration_input_hash, provenance_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'final', 'markdown',
                'text/markdown', 'summary.md', 12, 'unchecked', ?, ?, '{}',
                'now')`,
            )
            .run(
              versionId,
              artifactId,
              version,
              owner.turnId,
              sourceTool.id,
              blobSha256,
              registrationKey,
              'd'.repeat(64),
            );
        });
        transaction.immediate();
      };

      insertArtifact('artifact-1', 'artifact-version-1', 'summary', 1, 'register-1');
      insertArtifact('artifact-2', 'artifact-version-2', 'notes', 1, 'register-2');

      const pointAcrossArtifacts = database.transaction(() => {
        database
          .prepare(
            `UPDATE artifacts SET current_version_id = 'artifact-version-2'
             WHERE id = 'artifact-1'`,
          )
          .run();
      });
      expect(() => pointAcrossArtifacts.immediate()).toThrow();
      expect(
        database
          .prepare("SELECT current_version_id FROM artifacts WHERE id = 'artifact-1'")
          .get(),
      ).toEqual({ current_version_id: 'artifact-version-1' });

      expect(() =>
        insertArtifact(
          'artifact-logical-conflict',
          'artifact-version-logical-conflict',
          'summary',
          1,
          'register-logical-conflict',
        ),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO artifact_versions (
              id, artifact_id, version, source_turn_id, source_tool_run_id,
              blob_sha256, visibility, artifact_type, mime_type, filename,
              size, validation_status, registration_key,
              registration_input_hash, provenance_json, created_at
            ) VALUES ('artifact-version-number-conflict', 'artifact-1', 1, ?,
              ?, ?, 'working', 'markdown', 'text/markdown', 'summary-v2.md', 12,
              'valid', 'register-number-conflict', ?, '{}', 'now')`,
          )
          .run(owner.turnId, sourceTool.id, blobSha256, 'e'.repeat(64)),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO artifact_versions (
              id, artifact_id, version, source_turn_id, source_tool_run_id,
              blob_sha256, visibility, artifact_type, mime_type, filename,
              size, validation_status, registration_key,
              registration_input_hash, provenance_json, created_at
            ) VALUES ('artifact-version-registration-conflict', 'artifact-1',
              2, ?, ?, ?, 'evidence', 'markdown', 'text/markdown', 'evidence.md',
              12, 'warning', 'register-1', ?, '{}', 'now')`,
          )
          .run(owner.turnId, sourceTool.id, blobSha256, 'f'.repeat(64)),
      ).toThrow();

      const invalidVersionStatements = [
        ['version', 0],
        ['visibility', 'private'],
        ['artifact_type', 'binary'],
        ['mime_type', 'text/plain'],
        ['size', -1],
        ['validation_status', 'pending'],
      ] as const;
      for (const [column, value] of invalidVersionStatements) {
        expect(() =>
          database
            .prepare(
              `UPDATE artifact_versions SET ${column} = ?
               WHERE id = 'artifact-version-1'`,
            )
            .run(value),
        ).toThrow();
      }
      expect(database.pragma('foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each(['artifact', 'turn', 'tool', 'blob'] as const)(
    'rejects an ArtifactVersion whose %s parent alone is missing',
    async (missingParent) => {
      runtime = createTempRuntime();
      const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
      try {
        const owner = seedTurn(database, `artifact-fk-${missingParent}`, 'succeeded');
        const modelCallId = `model-call-artifact-fk-${missingParent}`;
        const modelAttemptId = `model-attempt-artifact-fk-${missingParent}`;
        insertModelCall(database, {
          id: modelCallId,
          ...owner,
          status: 'succeeded',
        });
        insertModelAttempt(database, {
          id: modelAttemptId,
          modelCallId,
          status: 'succeeded',
        });
        const sourceTool = toolRunValues(
          `artifact-fk-${missingParent}`,
          {
            ...owner,
            sourceModelCallId: modelCallId,
            sourceModelAttemptId: modelAttemptId,
          },
          { status: 'succeeded' },
        );
        insertToolRun(database, sourceTool);
        const blobSha256 = 'a'.repeat(64);
        database
          .prepare('INSERT INTO blobs VALUES (?, 1, ?, \'now\')')
          .run(blobSha256, `blob-${missingParent}`);

        const artifactId =
          missingParent === 'artifact'
            ? 'missing-artifact'
            : `artifact-fk-${missingParent}`;
        const versionId = `artifact-version-fk-${missingParent}`;
        const insertInvalidVersion = database.transaction(() => {
          if (missingParent !== 'artifact') {
            database
              .prepare(
                `INSERT INTO artifacts VALUES (?, ?, ?, ?, 'now', 'now')`,
              )
              .run(
                artifactId,
                owner.sessionId,
                `logical-${missingParent}`,
                versionId,
              );
          }
          database
            .prepare(
              `INSERT INTO artifact_versions (
                id, artifact_id, version, source_turn_id, source_tool_run_id,
                blob_sha256, visibility, artifact_type, mime_type, filename,
                size, validation_status, registration_key,
                registration_input_hash, provenance_json, created_at
              ) VALUES (?, ?, 1, ?, ?, ?, 'final', 'markdown',
                'text/markdown', 'missing.md', 1, 'unchecked', ?, ?, '{}',
                'now')`,
            )
            .run(
              versionId,
              artifactId,
              missingParent === 'turn' ? 'missing-turn' : owner.turnId,
              missingParent === 'tool' ? 'missing-tool' : sourceTool.id,
              missingParent === 'blob' ? 'b'.repeat(64) : blobSha256,
              `register-${missingParent}`,
              'c'.repeat(64),
            );
        });

        expect(() => insertInvalidVersion.immediate()).toThrow();
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it('is idempotent when every installed migration is already applied', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    try {
      const before = database
        .prepare('SELECT * FROM schema_migrations ORDER BY version')
        .all();
      await migrateDatabase(database, { dataDir: runtime.dataDir });
      expect(
        database.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      ).toEqual(before);
      expect(existsSync(join(runtime.dataDir, 'backups'))).toBe(false);
    } finally {
      database.close();
    }
  });

  it.each([
    ['invalid filename', { 'not-a-version.sql': 'SELECT 1;' }],
    ['version 000', { '000_zero.sql': 'SELECT 1;' }],
    [
      'duplicate version',
      { '001_first.sql': 'SELECT 1;', '001_second.sql': 'SELECT 2;' },
    ],
    [
      'version gap',
      { '001_first.sql': 'SELECT 1;', '003_third.sql': 'SELECT 3;' },
    ],
  ])('rejects an installed migration set with %s', (_name, files) => {
    runtime = createTempRuntime();
    const directory = createMigrationDirectory(runtime, files);
    expect(() => discoverMigrations(directory)).toThrow(
      /Invalid migration installation/,
    );
  });

  it.each([
    ['starts at 002', [2], 3],
    ['contains a gap', [1, 3], 3],
    ['contains a duplicate', [1, 1], 3],
    ['is ahead of install', [1, 2], 1],
    ['contains a malformed value', ['one'], 3],
  ])(
    'fails closed when applied history %s',
    async (_name, appliedVersions, installedCount) => {
      runtime = createTempRuntime();
      const files: Record<string, string> = {};
      for (let version = 1; version <= installedCount; version += 1) {
        const padded = String(version).padStart(3, '0');
        files[`${padded}_migration.sql`] =
          version === 1
            ? 'CREATE TABLE schema_migrations (version INTEGER, applied_at TEXT NOT NULL);'
            : `CREATE TABLE marker_${padded} (value TEXT);`;
      }
      const migrationsDirectory = createMigrationDirectory(runtime, files);
      const databasePath = join(runtime.dataDir, 'history.sqlite3');
      const database = openConfiguredDatabase(databasePath);
      try {
        const malformedShape =
          _name === 'contains a duplicate' ||
          _name === 'contains a malformed value';
        database.exec(
          malformedShape
            ? 'CREATE TABLE schema_migrations (version, applied_at TEXT NOT NULL);'
            : `CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
              );`,
        );
        const insert = database.prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        );
        for (const version of appliedVersions) {
          insert.run(version, 'before');
        }
        const before = database
          .prepare('SELECT rowid, * FROM schema_migrations ORDER BY rowid')
          .all();

        await expect(
          migrateDatabase(database, {
            dataDir: runtime.dataDir,
            migrationsDirectory,
          }),
        ).rejects.toThrow(/Invalid migration installation/);
        expect(
          database
            .prepare('SELECT rowid, * FROM schema_migrations ORDER BY rowid')
            .all(),
        ).toEqual(before);
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE name LIKE 'marker_%' ORDER BY name",
            )
            .all(),
        ).toEqual([]);
        expect(existsSync(join(runtime.dataDir, 'backups'))).toBe(false);
      } finally {
        database.close();
      }
    },
  );

  it('rejects a hidden generated schema_migrations column before backup or migration', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_base.sql': `
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `,
      '002_pending.sql': 'CREATE TABLE must_not_install (value TEXT NOT NULL);',
    });
    const database = openConfiguredDatabase(
      join(runtime.dataDir, 'hidden-history.sqlite3'),
    );
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL,
          hidden_copy TEXT GENERATED ALWAYS AS (applied_at) VIRTUAL
        );
        INSERT INTO schema_migrations (version, applied_at) VALUES (1, 'before');
      `);
      expect(database.pragma('table_info(schema_migrations)')).toHaveLength(2);
      expect(
        database.pragma('table_xinfo(schema_migrations)'),
      ).toEqual([
        expect.objectContaining({ name: 'version', hidden: 0 }),
        expect.objectContaining({ name: 'applied_at', hidden: 0 }),
        expect.objectContaining({ name: 'hidden_copy', hidden: 2 }),
      ]);

      await expect(
        migrateDatabase(database, {
          dataDir: runtime.dataDir,
          migrationsDirectory,
        }),
      ).rejects.toThrow(/Invalid migration installation/);
      expect(existsSync(join(runtime.dataDir, 'backups'))).toBe(false);
      expect(tableExists(database, 'must_not_install')).toBe(false);
      expect(
        database.prepare('SELECT version FROM schema_migrations').all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      database.close();
    }
  });

  it('rolls back schema, data, and version when migration 001 fails', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_broken.sql': `
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE transient_fact (value TEXT NOT NULL);
        INSERT INTO transient_fact VALUES ('must-roll-back');
        INSERT INTO table_that_does_not_exist VALUES ('boom');
      `,
    });
    const database = openConfiguredDatabase(join(runtime.dataDir, 'broken-001.sqlite3'));
    try {
      await expect(
        migrateDatabase(database, {
          dataDir: runtime.dataDir,
          migrationsDirectory,
        }),
      ).rejects.toThrow();
      expect(tableExists(database, 'schema_migrations')).toBe(false);
      expect(tableExists(database, 'transient_fact')).toBe(false);
    } finally {
      database.close();
    }
  });

  it('rejects transaction control before a fresh migration can partially commit', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_transaction_escape.sql': `
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE escaped_fact (value TEXT NOT NULL);
        INSERT INTO escaped_fact VALUES ('must-never-commit');
        COMMIT;
        INSERT INTO table_that_does_not_exist VALUES ('boom');
      `,
    });
    const database = openConfiguredDatabase(
      join(runtime.dataDir, 'transaction-escape-001.sqlite3'),
    );
    try {
      let failure: unknown;
      try {
        await migrateDatabase(database, {
          dataDir: runtime.dataDir,
          migrationsDirectory,
        });
      } catch (error) {
        failure = error;
      }

      const schemaExists = tableExists(database, 'schema_migrations');
      const factExists = tableExists(database, 'escaped_fact');
      expect({
        failureMessage:
          failure instanceof Error ? failure.message : String(failure),
        schemaExists,
        factExists,
        facts: factExists
          ? database.prepare('SELECT * FROM escaped_fact').all()
          : [],
        history: schemaExists
          ? database.prepare('SELECT version FROM schema_migrations').all()
          : [],
      }).toEqual({
        failureMessage: expect.stringMatching(
          /^Invalid migration installation:/,
        ),
        schemaExists: false,
        factExists: false,
        facts: [],
        history: [],
      });
    } finally {
      database.close();
    }
  });

  it.each([
    { keyword: 'BEGIN', statement: 'BEGIN;' },
    { keyword: 'COMMIT', statement: 'COMMIT;' },
    { keyword: 'END', statement: 'END TRANSACTION;' },
    { keyword: 'ROLLBACK', statement: 'ROLLBACK;' },
    { keyword: 'SAVEPOINT', statement: 'SAVEPOINT migration_owned;' },
    { keyword: 'RELEASE', statement: 'RELEASE migration_owned;' },
    { keyword: 'COMMIT after a vertical tab', statement: '\u000bCOMMIT;' },
    { keyword: 'COMMIT after a BOM', statement: '\ufeffCOMMIT;' },
  ])(
    'rejects a top-level $keyword transaction-control statement before execution',
    async ({ statement }) => {
      runtime = createTempRuntime();
      const migrationsDirectory = createMigrationDirectory(runtime, {
        '001_forbidden_transaction.sql': `
          CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
          ${statement}
        `,
      });
      const database = openConfiguredDatabase(
        join(runtime.dataDir, 'forbidden-transaction.sqlite3'),
      );
      try {
        let failure: unknown;
        try {
          await migrateDatabase(database, {
            dataDir: runtime.dataDir,
            migrationsDirectory,
          });
        } catch (error) {
          failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(
          /^Invalid migration installation:/,
        );
        expect(tableExists(database, 'schema_migrations')).toBe(false);
      } finally {
        database.close();
      }
    },
  );

  it.each([
    { keyword: 'ROLLBACK', statement: 'ROLLBACK;' },
    { keyword: 'END', statement: 'END TRANSACTION;' },
  ])(
    'validates all pending SQL before backup or an earlier migration when 003 starts with $keyword',
    async ({ statement }) => {
      runtime = createTempRuntime();
      const migrationsDirectory = createMigrationDirectory(runtime, {
        '001_base.sql': `
          CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
          CREATE TABLE stable_fact (value TEXT NOT NULL);
        `,
      });
      const database = openConfiguredDatabase(
        join(runtime.dataDir, 'pending-transaction-control.sqlite3'),
      );
      try {
        await migrateDatabase(database, {
          dataDir: runtime.dataDir,
          migrationsDirectory,
        });
        writeFileSync(
          join(migrationsDirectory, '002_must_not_apply.sql'),
          `
            CREATE TABLE pending_fact (value TEXT NOT NULL);
            INSERT INTO pending_fact VALUES ('must-not-apply');
          `,
          { mode: 0o600 },
        );
        writeFileSync(
          join(migrationsDirectory, '003_forbidden.sql'),
          `
            -- sql-text-must-not-leak
            CREATE TABLE pending_003_fact (value TEXT NOT NULL);
            INSERT INTO pending_003_fact VALUES ('must-not-apply');
            ${statement}
          `,
          { mode: 0o600 },
        );

        let failure: unknown;
        try {
          await migrateDatabase(database, {
            dataDir: runtime.dataDir,
            migrationsDirectory,
          });
        } catch (error) {
          failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        const failureMessage = (failure as Error).message;
        const pendingExists = tableExists(database, 'pending_fact');
        const pending003Exists = tableExists(database, 'pending_003_fact');
        expect({
          failureMessage,
          leaksPath: failureMessage.includes(migrationsDirectory),
          leaksSql: failureMessage.includes('sql-text-must-not-leak'),
          history: database
            .prepare('SELECT version FROM schema_migrations ORDER BY version')
            .all(),
          pendingExists,
          pendingFacts: pendingExists
            ? database.prepare('SELECT * FROM pending_fact').all()
            : [],
          pending003Exists,
          pending003Facts: pending003Exists
            ? database.prepare('SELECT * FROM pending_003_fact').all()
            : [],
          backupExists: existsSync(join(runtime.dataDir, 'backups')),
        }).toEqual({
          failureMessage: expect.stringMatching(
            /^Invalid migration installation:/,
          ),
          leaksPath: false,
          leaksSql: false,
          history: [{ version: 1 }],
          pendingExists: false,
          pendingFacts: [],
          pending003Exists: false,
          pending003Facts: [],
          backupExists: false,
        });
      } finally {
        database.close();
      }
    },
  );

  it('allows transaction keywords in quotes, comments, and trigger expressions', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_lexer_boundaries.sql': `
        -- COMMIT; ROLLBACK; BEGIN; END; SAVEPOINT; RELEASE;
        /* BEGIN TRANSACTION; COMMIT; */
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE source_fact (value TEXT NOT NULL);
        CREATE TABLE audit_fact (value TEXT NOT NULL);
        CREATE TABLE "COMMIT" ("ROLLBACK" TEXT);
        CREATE TABLE \`END\` (\`BEGIN\` TEXT);
        CREATE TABLE [SAVEPOINT] ([RELEASE] TEXT);
        INSERT INTO "COMMIT" VALUES ('COMMIT; ROLLBACK; -- not SQL');
        CREATE TRIGGER audit_source_fact
        AFTER INSERT ON source_fact
        BEGIN
          INSERT OR ROLLBACK INTO audit_fact (value)
          VALUES (
            CASE
              WHEN NEW.value = 'raise' THEN RAISE(ROLLBACK, 'blocked')
              ELSE CASE
                WHEN NEW.value = 'nested' THEN 'nested-case'
                ELSE NEW.value
              END
            END
          );
        END;
        INSERT INTO source_fact VALUES ('migrated');
      `,
    });
    const database = openConfiguredDatabase(
      join(runtime.dataDir, 'lexer-boundaries.sqlite3'),
    );
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      expect(
        database.prepare('SELECT * FROM audit_fact').all(),
      ).toEqual([{ value: 'migrated' }]);
      expect(
        database.prepare('SELECT version FROM schema_migrations').all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      database.close();
    }
  });

  it('detects a genuine top-level COMMIT after a valid trigger body', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_commit_after_trigger.sql': `
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE source_fact (value TEXT NOT NULL);
        CREATE TRIGGER inspect_source_fact
        AFTER INSERT ON source_fact
        BEGIN
          SELECT CASE WHEN NEW.value = 'x' THEN 1 ELSE 0 END;
        END;
        COMMIT;
      `,
    });
    const database = openConfiguredDatabase(
      join(runtime.dataDir, 'commit-after-trigger.sqlite3'),
    );
    try {
      await expect(
        migrateDatabase(database, {
          dataDir: runtime.dataDir,
          migrationsDirectory,
        }),
      ).rejects.toThrow(/^Invalid migration installation:/);
      expect(tableExists(database, 'schema_migrations')).toBe(false);
      expect(tableExists(database, 'source_fact')).toBe(false);
    } finally {
      database.close();
    }
  });

  it('keeps 001 but rolls back every 002 effect when migration 002 fails', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_base.sql': `
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE stable_fact (value TEXT NOT NULL);
      `,
    });
    const database = openConfiguredDatabase(join(runtime.dataDir, 'broken-002.sqlite3'));
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      writeFileSync(
        join(migrationsDirectory, '002_broken.sql'),
        `
          CREATE TABLE transient_fact (value TEXT NOT NULL);
          INSERT INTO transient_fact VALUES ('must-roll-back');
          INSERT INTO table_that_does_not_exist VALUES ('boom');
        `,
        { mode: 0o600 },
      );

      await expect(
        migrateDatabase(database, {
          dataDir: runtime.dataDir,
          migrationsDirectory,
        }),
      ).rejects.toThrow();
      expect(tableExists(database, 'stable_fact')).toBe(true);
      expect(tableExists(database, 'transient_fact')).toBe(false);
      expect(
        database.prepare('SELECT version FROM schema_migrations').all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      database.close();
    }
  });

  it('does not back up a fresh database even when 001 and 002 install together', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_base.sql': `
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE base_fact (value TEXT NOT NULL);
      `,
      '002_next.sql': 'CREATE TABLE next_fact (value TEXT NOT NULL);',
    });
    const database = openConfiguredDatabase(join(runtime.dataDir, 'fresh-two.sqlite3'));
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
      expect(existsSync(join(runtime.dataDir, 'backups'))).toBe(false);
    } finally {
      database.close();
    }
  });

  it('upgrades the shipped 001 schema with exactly one pre-002 backup', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {});
    copyFileSync(
      sourceMigrationPath,
      join(migrationsDirectory, '001_runtime_foundation.sql'),
    );
    const databasePath = join(runtime.dataDir, 'runtime.sqlite3');
    const database = openConfiguredDatabase(databasePath);
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      copyFileSync(
        sourceSchedulerMigrationPath,
        join(migrationsDirectory, '002_scheduler_invariants.sql'),
      );

      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });

      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
      expect(
        database
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'turns_one_active_per_session'",
          )
          .get(),
      ).toEqual({
        sql: "CREATE UNIQUE INDEX turns_one_active_per_session ON turns(session_id) WHERE status IN ('running','cancel_requested')",
      });
      const backups = readdirSync(join(runtime.dataDir, 'backups'));
      expect(backups).toHaveLength(1);
      const backup = new Database(
        join(runtime.dataDir, 'backups', backups[0] as string),
        { readonly: true },
      );
      try {
        expect(
          backup.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
        ).toEqual([{ version: 1 }]);
        expect(
          backup
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'turns_one_active_per_session'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        backup.close();
      }
    } finally {
      database.close();
    }
  });

  it('upgrades the shipped 002 schema with one awaited pre-003 backup before applying 003 and 004', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {});
    copyFileSync(
      sourceMigrationPath,
      join(migrationsDirectory, '001_runtime_foundation.sql'),
    );
    copyFileSync(
      sourceSchedulerMigrationPath,
      join(migrationsDirectory, '002_scheduler_invariants.sql'),
    );
    const database = openConfiguredDatabase(
      join(runtime.dataDir, 'runtime.sqlite3'),
    );
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
      const seedQueuedFacts = database.transaction(() => {
        database.exec(`
          INSERT INTO workspaces (
            id, path, canonical_path, created_at
          ) VALUES (
            'upgrade-workspace', '/upgrade', '/canonical/upgrade', 'before'
          );
          INSERT INTO sessions (
            id, title, workspace_id, lifecycle_status, runtime_status,
            queue_block_reason, recovery_episode, recovery_source_turn_id,
            current_turn_id, mode, access_mode, next_turn_ordinal,
            next_event_seq, revision, created_at, updated_at
          ) VALUES (
            'upgrade-session', 'Upgrade', 'upgrade-workspace', 'active',
            'queued', NULL, 0, NULL, NULL, 'craft', 'full_access', 2, 1, 0,
            'before', 'before'
          );
          INSERT INTO messages (
            id, session_id, turn_id, role, status, content, created_at,
            completed_at
          ) VALUES (
            'upgrade-message', 'upgrade-session', 'upgrade-turn', 'user',
            'completed', 'Persist through 003 and 004', 'before', 'before'
          );
          INSERT INTO turns (
            id, session_id, ordinal, client_request_id, queue_kind, status,
            input_message_id, mode_snapshot, access_mode_snapshot, queued_at,
            started_at, finished_at, error_code, error_message,
            result_message_id
          ) VALUES (
            'upgrade-turn', 'upgrade-session', 1, 'upgrade-request', 'normal',
            'queued', 'upgrade-message', 'craft', 'full_access', 'before',
            NULL, NULL, NULL, NULL, NULL
          );
        `);
      });
      seedQueuedFacts.immediate();

      copyFileSync(
        sourceExecutionMigrationPath,
        join(migrationsDirectory, '003_execution_ledger.sql'),
      );
      copyFileSync(
        sourceArtifactMigrationPath,
        join(migrationsDirectory, '004_artifact_store.sql'),
      );
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });

      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
      ]);
      expect(
        database
          .prepare(
            `SELECT id, session_id, status, input_message_id, execution_fence
             FROM turns WHERE id = 'upgrade-turn'`,
          )
          .get(),
      ).toEqual({
        id: 'upgrade-turn',
        session_id: 'upgrade-session',
        status: 'queued',
        input_message_id: 'upgrade-message',
        execution_fence: 0,
      });
      expect(new SessionRepository(database).getSnapshot('upgrade-session')).toMatchObject({
        session: {
          id: 'upgrade-session',
          runtimeStatus: 'queued',
        },
        messages: [
          {
            id: 'upgrade-message',
            turnId: 'upgrade-turn',
            content: 'Persist through 003 and 004',
          },
        ],
        turns: [
          {
            id: 'upgrade-turn',
            status: 'queued',
            executionFence: 0,
          },
        ],
      });
      const backups = readdirSync(join(runtime.dataDir, 'backups'));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^runtime-before-v003-.+\.sqlite3$/);
      const backup = new Database(
        join(runtime.dataDir, 'backups', backups[0] as string),
        { readonly: true },
      );
      try {
        expect(
          backup.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
        ).toEqual([{ version: 1 }, { version: 2 }]);
        expect(
          backup
            .pragma('table_info(turns)')
            .some((column: { readonly name: string }) =>
              column.name === 'execution_fence'),
        ).toBe(false);
        expect(tableExists(backup, 'model_calls')).toBe(false);
        expect(tableExists(backup, 'artifacts')).toBe(false);
        expect(
          backup
            .prepare(
              `SELECT id, status, input_message_id
               FROM turns WHERE id = 'upgrade-turn'`,
            )
            .get(),
        ).toEqual({
          id: 'upgrade-turn',
          status: 'queued',
          input_message_id: 'upgrade-message',
        });
      } finally {
        backup.close();
      }
    } finally {
      database.close();
    }
  });

  it('rolls back every shipped 003 schema effect and its history row on failure', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {});
    copyFileSync(
      sourceMigrationPath,
      join(migrationsDirectory, '001_runtime_foundation.sql'),
    );
    copyFileSync(
      sourceSchedulerMigrationPath,
      join(migrationsDirectory, '002_scheduler_invariants.sql'),
    );
    const database = openConfiguredDatabase(
      join(runtime.dataDir, 'broken-003.sqlite3'),
    );
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      writeFileSync(
        join(migrationsDirectory, '003_execution_ledger.sql'),
        `${readFileSync(sourceExecutionMigrationPath, 'utf8')}
         INSERT INTO table_that_does_not_exist VALUES ('boom');`,
        { mode: 0o600 },
      );

      await expect(
        migrateDatabase(database, {
          dataDir: runtime.dataDir,
          migrationsDirectory,
        }),
      ).rejects.toThrow();
      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
      expect(
        database
          .pragma('table_info(turns)')
          .some((column: { readonly name: string }) =>
            column.name === 'execution_fence'),
      ).toBe(false);
      expect(tableExists(database, 'model_calls')).toBe(false);
      expect(tableExists(database, 'tool_runs')).toBe(false);
      expect(
        database
          .pragma('table_info(runner_leases)')
          .map((column: { readonly name: string }) => column.name)
          .filter((name: string) =>
            ['runner_instance_id', 'pid', 'process_start_identity'].includes(name),
          ),
      ).toEqual([]);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name IN (
                 'model_calls_one_running_per_turn',
                 'model_attempts_one_running_per_call',
                 'model_attempts_one_succeeded_per_call',
                 'tool_runs_one_active_per_turn',
                 'tool_runs_effectful_idempotency_owner',
                 'runner_leases_one_active_per_turn'
               )`,
          )
          .all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rolls back every shipped 004 schema effect and its history row on failure', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {});
    copyFileSync(
      sourceMigrationPath,
      join(migrationsDirectory, '001_runtime_foundation.sql'),
    );
    copyFileSync(
      sourceSchedulerMigrationPath,
      join(migrationsDirectory, '002_scheduler_invariants.sql'),
    );
    copyFileSync(
      sourceExecutionMigrationPath,
      join(migrationsDirectory, '003_execution_ledger.sql'),
    );
    const database = openConfiguredDatabase(
      join(runtime.dataDir, 'broken-004.sqlite3'),
    );
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      writeFileSync(
        join(migrationsDirectory, '004_artifact_store.sql'),
        `${readFileSync(sourceArtifactMigrationPath, 'utf8')}
         INSERT INTO table_that_does_not_exist VALUES ('boom');`,
        { mode: 0o600 },
      );

      await expect(
        migrateDatabase(database, {
          dataDir: runtime.dataDir,
          migrationsDirectory,
        }),
      ).rejects.toThrow();
      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      expect(tableExists(database, 'model_calls')).toBe(true);
      expect(tableExists(database, 'blobs')).toBe(false);
      expect(tableExists(database, 'artifacts')).toBe(false);
      expect(tableExists(database, 'artifact_versions')).toBe(false);
    } finally {
      database.close();
    }
  });

  it('rolls back shipped migration 002 and its version when old rows violate the active-Turn invariant', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {});
    copyFileSync(
      sourceMigrationPath,
      join(migrationsDirectory, '001_runtime_foundation.sql'),
    );
    const database = openConfiguredDatabase(join(runtime.dataDir, 'runtime.sqlite3'));
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      database.transaction(() => {
        database.exec(`
          INSERT INTO workspaces VALUES ('workspace', '/workspace', '/workspace', 'now');
          INSERT INTO sessions VALUES (
            'session', 'title', 'workspace', 'active', 'running', NULL, 0, NULL,
            'turn-1', 'craft', 'full_access', 3, 1, 0, 'now', 'now'
          );
          INSERT INTO messages VALUES (
            'message-1', 'session', 'turn-1', 'user', 'completed', 'one', 'now', 'now'
          );
          INSERT INTO messages VALUES (
            'message-2', 'session', 'turn-2', 'user', 'completed', 'two', 'now', 'now'
          );
          INSERT INTO turns VALUES (
            'turn-1', 'session', 1, 'request-1', 'normal', 'running', 'message-1',
            'craft', 'full_access', 'now', 'now', NULL, NULL, NULL, NULL
          );
          INSERT INTO turns VALUES (
            'turn-2', 'session', 2, 'request-2', 'normal', 'cancel_requested', 'message-2',
            'craft', 'full_access', 'now', 'now', NULL, NULL, NULL, NULL
          );
        `);
      }).immediate();
    } finally {
      database.close();
    }

    const daemon = runtime.spawnDaemon();
    const exit = await daemon.waitForExit();
    expect(exit.code).not.toBe(0);
    expect(existsSync(runtime.socketPath)).toBe(false);
    const inspection = new Database(join(runtime.dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(
        inspection
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all(),
      ).toEqual([{ version: 1 }]);
      expect(
        inspection
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'turns_one_active_per_session'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        inspection.prepare('SELECT status FROM turns ORDER BY ordinal').all(),
      ).toEqual([{ status: 'running' }, { status: 'cancel_requested' }]);
      expect(readdirSync(join(runtime.dataDir, 'backups'))).toHaveLength(1);
    } finally {
      inspection.close();
    }
  });

  it('preserves initialization failure when closing the acquired database also fails', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_broken.sql': 'THIS IS NOT VALID SQL;',
    });
    const closeFailure = new Error('injected initialization close failure');
    let capturedDatabase: import('better-sqlite3').Database | undefined;
    let failure: unknown;

    try {
      await openRuntimeDatabase(
        { dataDir: runtime.dataDir, migrationsDirectory },
        {
          afterNativeOpen: ({ database }) => {
            capturedDatabase = database;
            const closeDatabase = database.close.bind(database);
            Object.defineProperty(database, 'close', {
              configurable: true,
              value: () => {
                closeDatabase();
                throw closeFailure;
              },
            });
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error('Expected aggregated initialization cleanup failure');
    }
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors).toContain(closeFailure);
    expect(capturedDatabase?.open).toBe(false);
  });

  it('creates one awaited Online Backup with committed WAL data before the first pending migration', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_base.sql': `
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE wal_fact (value TEXT NOT NULL);
      `,
    });
    const databasePath = join(runtime.dataDir, 'wal-backup.sqlite3');
    const database = openConfiguredDatabase(databasePath);
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      database.pragma('wal_checkpoint(TRUNCATE)');
      database.pragma('wal_autocheckpoint = 0');
      database.prepare("INSERT INTO wal_fact VALUES ('committed-in-wal')").run();

      const mainOnlyPath = join(runtime.rootDir, 'main-file-only.sqlite3');
      copyFileSync(databasePath, mainOnlyPath);
      const mainOnly = new Database(mainOnlyPath, { readonly: true });
      try {
        expect(mainOnly.prepare('SELECT * FROM wal_fact').all()).toEqual([]);
      } finally {
        mainOnly.close();
      }

      writeFileSync(
        join(migrationsDirectory, '002_pending.sql'),
        'CREATE TABLE pending_schema (value TEXT NOT NULL);',
        { mode: 0o600 },
      );
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });

      const backupDirectory = join(runtime.dataDir, 'backups');
      expect(lstatSync(backupDirectory).mode & 0o777).toBe(0o700);
      const backups = readdirSync(backupDirectory);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^runtime-before-v002-.+-[0-9a-f-]+\.sqlite3$/);
      const backupPath = join(backupDirectory, backups[0] as string);
      expect(lstatSync(backupPath).mode & 0o777).toBe(0o600);
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(backup.prepare('SELECT * FROM wal_fact').all()).toEqual([
          { value: 'committed-in-wal' },
        ]);
        expect(tableExists(backup, 'pending_schema')).toBe(false);
        expect(
          backup.prepare('SELECT version FROM schema_migrations').all(),
        ).toEqual([{ version: 1 }]);
      } finally {
        backup.close();
      }
      expect(tableExists(database, 'pending_schema')).toBe(true);
      expect(
        database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      database.close();
    }
  });

  it('backs up committed WAL data recovered from a killed daemon before applying the next migration', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = join(runtime.dataDir, 'test-migrations');
    mkdirSync(migrationsDirectory, { mode: 0o700 });
    writeFileSync(
      join(migrationsDirectory, '001_base.sql'),
      `
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE wal_fact (value TEXT NOT NULL);
      `,
      { mode: 0o600 },
    );

    const producer = runtime.spawnDaemon({
      entryPoint: committedWalProducerEntryPoint,
    });
    await producer.waitForReady();

    const databasePath = join(runtime.dataDir, 'runtime.sqlite3');
    const mainOnlyPath = join(runtime.rootDir, 'main-file-only.sqlite3');
    copyFileSync(databasePath, mainOnlyPath);
    const mainOnly = new Database(mainOnlyPath, { readonly: true });
    try {
      expect(
        mainOnly.prepare('SELECT version FROM schema_migrations').all(),
      ).toEqual([{ version: 1 }]);
      expect(mainOnly.prepare('SELECT * FROM wal_fact').all()).toEqual([]);
    } finally {
      mainOnly.close();
    }

    expect(await producer.stop('SIGKILL')).toEqual({
      code: null,
      signal: 'SIGKILL',
    });
    writeFileSync(
      join(migrationsDirectory, '002_pending.sql'),
      'CREATE TABLE pending_schema (value TEXT NOT NULL);',
      { mode: 0o600 },
    );

    const migrator = runtime.spawnDaemon({
      entryPoint: testMigrationsDaemonEntryPoint,
    });
    await migrator.waitForReady();
    await migrator.stop();

    const backupDirectory = join(runtime.dataDir, 'backups');
    const backups = readdirSync(backupDirectory);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(
      /^runtime-before-v002-.+-[0-9a-f-]+\.sqlite3$/,
    );
    const backup = new Database(join(backupDirectory, backups[0] as string), {
      readonly: true,
    });
    try {
      expect(backup.prepare('SELECT * FROM wal_fact').all()).toEqual([
        { value: 'committed-in-child-wal' },
      ]);
      expect(
        backup.prepare('SELECT version FROM schema_migrations').all(),
      ).toEqual([{ version: 1 }]);
      expect(tableExists(backup, 'pending_schema')).toBe(false);
    } finally {
      backup.close();
    }

    const live = new Database(databasePath, { readonly: true });
    try {
      expect(live.prepare('SELECT * FROM wal_fact').all()).toEqual([
        { value: 'committed-in-child-wal' },
      ]);
      expect(
        live
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
      expect(tableExists(live, 'pending_schema')).toBe(true);
    } finally {
      live.close();
    }
  });

  it('does not run a pending migration when the required backup cannot be created', async () => {
    runtime = createTempRuntime();
    const migrationsDirectory = createMigrationDirectory(runtime, {
      '001_base.sql': `
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE base_fact (value TEXT NOT NULL);
      `,
    });
    const database = openConfiguredDatabase(join(runtime.dataDir, 'backup-failure.sqlite3'));
    try {
      await migrateDatabase(database, {
        dataDir: runtime.dataDir,
        migrationsDirectory,
      });
      writeFileSync(
        join(migrationsDirectory, '002_pending.sql'),
        'CREATE TABLE must_not_install (value TEXT NOT NULL);',
        { mode: 0o600 },
      );
      writeFileSync(join(runtime.dataDir, 'backups'), 'not-a-directory', {
        mode: 0o600,
      });

      await expect(
        migrateDatabase(database, {
          dataDir: runtime.dataDir,
          migrationsDirectory,
        }),
      ).rejects.toThrow();
      expect(tableExists(database, 'must_not_install')).toBe(false);
      expect(
        database.prepare('SELECT version FROM schema_migrations').all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      database.close();
    }
  });

  it('copies only current SQL assets into dist and discovers them from compiled code', async () => {
    const distMigrations = join(
      repositoryRoot,
      'services/daemon/dist/db/migrations',
    );
    mkdirSync(distMigrations, { recursive: true });
    const staleMigration = join(distMigrations, '999_stale.sql');
    writeFileSync(staleMigration, 'SELECT 999;', { mode: 0o600 });

    const protocolBuild = spawnSync(
      'pnpm',
      ['--filter', '@agent-workbench/protocol', 'build'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
      },
    );
    expect(
      protocolBuild.status,
      `${protocolBuild.stdout}\n${protocolBuild.stderr}`,
    ).toBe(0);
    const build = spawnSync(
      'pnpm',
      ['--filter', '@agent-workbench/daemon', 'build'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
      },
    );
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    expect(existsSync(staleMigration)).toBe(false);
    expect(
      readFileSync(join(distMigrations, '001_runtime_foundation.sql'), 'utf8'),
    ).toBe(readFileSync(sourceMigrationPath, 'utf8'));
    expect(
      readFileSync(join(distMigrations, '002_scheduler_invariants.sql'), 'utf8'),
    ).toBe(readFileSync(sourceSchedulerMigrationPath, 'utf8'));
    expect(
      readFileSync(join(distMigrations, '003_execution_ledger.sql'), 'utf8'),
    ).toBe(readFileSync(sourceExecutionMigrationPath, 'utf8'));
    expect(
      readFileSync(join(distMigrations, '004_artifact_store.sql'), 'utf8'),
    ).toBe(readFileSync(sourceArtifactMigrationPath, 'utf8'));

    const builtModulePath = join(
      repositoryRoot,
      'services/daemon/dist/db/migrations.js',
    );
    const builtModule = (await import(
      `${pathToFileURL(builtModulePath).href}?test=${randomUUID()}`
    )) as { readonly discoverMigrations: () => Array<{ readonly path: string }> };
    const discovered = builtModule.discoverMigrations();
    expect(discovered).toHaveLength(4);
    expect(discovered[0]?.path).toBe(
      join(distMigrations, '001_runtime_foundation.sql'),
    );
    expect(discovered[1]?.path).toBe(
      join(distMigrations, '002_scheduler_invariants.sql'),
    );
    expect(discovered[2]?.path).toBe(
      join(distMigrations, '003_execution_ledger.sql'),
    );
    expect(discovered[3]?.path).toBe(
      join(distMigrations, '004_artifact_store.sql'),
    );

    runtime = createTempRuntime();
    const builtPackageRoot = join(runtime.rootDir, 'built-daemon-package');
    mkdirSync(builtPackageRoot, { mode: 0o700 });
    cpSync(
      join(repositoryRoot, 'services/daemon/dist'),
      join(builtPackageRoot, 'dist'),
      { recursive: true },
    );
    copyFileSync(
      join(repositoryRoot, 'services/daemon/package.json'),
      join(builtPackageRoot, 'package.json'),
    );
    symlinkSync(
      join(repositoryRoot, 'services/daemon/node_modules'),
      join(builtPackageRoot, 'node_modules'),
      'dir',
    );
    expect(existsSync(join(builtPackageRoot, 'src'))).toBe(false);
    const builtDaemon = runtime.spawnDaemon({
      entryPoint: join(builtPackageRoot, 'dist/index.js'),
      useDevelopmentConditions: false,
    } as never);
    expect(builtDaemon.launchArguments).not.toContain('--conditions=development');
    await builtDaemon.waitForReady();
    await builtDaemon.stop();
    const builtDatabase = new Database(
      join(runtime.dataDir, 'runtime.sqlite3'),
      { readonly: true },
    );
    try {
      expect(
        builtDatabase
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
      ]);
    } finally {
      builtDatabase.close();
    }

    rmSync(join(repositoryRoot, 'services/daemon/dist'), {
      recursive: true,
      force: true,
    });
  }, 40_000);
});
