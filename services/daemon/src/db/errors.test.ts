import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import * as errorsModule from './errors.js';

const requireFromDaemon = createRequire(
  new URL('../../package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

describe('RPC persistence error mapping', () => {
  it.each([
    [
      'SQLITE_BUSY_SNAPSHOT',
      {
        code: 'STORAGE_BUSY',
        category: 'storage',
        message: 'Local storage is temporarily busy',
        retryable: true,
        userAction: 'Retry the request',
      },
    ],
    [
      'SQLITE_LOCKED_SHAREDCACHE',
      {
        code: 'STORAGE_BUSY',
        category: 'storage',
        message: 'Local storage is temporarily busy',
        retryable: true,
        userAction: 'Retry the request',
      },
    ],
    [
      'SQLITE_FULL',
      {
        code: 'STORAGE_FULL',
        category: 'storage',
        message: 'Local storage is full',
        retryable: false,
        userAction: 'Free disk space and retry',
      },
    ],
    [
      'SQLITE_READONLY_DBMOVED',
      {
        code: 'STORAGE_READ_ONLY',
        category: 'storage',
        message: 'Local storage is read-only',
        retryable: false,
        userAction: 'Restore write permission and retry',
      },
    ],
    [
      'SQLITE_CORRUPT_VTAB',
      {
        code: 'STORAGE_CORRUPT',
        category: 'storage',
        message: 'Local storage is corrupted',
        retryable: false,
        userAction: 'Restore from a verified backup or contact support',
      },
    ],
    [
      'SQLITE_NOTADB',
      {
        code: 'STORAGE_CORRUPT',
        category: 'storage',
        message: 'Local storage is corrupted',
        retryable: false,
        userAction: 'Restore from a verified backup or contact support',
      },
    ],
    [
      'SQLITE_IOERR_FSYNC',
      {
        code: 'STORAGE_IO_ERROR',
        category: 'storage',
        message: 'Local storage could not be accessed',
        retryable: false,
        userAction: 'Check disk availability and permissions, then restart the app',
      },
    ],
    [
      'SQLITE_CANTOPEN_FULLPATH',
      {
        code: 'STORAGE_IO_ERROR',
        category: 'storage',
        message: 'Local storage could not be accessed',
        retryable: false,
        userAction: 'Check disk availability and permissions, then restart the app',
      },
    ],
  ])('maps the extended %s driver code without exposing its message', (code, expected) => {
    expect(errorsModule).toHaveProperty('mapRpcFailure');
    const mapRpcFailure = (
      errorsModule as typeof errorsModule & {
        readonly mapRpcFailure: (error: unknown) => unknown;
      }
    ).mapRpcFailure;
    const error = new Database.SqliteError(`secret driver message for ${code}`, code);
    expect(mapRpcFailure(error)).toEqual(expected);
  });

  it.each([
    'SQLITE_CONSTRAINT_TRIGGER',
    'SQLITE_ERROR',
    'SQLITE_MISUSE',
  ])('redacts the unexpected SQLite code %s as an internal error', (code) => {
    expect(errorsModule).toHaveProperty('mapRpcFailure');
    const mapRpcFailure = (
      errorsModule as typeof errorsModule & {
        readonly mapRpcFailure: (error: unknown) => unknown;
      }
    ).mapRpcFailure;
    expect(mapRpcFailure(new Database.SqliteError('secret SQL text', code))).toEqual({
      code: 'RPC_INTERNAL_ERROR',
      category: 'internal',
      message: 'RPC request failed internally',
      retryable: false,
      userAction: null,
    });
  });

  it('redacts non-SQLite programming errors', () => {
    expect(errorsModule).toHaveProperty('mapRpcFailure');
    const mapRpcFailure = (
      errorsModule as typeof errorsModule & {
        readonly mapRpcFailure: (error: unknown) => unknown;
      }
    ).mapRpcFailure;
    expect(mapRpcFailure(new Error('secret path and stack'))).toEqual({
      code: 'RPC_INTERNAL_ERROR',
      category: 'internal',
      message: 'RPC request failed internally',
      retryable: false,
      userAction: null,
    });
  });
});
