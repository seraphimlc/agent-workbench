import type { ErrorCategory } from '@agent-workbench/protocol';
import Database from 'better-sqlite3';

export interface RpcFailure {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly userAction: string | null;
}

export class DomainError extends Error {
  readonly failure: RpcFailure;

  constructor(failure: RpcFailure) {
    super(failure.message);
    this.name = 'DomainError';
    this.failure = failure;
  }
}

const domainFailure = (
  code: string,
  message: string,
  userAction: string,
): DomainError =>
  new DomainError({
    code,
    category: 'validation',
    message,
    retryable: false,
    userAction,
  });

export const domainErrors = {
  idempotencyConflict: (): DomainError =>
    domainFailure(
      'IDEMPOTENCY_CONFLICT',
      'Client request id was already used with different input',
      'Retry with a new client request id',
    ),
  workspacePathInvalid: (): DomainError =>
    domainFailure(
      'WORKSPACE_PATH_INVALID',
      'Workspace path must reference an existing directory',
      'Choose an existing workspace directory',
    ),
  workspaceNotFound: (): DomainError =>
    domainFailure(
      'WORKSPACE_NOT_FOUND',
      'Workspace was not found',
      'Register or choose an existing workspace',
    ),
  sessionNotFound: (): DomainError =>
    domainFailure(
      'SESSION_NOT_FOUND',
      'Session was not found',
      'Refresh and choose an existing session',
    ),
  eventCursorAhead: (): DomainError =>
    domainFailure(
      'EVENT_CURSOR_AHEAD',
      'Event cursor is ahead of the current session history',
      'Reload the session snapshot',
    ),
} as const;

const internalFailure = (): RpcFailure => ({
  code: 'RPC_INTERNAL_ERROR',
  category: 'internal',
  message: 'RPC request failed internally',
  retryable: false,
  userAction: null,
});

const hasSqlitePrefix = (code: string, prefix: string): boolean =>
  code === prefix || code.startsWith(`${prefix}_`);

export const mapRpcFailure = (error: unknown): RpcFailure => {
  if (error instanceof DomainError) {
    return error.failure;
  }
  if (!(error instanceof Database.SqliteError)) {
    return internalFailure();
  }

  const { code } = error;
  if (hasSqlitePrefix(code, 'SQLITE_BUSY') || hasSqlitePrefix(code, 'SQLITE_LOCKED')) {
    return {
      code: 'STORAGE_BUSY',
      category: 'storage',
      message: 'Local storage is temporarily busy',
      retryable: true,
      userAction: 'Retry the request',
    };
  }
  if (hasSqlitePrefix(code, 'SQLITE_FULL')) {
    return {
      code: 'STORAGE_FULL',
      category: 'storage',
      message: 'Local storage is full',
      retryable: false,
      userAction: 'Free disk space and retry',
    };
  }
  if (hasSqlitePrefix(code, 'SQLITE_READONLY')) {
    return {
      code: 'STORAGE_READ_ONLY',
      category: 'storage',
      message: 'Local storage is read-only',
      retryable: false,
      userAction: 'Restore write permission and retry',
    };
  }
  if (
    hasSqlitePrefix(code, 'SQLITE_CORRUPT') ||
    hasSqlitePrefix(code, 'SQLITE_NOTADB')
  ) {
    return {
      code: 'STORAGE_CORRUPT',
      category: 'storage',
      message: 'Local storage is corrupted',
      retryable: false,
      userAction: 'Restore from a verified backup or contact support',
    };
  }
  if (
    hasSqlitePrefix(code, 'SQLITE_IOERR') ||
    hasSqlitePrefix(code, 'SQLITE_CANTOPEN')
  ) {
    return {
      code: 'STORAGE_IO_ERROR',
      category: 'storage',
      message: 'Local storage could not be accessed',
      retryable: false,
      userAction: 'Check disk availability and permissions, then restart the app',
    };
  }
  return internalFailure();
};
