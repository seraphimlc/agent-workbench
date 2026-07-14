import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { migrateDatabase, type MigrationOptions } from './migrations.js';

const DATABASE_FILENAME = 'runtime.sqlite3';

const expectPragma = (
  database: Database.Database,
  pragma: string,
  expected: string | number,
): void => {
  const actual = database.pragma(pragma, { simple: true });
  if (actual !== expected) {
    throw new Error(`SQLite pragma verification failed: ${pragma}`);
  }
};

export const configureDatabase = (database: Database.Database): void => {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');

  expectPragma(database, 'journal_mode', 'wal');
  expectPragma(database, 'foreign_keys', 1);
  expectPragma(database, 'busy_timeout', 5_000);
  expectPragma(database, 'synchronous', 1);
};

export interface OpenRuntimeDatabaseOptions
  extends Omit<MigrationOptions, 'dataDir'> {
  readonly dataDir: string;
}

export const acquireRuntimeDatabase = (
  options: OpenRuntimeDatabaseOptions,
): Database.Database => {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const databasePath = join(options.dataDir, DATABASE_FILENAME);
  const descriptor = openSync(
    databasePath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const initialStatus = fstatSync(descriptor);
    if (
      !initialStatus.isFile() ||
      typeof process.getuid !== 'function' ||
      initialStatus.uid !== process.getuid()
    ) {
      throw new Error('Invalid SQLite database file boundary');
    }
    fchmodSync(descriptor, 0o600);
    const securedStatus = fstatSync(descriptor);
    if ((securedStatus.mode & 0o777) !== 0o600) {
      throw new Error('SQLite database file must have mode 0600');
    }
  } finally {
    closeSync(descriptor);
  }

  return new Database(databasePath);
};

export const initializeRuntimeDatabase = async (
  database: Database.Database,
  options: OpenRuntimeDatabaseOptions,
): Promise<void> => {
  configureDatabase(database);
  await migrateDatabase(database, options);
};

export const openRuntimeDatabase = async (
  options: OpenRuntimeDatabaseOptions,
): Promise<Database.Database> => {
  const database = acquireRuntimeDatabase(options);

  try {
    await initializeRuntimeDatabase(database, options);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};
