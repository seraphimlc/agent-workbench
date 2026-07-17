import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  configureDatabase,
  openRuntimeDatabase,
} from '../db/database.js';
import { SessionService } from './session-service.js';

const requireFromDaemon = createRequire(
  new URL('../../package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

type TempRuntime = {
  readonly rootDir: string;
  readonly dataDir: string;
  cleanup(): void;
};

type RuntimeDatabase = import('better-sqlite3').Database;

type CancelSubject = {
  readonly sessionId: string;
  readonly turnId: string;
};

const createTempRuntime = (): TempRuntime => {
  const rootDir = mkdtempSync(join(tmpdir(), 'awb-session-service-'));
  const dataDir = join(rootDir, 'data');
  chmodSync(rootDir, 0o700);
  mkdirSync(dataDir, { mode: 0o700 });
  return {
    rootDir,
    dataDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
};

const createCancelSubject = (
  runtime: TempRuntime,
  database: RuntimeDatabase,
  suffix: string,
): { readonly service: SessionService; readonly subject: CancelSubject } => {
  const workspacePath = join(runtime.rootDir, `workspace-${suffix}`);
  mkdirSync(workspacePath);
  const service = new SessionService(database);
  const workspace = service.registerWorkspace(
    { path: workspacePath },
    `cancel-subject-workspace-${suffix}`,
  );
  const created = service.createSession(
    { workspaceId: workspace.workspaceId, title: `Cancel ${suffix}`, prompt: 'Queued' },
    `cancel-subject-session-${suffix}`,
  );
  return { service, subject: created };
};

const insertModelCall = (
  database: RuntimeDatabase,
  subject: CancelSubject,
  callId: string,
): void => {
  database
    .prepare(
      `INSERT INTO model_calls (
        id, session_id, turn_id, ordinal, kind, status, profile_snapshot_json,
        input_json, result_json, successful_attempt_id, error_code,
        error_message, created_at, started_at, finished_at
      ) VALUES (?, ?, ?, 1, 'craft', 'running', '{}', '{}', NULL, NULL,
        NULL, NULL, 'now', 'now', NULL)`,
    )
    .run(callId, subject.sessionId, subject.turnId);
};

const insertModelAttempt = (
  database: RuntimeDatabase,
  callId: string,
  attemptId: string,
): void => {
  database
    .prepare(
      `INSERT INTO model_attempts (
        id, model_call_id, attempt, status, provider_request_id,
        partial_output_json, result_json, finish_reason, input_tokens,
        output_tokens, cached_tokens, latency_ms, error_code, error_message,
        retryable, started_at, finished_at
      ) VALUES (?, ?, 1, 'running', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, 'now', NULL)`,
    )
    .run(attemptId, callId);
};

const insertToolRun = (database: RuntimeDatabase, subject: CancelSubject): void => {
  database.pragma('foreign_keys = OFF');
  try {
    database
      .prepare(
        `INSERT INTO tool_runs (
          id, session_id, turn_id, ordinal, logical_call_id,
          source_model_call_id, source_model_attempt_id, attempt,
          operation_id, idempotency_key, source_handle, tool_id, tool_version,
          execution_mode, side_effect_class, status, dispatch_state,
          dispatch_nonce, normalized_input_hash, input_json, result_json,
          effect_state, pid, process_start_identity, error_code, error_message,
          queued_at, started_at, finished_at
        ) VALUES ('cancel-tool-run', ?, ?, 1, 'cancel-logical-call',
          'missing-model-call', 'missing-model-attempt', 1,
          'cancel-tool-operation', NULL, NULL, 'fs.read_text', '1',
          'read_inline', 'read', 'queued', NULL, NULL, 'cancel-input-hash',
          '{}', NULL, 'not_applied', NULL, NULL, NULL, NULL, 'now', NULL, NULL)`,
      )
      .run(subject.sessionId, subject.turnId);
  } finally {
    database.pragma('foreign_keys = ON');
  }
};

const captureCancelState = (database: RuntimeDatabase, subject: CancelSubject): string =>
  JSON.stringify({
    turn: database.prepare('SELECT * FROM turns WHERE id = ?').get(subject.turnId),
    session: database.prepare('SELECT * FROM sessions WHERE id = ?').get(subject.sessionId),
    events: database
      .prepare('SELECT * FROM session_events WHERE turn_id = ? ORDER BY seq')
      .all(subject.turnId),
    slots: database
      .prepare('SELECT * FROM scheduler_slots WHERE owner_turn_id = ?')
      .all(subject.turnId),
    leases: database
      .prepare('SELECT * FROM runner_leases WHERE current_turn_id = ?')
      .all(subject.turnId),
    idempotency: database
      .prepare("SELECT * FROM rpc_idempotency WHERE method = 'turn.cancel' ORDER BY client_request_id")
      .all(),
  });

describe('SessionService transaction boundaries', () => {
  let runtime: TempRuntime | undefined;

  afterEach(async () => {
    runtime?.cleanup();
    runtime = undefined;
  });

  it('holds a write reservation immediately after an idempotency miss', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const competingWriter = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(competingWriter);
    competingWriter.pragma('busy_timeout = 0');
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    let competingCode: string | undefined;
    let competingWriteSucceeded = false;
    const service = new SessionService(database, {
      afterIdempotencyMiss: () => {
        try {
          competingWriter
            .prepare("UPDATE scheduler_slots SET updated_at = 'competing-writer'")
            .run();
          competingWriteSucceeded = true;
        } catch (error) {
          competingCode =
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : undefined;
        }
      },
    } as never);

    try {
      const result = service.registerWorkspace(
        { path: workspacePath },
        'immediate-transaction-key',
      );

      expect(result.workspaceId).toEqual(expect.any(String));
      expect(competingWriteSucceeded).toBe(false);
      expect(competingCode).toMatch(/^SQLITE_BUSY/);
      expect(
        database.prepare('SELECT updated_at FROM scheduler_slots').get(),
      ).not.toEqual({ updated_at: 'competing-writer' });
    } finally {
      competingWriter.close();
      database.close();
    }
  });

  it('cancels one queued Turn exactly once and replays stable idempotency results', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const service = new SessionService(database);
    const workspace = service.registerWorkspace({ path: workspacePath }, 'cancel-workspace');
    const created = service.createSession(
      { workspaceId: workspace.workspaceId, title: 'Cancel', prompt: 'First' },
      'cancel-session',
    );
    const queued = service.enqueueTurn(
      { sessionId: created.sessionId, prompt: 'Second' },
      'cancel-enqueue',
    );

    try {
      const first = service.cancelTurn(
        { sessionId: created.sessionId, turnId: queued.turnId },
        'cancel-key',
      );
      const replay = service.cancelTurn(
        { sessionId: created.sessionId, turnId: queued.turnId },
        'cancel-key',
      );
      const retry = service.cancelTurn(
        { sessionId: created.sessionId, turnId: queued.turnId },
        'cancel-retry-key',
      );

      expect(first).toEqual({ turnId: queued.turnId, status: 'canceled' });
      expect(replay).toEqual(first);
      expect(retry).toEqual(first);
      expect(
        database
          .prepare(
            `SELECT status, started_at AS startedAt, finished_at AS finishedAt,
                    execution_fence AS executionFence
             FROM turns WHERE id = ?`,
          )
          .get(queued.turnId),
      ).toEqual({
        status: 'canceled',
        startedAt: null,
        finishedAt: expect.any(String),
        executionFence: 0,
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM session_events
             WHERE turn_id = ? AND type = 'turn.canceled'`,
          )
          .get(queued.turnId),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            `SELECT runtime_status AS runtimeStatus, next_event_seq AS nextEventSeq, revision
             FROM sessions WHERE id = ?`,
          )
          .get(created.sessionId),
      ).toEqual({ runtimeStatus: 'queued', nextEventSeq: 5, revision: 3 });
    } finally {
      database.close();
    }
  });

  it('preserves active or recovery Session projection and rejects non-queued Turns', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const workspacePath = join(runtime.rootDir, 'workspace');
    mkdirSync(workspacePath);
    const service = new SessionService(database);
    const workspace = service.registerWorkspace({ path: workspacePath }, 'projection-workspace');
    const created = service.createSession(
      { workspaceId: workspace.workspaceId, title: 'Projection', prompt: 'First' },
      'projection-session',
    );
    const queued = service.enqueueTurn(
      { sessionId: created.sessionId, prompt: 'Second' },
      'projection-enqueue',
    );

    try {
      database
        .prepare(
          `UPDATE turns
           SET status = 'interrupted', started_at = '2026-07-17T08:00:00.000Z',
               finished_at = '2026-07-17T08:00:01.000Z', execution_fence = 2
           WHERE id = ?`,
        )
        .run(created.turnId);
      database
        .prepare(
          `UPDATE sessions
           SET runtime_status = 'recovering', current_turn_id = NULL,
               queue_block_reason = 'recovery_review', recovery_episode = 1,
               recovery_source_turn_id = ?
           WHERE id = ?`,
        )
        .run(created.turnId, created.sessionId);

      expect(
        service.cancelTurn(
          { sessionId: created.sessionId, turnId: queued.turnId },
          'projection-cancel',
        ),
      ).toEqual({ turnId: queued.turnId, status: 'canceled' });
      expect(
        database
          .prepare(
            `SELECT runtime_status AS runtimeStatus, queue_block_reason AS queueBlockReason,
                    current_turn_id AS currentTurnId
             FROM sessions WHERE id = ?`,
          )
          .get(created.sessionId),
      ).toEqual({
        runtimeStatus: 'recovering',
        queueBlockReason: 'recovery_review',
        currentTurnId: null,
      });
      let failure: unknown;
      try {
        service.cancelTurn(
          { sessionId: created.sessionId, turnId: created.turnId },
          'running-cancel',
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        failure: { code: 'TURN_NOT_CANCELLABLE', retryable: false },
      });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: 'started_at',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare("UPDATE turns SET started_at = '2026-07-17T08:00:00.000Z' WHERE id = ?")
          .run(subject.turnId);
      },
    },
    {
      name: 'finished_at',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare("UPDATE turns SET finished_at = '2026-07-17T08:00:00.000Z' WHERE id = ?")
          .run(subject.turnId);
      },
    },
    {
      name: 'error_code',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database.prepare("UPDATE turns SET error_code = 'EXECUTED' WHERE id = ?").run(subject.turnId);
      },
    },
    {
      name: 'error_message',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database.prepare("UPDATE turns SET error_message = 'Executed' WHERE id = ?").run(subject.turnId);
      },
    },
    {
      name: 'result_message_id',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            `INSERT INTO messages (
              id, session_id, turn_id, role, status, content, created_at, completed_at
            ) VALUES ('cancel-result-message', ?, ?, 'assistant', 'completed', 'Executed', 'now', 'now')`,
          )
          .run(subject.sessionId, subject.turnId);
        database
          .prepare("UPDATE turns SET result_message_id = 'cancel-result-message' WHERE id = ?")
          .run(subject.turnId);
      },
    },
    {
      name: 'execution_fence',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database.prepare('UPDATE turns SET execution_fence = 1 WHERE id = ?').run(subject.turnId);
      },
    },
    {
      name: 'Session current_turn_id',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database.prepare('UPDATE sessions SET current_turn_id = ? WHERE id = ?').run(
          subject.turnId,
          subject.sessionId,
        );
      },
    },
    {
      name: 'runner Lease',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            `INSERT INTO runner_leases (
              id, daemon_epoch, lease_epoch, session_id, current_turn_id, status,
              heartbeat_at, lease_expires_at
            ) VALUES ('cancel-lease', 'cancel-daemon', 1, ?, ?, 'active', 'now', 'later')`,
          )
          .run(subject.sessionId, subject.turnId);
      },
    },
    {
      name: 'scheduler slot owner',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            "UPDATE scheduler_slots SET state = 'owned', owner_turn_id = ? WHERE slot_no = 1",
          )
          .run(subject.turnId);
      },
    },
    {
      name: 'turn.started Event',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            `INSERT INTO session_events (
              id, session_id, turn_id, tool_run_id, seq, type, actor, audience,
              payload_json, blob_id, created_at
            ) VALUES ('cancel-started-event', ?, ?, NULL, 3, 'turn.started', 'daemon', 'both',
              '{"ordinal":1,"queueKind":"normal","slotNo":1}', NULL, 'now')`,
          )
          .run(subject.sessionId, subject.turnId);
      },
    },
    {
      name: 'model call and attempt',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        insertModelCall(database, subject, 'cancel-model-call');
        insertModelAttempt(database, 'cancel-model-call', 'cancel-model-attempt');
      },
    },
    {
      name: 'tool run',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        insertToolRun(database, subject);
      },
    },
  ])('fails closed without cancel writes when a queued Turn has $name', async ({ corrupt }) => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const { service, subject } = createCancelSubject(runtime, database, 'corrupt');
    corrupt(database, subject);
    const before = captureCancelState(database, subject);

    try {
      let failure: unknown;
      try {
        service.cancelTurn(subject, 'corrupt-cancel');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        failure: { code: 'TURN_NOT_CANCELLABLE', retryable: false },
      });
      expect(captureCancelState(database, subject)).toBe(before);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM rpc_idempotency WHERE method = 'turn.cancel'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('fails closed when a corrupted canceled Turn is replayed with any request id', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const { service, subject } = createCancelSubject(runtime, database, 'canceled-replay');

    try {
      expect(service.cancelTurn(subject, 'canceled-replay-key')).toEqual({
        turnId: subject.turnId,
        status: 'canceled',
      });
      database.prepare('UPDATE turns SET execution_fence = 1 WHERE id = ?').run(subject.turnId);
      const before = captureCancelState(database, subject);

      let failure: unknown;
      try {
        service.cancelTurn(subject, 'canceled-replay-key');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        failure: { code: 'TURN_NOT_CANCELLABLE', retryable: false },
      });
      expect(captureCancelState(database, subject)).toBe(before);

      failure = undefined;
      try {
        service.cancelTurn(subject, 'canceled-replay-other-key');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        failure: { code: 'TURN_NOT_CANCELLABLE', retryable: false },
      });
      expect(captureCancelState(database, subject)).toBe(before);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: 'recovery review projected as queued',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            `UPDATE sessions
             SET queue_block_reason = 'recovery_review', runtime_status = 'queued',
                 recovery_episode = 1, recovery_source_turn_id = ?
             WHERE id = ?`,
          )
          .run(subject.turnId, subject.sessionId);
      },
    },
    {
      name: 'recovery review retaining a current Turn',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            `UPDATE sessions
             SET queue_block_reason = 'recovery_review', runtime_status = 'recovering',
                 recovery_episode = 1, recovery_source_turn_id = ?, current_turn_id = ?
             WHERE id = ?`,
          )
          .run(subject.turnId, subject.turnId, subject.sessionId);
      },
    },
    {
      name: 'recovery review without a positive episode',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            `UPDATE sessions
             SET queue_block_reason = 'recovery_review', runtime_status = 'recovering',
                 recovery_episode = 0, recovery_source_turn_id = ?
             WHERE id = ?`,
          )
          .run(subject.turnId, subject.sessionId);
      },
    },
    {
      name: 'recovery review without a source Turn',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            `UPDATE sessions
             SET queue_block_reason = 'recovery_review', runtime_status = 'recovering',
                 recovery_episode = 1, recovery_source_turn_id = NULL
             WHERE id = ?`,
          )
          .run(subject.sessionId);
      },
    },
    {
      name: 'recovering runtime without recovery markers',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare("UPDATE sessions SET runtime_status = 'recovering' WHERE id = ?")
          .run(subject.sessionId);
      },
    },
  ])('fails closed without writes for $name', async ({ corrupt }) => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const { service, subject } = createCancelSubject(runtime, database, 'recovery-conflict');
    corrupt(database, subject);
    const before = captureCancelState(database, subject);

    try {
      let failure: unknown;
      try {
        service.cancelTurn(subject, 'recovery-conflict-cancel');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        failure: { code: 'TURN_NOT_CANCELLABLE', retryable: false },
      });
      expect(captureCancelState(database, subject)).toBe(before);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM rpc_idempotency WHERE method = 'turn.cancel'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: 'actor',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare("UPDATE session_events SET actor = 'runner' WHERE turn_id = ? AND type = 'turn.canceled'")
          .run(subject.turnId);
      },
    },
    {
      name: 'audience',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare("UPDATE session_events SET audience = 'ui' WHERE turn_id = ? AND type = 'turn.canceled'")
          .run(subject.turnId);
      },
    },
    {
      name: 'payload',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            `UPDATE session_events
             SET payload_json = '{"ordinal":2,"queueKind":"normal"}'
             WHERE turn_id = ? AND type = 'turn.canceled'`,
          )
          .run(subject.turnId);
      },
    },
    {
      name: 'timestamp',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            "UPDATE session_events SET created_at = '2000-01-01T00:00:00.000Z' WHERE turn_id = ? AND type = 'turn.canceled'",
          )
          .run(subject.turnId);
      },
    },
    {
      name: 'sequence',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare('UPDATE session_events SET seq = 4 WHERE turn_id = ? AND type = \'turn.canceled\'')
          .run(subject.turnId);
      },
    },
    {
      name: 'recovery projection',
      corrupt: (database: RuntimeDatabase, subject: CancelSubject) => {
        database
          .prepare(
            `UPDATE sessions
             SET queue_block_reason = 'recovery_review', runtime_status = 'queued',
                 recovery_episode = 1, recovery_source_turn_id = ?
             WHERE id = ?`,
          )
          .run(subject.turnId, subject.sessionId);
      },
    },
  ])('rejects a noncanonical canceled replay with corrupt $name and no writes', async ({ corrupt }) => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const { service, subject } = createCancelSubject(runtime, database, 'canonical-replay');

    try {
      service.cancelTurn(subject, 'canonical-replay-key');
      corrupt(database, subject);
      const before = captureCancelState(database, subject);

      let failure: unknown;
      try {
        service.cancelTurn(subject, 'canonical-replay-key');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        failure: { code: 'TURN_NOT_CANCELLABLE', retryable: false },
      });
      expect(captureCancelState(database, subject)).toBe(before);
    } finally {
      database.close();
    }
  });
});
