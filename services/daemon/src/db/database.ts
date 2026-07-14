import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  type BigIntStats,
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

export interface AcquireRuntimeDatabaseHooks {
  readonly afterPreflight?: (context: { readonly databasePath: string }) => void;
  readonly afterNativeOpen?: (context: {
    readonly databasePath: string;
    readonly database: Database.Database;
  }) => void;
  readonly closeDescriptor?: (descriptor: number) => void;
}

const modeBits = (status: BigIntStats): number =>
  Number(status.mode & 0o777n);

const assertOwnedRegularFile = (status: BigIntStats): void => {
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    typeof process.getuid !== 'function' ||
    status.uid !== BigInt(process.getuid()) ||
    modeBits(status) !== 0o600
  ) {
    throw new Error('Invalid SQLite database file boundary');
  }
};

const assertSameIdentity = (
  expected: BigIntStats,
  actual: BigIntStats,
): void => {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('SQLite database file changed during open');
  }
};

const throwCollectedErrors = (
  errors: readonly unknown[],
  message: string,
): never => {
  const primaryError = errors[0];
  if (errors.length === 1) {
    throw primaryError;
  }
  throw new AggregateError(errors, message, { cause: primaryError });
};

const collectError = (errors: unknown[], action: () => void): void => {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
};

/**
 * Requires the caller to hold the runtime owner lock and to supply an existing,
 * real data directory owned by the current uid with mode 0700.
 */
export const acquireRuntimeDatabase = (
  options: OpenRuntimeDatabaseOptions,
  hooks: AcquireRuntimeDatabaseHooks = {},
): Database.Database => {
  const databasePath = join(options.dataDir, DATABASE_FILENAME);
  const closeDescriptor = hooks.closeDescriptor ?? closeSync;
  let preflightDescriptor: number | undefined;
  let currentDescriptor: number | undefined;
  let database: Database.Database | undefined;
  const errors: unknown[] = [];

  try {
    preflightDescriptor = openSync(
      databasePath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const initialStatus = fstatSync(preflightDescriptor, { bigint: true });
    if (
      !initialStatus.isFile() ||
      typeof process.getuid !== 'function' ||
      initialStatus.uid !== BigInt(process.getuid())
    ) {
      throw new Error('Invalid SQLite database file boundary');
    }
    fchmodSync(preflightDescriptor, 0o600);
    const preflightStatus = fstatSync(preflightDescriptor, { bigint: true });
    assertOwnedRegularFile(preflightStatus);
    const preflightPathStatus = lstatSync(databasePath, { bigint: true });
    assertOwnedRegularFile(preflightPathStatus);
    assertSameIdentity(preflightStatus, preflightPathStatus);

    hooks.afterPreflight?.({ databasePath });
    database = new Database(databasePath, { fileMustExist: true });
    hooks.afterNativeOpen?.({ databasePath, database });

    currentDescriptor = openSync(
      databasePath,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    const currentStatus = fstatSync(currentDescriptor, { bigint: true });
    const currentPathStatus = lstatSync(databasePath, { bigint: true });
    assertOwnedRegularFile(currentStatus);
    assertOwnedRegularFile(currentPathStatus);
    assertSameIdentity(currentStatus, currentPathStatus);
    assertSameIdentity(preflightStatus, currentStatus);
  } catch (error) {
    errors.push(error);
  }

  if (currentDescriptor !== undefined) {
    const descriptor = currentDescriptor;
    collectError(errors, () => {
      closeDescriptor(descriptor);
    });
  }

  if (errors.length === 0 && preflightDescriptor !== undefined) {
    const descriptor = preflightDescriptor;
    preflightDescriptor = undefined;
    collectError(errors, () => {
      closeDescriptor(descriptor);
    });
  }

  if (errors.length > 0) {
    if (database?.open) {
      const openedDatabase = database;
      collectError(errors, () => {
        openedDatabase.close();
      });
    }
    if (preflightDescriptor !== undefined) {
      const descriptor = preflightDescriptor;
      collectError(errors, () => {
        closeDescriptor(descriptor);
      });
    }
    throwCollectedErrors(errors, 'SQLite database acquisition failed');
  }

  if (database === undefined) {
    throw new Error('SQLite database acquisition failed');
  }
  return database;
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
  hooks: AcquireRuntimeDatabaseHooks = {},
): Promise<Database.Database> => {
  const database = acquireRuntimeDatabase(options, hooks);

  try {
    await initializeRuntimeDatabase(database, options);
    return database;
  } catch (error) {
    const errors: unknown[] = [error];
    if (database.open) {
      collectError(errors, () => {
        database.close();
      });
    }
    return throwCollectedErrors(
      errors,
      'SQLite database initialization failed',
    );
  }
};
