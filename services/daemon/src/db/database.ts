import { chmodSync, mkdirSync } from 'node:fs';
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

export const openRuntimeDatabase = async (
  options: OpenRuntimeDatabaseOptions,
): Promise<Database.Database> => {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const databasePath = join(options.dataDir, DATABASE_FILENAME);
  const database = new Database(databasePath);

  try {
    chmodSync(databasePath, 0o600);
    configureDatabase(database);
    await migrateDatabase(database, options);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};
