import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';

const MIGRATION_FILE_PATTERN = /^(\d{3})_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/;
const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('./migrations', import.meta.url),
);

export interface InstalledMigration {
  readonly version: number;
  readonly filename: string;
  readonly path: string;
}

export interface MigrationOptions {
  readonly dataDir: string;
  readonly migrationsDirectory?: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

const migrationError = (message: string, options?: ErrorOptions): Error =>
  new Error(`Invalid migration installation: ${message}`, options);

export const discoverMigrations = (
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): InstalledMigration[] => {
  const sqlFilenames = readdirSync(migrationsDirectory).filter((filename) =>
    filename.endsWith('.sql'),
  );
  if (sqlFilenames.length === 0) {
    throw migrationError('no SQL migrations were installed');
  }

  const migrations = sqlFilenames.map((filename) => {
    const match = MIGRATION_FILE_PATTERN.exec(filename);
    if (!match) {
      throw migrationError(`invalid filename ${filename}`);
    }

    const version = Number(match[1]);
    if (version === 0) {
      throw migrationError('version 000 is forbidden');
    }

    return {
      version,
      filename,
      path: join(migrationsDirectory, filename),
    };
  });

  migrations.sort(
    (left, right) =>
      left.version - right.version || left.filename.localeCompare(right.filename),
  );
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index] as InstalledMigration;
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      if (migrations[index - 1]?.version === migration.version) {
        throw migrationError(`duplicate version ${migration.version}`);
      }
      throw migrationError(
        `expected version ${String(expectedVersion).padStart(3, '0')}`,
      );
    }
  }

  return migrations;
};

const hasMigrationTable = (database: Database.Database): boolean => {
  const row = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get() as { readonly present: number } | undefined;
  return row?.present === 1;
};

const assertMigrationTableShape = (database: Database.Database): void => {
  const columns = database.pragma('table_xinfo(schema_migrations)') as Array<{
    readonly cid: number;
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly pk: number;
    readonly hidden: number;
  }>;
  const exactShape =
    columns.length === 2 &&
    columns[0]?.cid === 0 &&
    columns[0]?.name === 'version' &&
    columns[0]?.type.toUpperCase() === 'INTEGER' &&
    columns[0]?.notnull === 0 &&
    columns[0]?.pk === 1 &&
    columns[0]?.hidden === 0 &&
    columns[1]?.cid === 1 &&
    columns[1]?.name === 'applied_at' &&
    columns[1]?.type.toUpperCase() === 'TEXT' &&
    columns[1]?.notnull === 1 &&
    columns[1]?.pk === 0 &&
    columns[1]?.hidden === 0;
  if (!exactShape) {
    throw migrationError('schema_migrations has an invalid shape');
  }
};

const readAppliedVersions = (database: Database.Database): number[] => {
  if (!hasMigrationTable(database)) {
    return [];
  }
  assertMigrationTableShape(database);

  let rows: Array<{ readonly version: unknown }>;
  try {
    rows = database
      .prepare('SELECT version FROM schema_migrations ORDER BY rowid')
      .all() as Array<{ readonly version: unknown }>;
  } catch (error) {
    throw migrationError('schema_migrations could not be read', { cause: error });
  }

  return rows.map((row) => {
    if (typeof row.version !== 'number' || !Number.isSafeInteger(row.version)) {
      throw migrationError('applied version is not an integer');
    }
    return row.version;
  });
};

const assertAppliedPrefix = (
  appliedVersions: readonly number[],
  installedMigrations: readonly InstalledMigration[],
): void => {
  if (appliedVersions.length > installedMigrations.length) {
    throw migrationError('database history is ahead of installed migrations');
  }

  for (let index = 0; index < appliedVersions.length; index += 1) {
    const expectedVersion = index + 1;
    if (
      appliedVersions[index] !== expectedVersion ||
      installedMigrations[index]?.version !== expectedVersion
    ) {
      throw migrationError('database history is not an installed continuous prefix');
    }
  }
};

const timestampForFilename = (date: Date): string =>
  date.toISOString().replace(/[:.]/g, '-');

const createBackup = async (
  database: Database.Database,
  pendingVersion: number,
  options: MigrationOptions,
): Promise<void> => {
  const backupDirectory = join(options.dataDir, 'backups');
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  const now = options.now?.() ?? new Date();
  const createId = options.createId ?? uuidv7;
  const destinationPath = join(
    backupDirectory,
    `runtime-before-v${String(pendingVersion).padStart(3, '0')}-${timestampForFilename(now)}-${createId()}.sqlite3`,
  );

  await database.backup(destinationPath);
  chmodSync(destinationPath, 0o600);
};

export const migrateDatabase = async (
  database: Database.Database,
  options: MigrationOptions,
): Promise<void> => {
  const installedMigrations = discoverMigrations(options.migrationsDirectory);
  const appliedVersions = readAppliedVersions(database);
  assertAppliedPrefix(appliedVersions, installedMigrations);
  const pendingMigrations = installedMigrations.slice(appliedVersions.length);

  if (appliedVersions.length > 0 && pendingMigrations.length > 0) {
    await createBackup(database, pendingMigrations[0]!.version, options);
  }

  for (const migration of pendingMigrations) {
    const sql = readFileSync(migration.path, 'utf8');
    const apply = database.transaction(() => {
      database.exec(sql);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(migration.version, new Date().toISOString());
    });
    apply.immediate();
  }
};
