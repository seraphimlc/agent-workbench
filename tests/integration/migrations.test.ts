import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  openRuntimeDatabase,
} from '../../services/daemon/src/db/database.js';
import {
  discoverMigrations,
  migrateDatabase,
} from '../../services/daemon/src/db/migrations.js';
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
      ).toEqual([{ version: 1 }]);
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

  it('installs the exact foundation tables, scheduler row, and four deferred circular references', async () => {
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
        'messages',
        'rpc_idempotency',
        'runner_leases',
        'scheduler_slots',
        'schema_migrations',
        'session_events',
        'sessions',
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
      ).toHaveLength(4);
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
              NULL, NULL, 'message-result'
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

    const builtModulePath = join(
      repositoryRoot,
      'services/daemon/dist/db/migrations.js',
    );
    const builtModule = (await import(
      `${pathToFileURL(builtModulePath).href}?test=${randomUUID()}`
    )) as { readonly discoverMigrations: () => Array<{ readonly path: string }> };
    const discovered = builtModule.discoverMigrations();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.path).toBe(
      join(distMigrations, '001_runtime_foundation.sql'),
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
      ).toEqual([{ version: 1 }]);
    } finally {
      builtDatabase.close();
    }

    rmSync(join(repositoryRoot, 'services/daemon/dist'), {
      recursive: true,
      force: true,
    });
  }, 40_000);
});
