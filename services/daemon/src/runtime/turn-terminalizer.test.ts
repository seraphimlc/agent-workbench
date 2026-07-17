import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { configureDatabase, openRuntimeDatabase } from '../db/database.js';
import { SessionEventWriter } from '../db/session-event-writer.js';
import { Scheduler, type Claim } from './scheduler.js';
import { SessionService } from './session-service.js';
import {
  TurnTerminalizer,
  type TerminalizationWriteGroup,
} from './turn-terminalizer.js';

const DAEMON_EPOCH = '018f0000-0000-7000-8000-000000001000';
const CLAIM_TIME = '2026-07-15T01:00:00.000Z';
const FINISH_TIME = '2026-07-15T01:01:00.000Z';
const requireFromDaemon = createRequire(new URL('../../package.json', import.meta.url));
const BetterSqlite3 = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

type TempRuntime = {
  readonly rootDir: string;
  readonly dataDir: string;
  cleanup(): void;
};

type ActiveFixture = {
  readonly database: Database.Database;
  readonly claim: Claim;
  readonly sessionId: string;
  readonly turnId: string;
  readonly queuedTurnId: string | null;
};

type ForeignSession = {
  readonly sessionId: string;
  readonly turnId: string;
};

const createTempRuntime = (): TempRuntime => {
  const rootDir = mkdtempSync(join(tmpdir(), 'awb-terminalizer-'));
  const dataDir = join(rootDir, 'data');
  chmodSync(rootDir, 0o700);
  mkdirSync(dataDir, { mode: 0o700 });
  return {
    rootDir,
    dataDir,
    cleanup: () => rmSync(rootDir, { force: true, recursive: true }),
  };
};

const createIdFactory = (prefix: string): (() => string) => {
  let ordinal = 0;
  return () => `${prefix}-${String(++ordinal)}`;
};

const createActiveFixture = async (
  runtime: TempRuntime,
  options: { readonly queuedFollower?: boolean } = {},
): Promise<ActiveFixture> => {
  const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
  const sessions = new SessionService(database);
  const workspacePath = join(runtime.rootDir, 'workspace');
  mkdirSync(workspacePath);
  const workspace = sessions.registerWorkspace(
    { path: workspacePath },
    `workspace-${runtime.rootDir}`,
  );
  const created = sessions.createSession(
    {
      workspaceId: workspace.workspaceId,
      title: 'Atomic terminalization',
      prompt: 'Complete this Turn',
    },
    `session-${runtime.rootDir}`,
  );
  const queuedTurnId = options.queuedFollower
    ? sessions.enqueueTurn(
        { sessionId: created.sessionId, prompt: 'Run after the first Turn' },
        `enqueue-${runtime.rootDir}`,
      ).turnId
    : null;
  const scheduler = new Scheduler(database, {
    daemonEpoch: DAEMON_EPOCH,
    now: () => new Date(CLAIM_TIME),
    createId: createIdFactory('claim'),
  });
  const claim = scheduler.claimNext();
  if (!claim) {
    throw new Error('Fixture Turn was not claimed');
  }
  return {
    database,
    claim,
    sessionId: created.sessionId,
    turnId: created.turnId,
    queuedTurnId,
  };
};

const createSecondActiveFixture = (
  runtime: TempRuntime,
  database: Database.Database,
): ActiveFixture => {
  const sessions = new SessionService(database);
  const workspacePath = join(runtime.rootDir, 'workspace-second');
  mkdirSync(workspacePath);
  const workspace = sessions.registerWorkspace(
    { path: workspacePath },
    `workspace-second-${runtime.rootDir}`,
  );
  const created = sessions.createSession(
    {
      workspaceId: workspace.workspaceId,
      title: 'Independent terminalization',
      prompt: 'Complete this other Turn',
    },
    `session-second-${runtime.rootDir}`,
  );
  const claim = new Scheduler(database, {
    daemonEpoch: DAEMON_EPOCH,
    now: () => new Date(CLAIM_TIME),
    createId: createIdFactory('second-claim'),
  }).claimNext();
  if (!claim) {
    throw new Error('Second fixture Turn was not claimed');
  }
  return {
    database,
    claim,
    sessionId: created.sessionId,
    turnId: created.turnId,
    queuedTurnId: null,
  };
};

const createForeignSession = (
  database: Database.Database,
  fixture: Pick<ActiveFixture, 'sessionId'>,
): ForeignSession => {
  const workspace = database
    .prepare('SELECT workspace_id AS workspaceId FROM sessions WHERE id = ?')
    .get(fixture.sessionId) as { readonly workspaceId: string };
  const created = new SessionService(database).createSession(
    {
      workspaceId: workspace.workspaceId,
      title: 'Foreign session',
      prompt: 'Foreign prompt',
    },
    'foreign-session-create',
  );
  return { sessionId: created.sessionId, turnId: created.turnId };
};

const insertSucceededAttempt = (
  database: Database.Database,
  turn: Pick<ActiveFixture, 'sessionId' | 'turnId'>,
  options: {
    readonly callId?: string;
    readonly attemptId?: string;
    readonly callOrdinal?: number;
    readonly attemptOrdinal?: number;
    readonly content?: string;
    readonly toolCalls?: readonly unknown[];
  } = {},
): { readonly callId: string; readonly attemptId: string } => {
  const callId = options.callId ?? 'model-call-final';
  const attemptId = options.attemptId ?? 'model-attempt-final';
  const result = {
    finishReason: 'stop',
    content: options.content ?? 'Completed',
    toolCalls: options.toolCalls ?? [],
  };
  const transaction = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO model_calls (
          id, session_id, turn_id, ordinal, kind, status,
          profile_snapshot_json, input_json, result_json,
          successful_attempt_id, error_code, error_message,
          created_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, 'craft', 'succeeded', '{}', '{}', ?, NULL,
          NULL, NULL, ?, ?, ?)`,
      )
      .run(
        callId,
        turn.sessionId,
        turn.turnId,
        options.callOrdinal ?? 1,
        JSON.stringify(result),
        CLAIM_TIME,
        CLAIM_TIME,
        FINISH_TIME,
      );
    database
      .prepare(
        `INSERT INTO model_attempts (
          id, model_call_id, attempt, status, provider_request_id,
          partial_output_json, result_json, finish_reason,
          input_tokens, output_tokens, cached_tokens, latency_ms,
          error_code, error_message, retryable, started_at, finished_at
        ) VALUES (?, ?, ?, 'succeeded', NULL, NULL, ?, 'stop',
          1, 1, 0, 10, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        attemptId,
        callId,
        options.attemptOrdinal ?? 1,
        JSON.stringify(result),
        CLAIM_TIME,
        FINISH_TIME,
      );
    database
      .prepare('UPDATE model_calls SET successful_attempt_id = ? WHERE id = ?')
      .run(attemptId, callId);
  });
  transaction.immediate();
  return { callId, attemptId };
};

const insertActiveSubexecutions = (
  database: Database.Database,
  turn: Pick<ActiveFixture, 'sessionId' | 'turnId'>,
  options: {
    readonly effectState?: 'not_applied' | 'applied' | 'unknown';
    readonly executionMode?: 'read_inline' | 'worker' | 'transactional_intrinsic';
    readonly worker?: boolean;
    readonly callOrdinal?: number;
    readonly dispatchState?: 'prepared' | 'worker_ready' | 'go_sent' | 'acknowledged';
    readonly toolStatus?: 'queued' | 'running' | 'cancel_requested';
  } = {},
): { readonly callId: string; readonly attemptId: string; readonly toolRunId: string } => {
  const callId = 'model-call-active';
  const attemptId = 'model-attempt-active';
  const toolRunId = 'tool-run-active';
  database
    .prepare(
      `INSERT INTO model_calls (
        id, session_id, turn_id, ordinal, kind, status,
        profile_snapshot_json, input_json, result_json,
        successful_attempt_id, error_code, error_message,
        created_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, 'craft', 'running', '{}', '{}', NULL, NULL,
        NULL, NULL, ?, ?, NULL)`,
    )
    .run(
      callId,
      turn.sessionId,
      turn.turnId,
      options.callOrdinal ?? 1,
      CLAIM_TIME,
      CLAIM_TIME,
    );
  database
    .prepare(
      `INSERT INTO model_attempts (
        id, model_call_id, attempt, status, provider_request_id,
        partial_output_json, result_json, finish_reason,
        input_tokens, output_tokens, cached_tokens, latency_ms,
        error_code, error_message, retryable, started_at, finished_at
      ) VALUES (?, ?, 1, 'running', NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
    )
    .run(attemptId, callId, CLAIM_TIME);
  const executionMode = options.executionMode ?? (options.worker ? 'worker' : 'read_inline');
  const worker = executionMode === 'worker';
  const toolStatus = options.toolStatus ?? 'running';
  const toolId = worker
    ? 'fs.write_text'
    : executionMode === 'read_inline'
      ? 'fs.read_text'
      : 'runtime.test';
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
      ) VALUES (?, ?, ?, 1, 'logical-call-1', ?, ?, 1,
        'operation-1', ?, NULL, ?, '1', ?, ?, ?, ?, ?,
        'input-hash', '{}', NULL, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
    )
    .run(
      toolRunId,
      turn.sessionId,
      turn.turnId,
      callId,
      attemptId,
      worker ? 'idempotency-1' : null,
      toolId,
      executionMode,
      executionMode === 'read_inline' ? 'read' : 'local_write',
      toolStatus,
      worker ? (options.dispatchState ?? 'go_sent') : null,
      worker ? 'dispatch-1' : null,
      options.effectState ?? 'not_applied',
      CLAIM_TIME,
      toolStatus === 'queued' ? null : CLAIM_TIME,
    );
  return { callId, attemptId, toolRunId };
};

const insertTerminalToolRun = (
  database: Database.Database,
  turn: Pick<ActiveFixture, 'sessionId' | 'turnId'>,
  options: {
    readonly suffix?: string;
    readonly ordinal?: number;
    readonly status: 'succeeded' | 'failed' | 'canceled' | 'interrupted';
    readonly dispatchState: 'prepared' | 'worker_ready' | 'go_sent' | 'acknowledged';
    readonly effectState: 'not_applied' | 'applied' | 'unknown';
  },
): string => {
  const suffix = options.suffix ?? 'terminal';
  const ordinal = options.ordinal ?? 1;
  const logicalCallId = `logical-call-${suffix}`;
  const source = insertSucceededAttempt(database, turn, {
    callId: `model-call-${suffix}`,
    attemptId: `model-attempt-${suffix}`,
    callOrdinal: ordinal,
    toolCalls: [{ logicalCallId, toolId: 'fs.write_text', arguments: {} }],
  });
  database
    .prepare(
      `INSERT INTO model_tool_calls (
        model_attempt_id, logical_call_id, call_index, tool_id,
        arguments_json, normalized_input_hash
      ) VALUES (?, ?, 0, 'fs.write_text', '{}', ?)`,
    )
    .run(source.attemptId, logicalCallId, `input-${suffix}`);
  const toolRunId = `tool-run-${suffix}`;
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, 'fs.write_text', '1',
        'worker', 'local_write', ?, ?, ?, ?, '{}', '{}', ?, NULL, NULL,
        NULL, NULL, ?, ?, ?)`,
    )
    .run(
      toolRunId,
      turn.sessionId,
      turn.turnId,
      ordinal,
      logicalCallId,
      source.callId,
      source.attemptId,
      `operation-${suffix}`,
      `idempotency-${suffix}`,
      options.status,
      options.dispatchState,
      `dispatch-${suffix}`,
      `input-${suffix}`,
      options.effectState,
      CLAIM_TIME,
      CLAIM_TIME,
      FINISH_TIME,
    );
  return toolRunId;
};

const insertImmutableArtifact = (
  database: Database.Database,
  turn: Pick<ActiveFixture, 'sessionId' | 'turnId'>,
): void => {
  const source = insertSucceededAttempt(database, turn, {
    callId: 'artifact-model-call',
    attemptId: 'artifact-model-attempt',
    callOrdinal: 1,
    toolCalls: [
      {
        logicalCallId: 'artifact-call',
        toolId: 'fs.write_text',
        arguments: {},
      },
    ],
  });
  database
    .prepare(
      `INSERT INTO model_tool_calls (
        model_attempt_id, logical_call_id, call_index, tool_id,
        arguments_json, normalized_input_hash
      ) VALUES (?, 'artifact-call', 0, 'fs.write_text', '{}', 'artifact-input')`,
    )
    .run(source.attemptId);
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
      ) VALUES ('artifact-tool-run', ?, ?, 1, 'artifact-call', ?, ?, 1,
        'artifact-operation', 'artifact-idempotency', 'artifact-source',
        'fs.write_text', '1', 'worker', 'local_write', 'succeeded',
        'acknowledged', 'artifact-dispatch', 'artifact-input', '{}', '{}',
        'applied', NULL, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      turn.sessionId,
      turn.turnId,
      source.callId,
      source.attemptId,
      CLAIM_TIME,
      CLAIM_TIME,
      FINISH_TIME,
    );
  const transaction = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO blobs (sha256, size, storage_relpath, created_at)
         VALUES (?, 9, 'blobs/artifact.md', ?)`,
      )
      .run('a'.repeat(64), CLAIM_TIME);
    database
      .prepare(
        `INSERT INTO artifacts (
          id, session_id, logical_name, current_version_id, created_at, updated_at
        ) VALUES ('artifact-1', ?, 'summary', 'artifact-version-1', ?, ?)`,
      )
      .run(turn.sessionId, CLAIM_TIME, CLAIM_TIME);
    database
      .prepare(
        `INSERT INTO artifact_versions (
          id, artifact_id, version, source_turn_id, source_tool_run_id,
          blob_sha256, visibility, artifact_type, mime_type, filename, size,
          validation_status, registration_key, registration_input_hash,
          provenance_json, created_at
        ) VALUES (
          'artifact-version-1', 'artifact-1', 1, ?, 'artifact-tool-run', ?,
          'final', 'markdown', 'text/markdown', 'summary.md', 9, 'valid',
          'artifact-registration', 'artifact-registration-hash', '{}', ?
        )`,
      )
      .run(turn.turnId, 'a'.repeat(64), CLAIM_TIME);
  });
  transaction.immediate();
};

const captureFacts = (database: Database.Database): string =>
  JSON.stringify({
    sessions: database.prepare('SELECT * FROM sessions ORDER BY id').all(),
    messages: database.prepare('SELECT * FROM messages ORDER BY id').all(),
    turns: database.prepare('SELECT * FROM turns ORDER BY id').all(),
    events: database
      .prepare('SELECT * FROM session_events ORDER BY session_id, seq')
      .all(),
    slots: database.prepare('SELECT * FROM scheduler_slots ORDER BY slot_no').all(),
    leases: database.prepare('SELECT * FROM runner_leases ORDER BY id').all(),
    modelCalls: database.prepare('SELECT * FROM model_calls ORDER BY id').all(),
    modelAttempts: database.prepare('SELECT * FROM model_attempts ORDER BY id').all(),
    modelToolCalls: database
      .prepare('SELECT * FROM model_tool_calls ORDER BY model_attempt_id, call_index')
      .all(),
    toolRuns: database.prepare('SELECT * FROM tool_runs ORDER BY id').all(),
    resolutions: database.prepare('SELECT * FROM effect_resolutions ORDER BY id').all(),
    blobs: database.prepare('SELECT * FROM blobs ORDER BY sha256').all(),
    artifacts: database.prepare('SELECT * FROM artifacts ORDER BY id').all(),
    artifactVersions: database
      .prepare('SELECT * FROM artifact_versions ORDER BY id')
      .all(),
  });

const captureTupleFacts = (
  database: Database.Database,
  fixture: Pick<ActiveFixture, 'claim' | 'sessionId' | 'turnId'>,
): string =>
  JSON.stringify({
    session: database.prepare('SELECT * FROM sessions WHERE id = ?').get(fixture.sessionId),
    turn: database.prepare('SELECT * FROM turns WHERE id = ?').get(fixture.turnId),
    lease: database.prepare('SELECT * FROM runner_leases WHERE id = ?').get(fixture.claim.leaseId),
    slot: database
      .prepare('SELECT * FROM scheduler_slots WHERE slot_no = ?')
      .get(fixture.claim.slotNo),
    events: database
      .prepare('SELECT * FROM session_events WHERE session_id = ? ORDER BY seq')
      .all(fixture.sessionId),
  });

const activeWorkerExpected = new Map<
  string,
  readonly ['canceled' | 'interrupted', 'not_applied' | 'unknown']
>([
  ['queued/prepared/unknown', ['canceled', 'not_applied']],
  ['queued/worker_ready/unknown', ['canceled', 'not_applied']],
  ['running/go_sent/unknown', ['interrupted', 'unknown']],
  ['running/acknowledged/unknown', ['interrupted', 'unknown']],
  ['cancel_requested/go_sent/unknown', ['interrupted', 'unknown']],
  ['cancel_requested/acknowledged/unknown', ['interrupted', 'unknown']],
]);

const workerActiveMatrixCases = (
  ['queued', 'running', 'cancel_requested'] as const
).flatMap((status) =>
  (['prepared', 'worker_ready', 'go_sent', 'acknowledged'] as const).flatMap(
    (dispatchState) =>
      (['not_applied', 'applied', 'unknown'] as const).map((effectState) => {
        const expected = activeWorkerExpected.get(
          `${status}/${dispatchState}/${effectState}`,
        );
        return {
          name: `${status} + ${dispatchState} + ${effectState}`,
          status,
          dispatchState,
          effectState,
          valid: expected !== undefined,
          expectedStatus: expected?.[0],
          expectedEffectState: expected?.[1],
        };
      }),
  ),
);

describe('TurnTerminalizer', () => {
  let runtime: TempRuntime | undefined;

  afterEach(() => {
    runtime?.cleanup();
    runtime = undefined;
  });

  it('terminalizes only the requested active tuple when two slots are owned', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const other = createSecondActiveFixture(runtime, fixture.database);
    const otherBefore = captureTupleFacts(fixture.database, other);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('two-tuple'),
    });

    try {
      terminalizer.fail({
        binding: fixture.claim,
        errorCode: 'RUNNER_START_FAILED',
        errorMessage: 'Runner failed to become ready',
      });

      expect(
        fixture.database
          .prepare('SELECT status, execution_fence FROM turns WHERE id = ?')
          .get(fixture.turnId),
      ).toEqual({ status: 'failed', execution_fence: fixture.claim.executionFence + 1 });
      expect(captureTupleFacts(fixture.database, other)).toBe(otherBefore);
    } finally {
      fixture.database.close();
    }
  });

  it('fails closed before target writes when another active tuple is cross-linked', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const other = createSecondActiveFixture(runtime, fixture.database);
    fixture.database
      .prepare('UPDATE runner_leases SET session_id = ? WHERE id = ?')
      .run(fixture.sessionId, other.claim.leaseId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('two-tuple-corrupt'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'RUNNER_START_FAILED',
          errorMessage: 'Runner failed to become ready',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('fails closed before writes when another active Lease has another daemon epoch', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const other = createSecondActiveFixture(runtime, fixture.database);
    fixture.database
      .prepare('UPDATE runner_leases SET daemon_epoch = ? WHERE id = ?')
      .run('018f0000-0000-7000-8000-000000009999', other.claim.leaseId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('two-tuple-other-epoch'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'RUNNER_START_FAILED',
          errorMessage: 'Runner failed to become ready',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('interrupts a batch in slot order when both active tuples are valid', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const other = createSecondActiveFixture(runtime, fixture.database);
    fixture.database.exec(`
      CREATE TABLE terminalizer_write_order (slot_no INTEGER NOT NULL);
      CREATE TRIGGER record_terminalizer_slot_order
      AFTER UPDATE OF state ON scheduler_slots
      WHEN OLD.state = 'owned' AND NEW.state = 'free'
      BEGIN
        INSERT INTO terminalizer_write_order (slot_no) VALUES (OLD.slot_no);
      END;
    `);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('batch-interrupt'),
    });

    try {
      terminalizer.interruptMany([
        {
          binding: other.claim,
          reason: 'daemon_restart',
          executorExited: true,
        },
        {
          binding: fixture.claim,
          reason: 'daemon_restart',
          executorExited: true,
        },
      ]);

      expect(
        fixture.database
          .prepare('SELECT status FROM turns WHERE id IN (?, ?) ORDER BY id')
          .all(fixture.turnId, other.turnId),
      ).toEqual([{ status: 'interrupted' }, { status: 'interrupted' }]);
      expect(
        fixture.database
          .prepare('SELECT slot_no FROM terminalizer_write_order ORDER BY rowid')
          .all(),
      ).toEqual([{ slot_no: 1 }, { slot_no: 2 }]);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects a batch that omits another active tuple before writes', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    createSecondActiveFixture(runtime, fixture.database);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('batch-complete-set'),
    });

    try {
      expect(() =>
        terminalizer.interruptMany([
          {
            binding: fixture.claim,
            reason: 'daemon_restart',
            executorExited: true,
          },
        ]),
      ).toThrow(/batch.*active tuple/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('interrupts two active tuples independently without changing the other tuple', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const other = createSecondActiveFixture(runtime, fixture.database);
    const otherBefore = captureTupleFacts(fixture.database, other);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('independent-interrupt'),
    });

    try {
      terminalizer.interrupt({
        binding: fixture.claim,
        reason: 'daemon_shutdown',
        executorExited: true,
      });
      expect(captureTupleFacts(fixture.database, other)).toBe(otherBefore);

      terminalizer.interrupt({
        binding: other.claim,
        reason: 'daemon_shutdown',
        executorExited: true,
      });
      expect(
        fixture.database
          .prepare('SELECT status FROM turns WHERE id IN (?, ?) ORDER BY id')
          .all(fixture.turnId, other.turnId),
      ).toEqual([{ status: 'interrupted' }, { status: 'interrupted' }]);
    } finally {
      fixture.database.close();
    }
  });

  it('validates every batch input before its first write', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const other = createSecondActiveFixture(runtime, fixture.database);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('batch-input-validation'),
    });

    try {
      expect(() =>
        terminalizer.interruptMany([
          {
            binding: fixture.claim,
            reason: 'daemon_restart',
            executorExited: true,
          },
          {
            binding: other.claim,
            reason: 'daemon_restart',
            executorExited: false,
          },
        ]),
      ).toThrow(/executor exit/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rolls back the first batch tuple when the second tuple write group fails', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const other = createSecondActiveFixture(runtime, fixture.database);
    const before = captureFacts(fixture.database);
    const injected = new Error('second tuple fence failure');
    let fenceWrites = 0;
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('batch-rollback'),
      hooks: {
        afterWriteGroup: (group) => {
          if (group === 'fence' && ++fenceWrites === 2) {
            throw injected;
          }
        },
      },
    });

    try {
      expect(() =>
        terminalizer.interruptMany([
          {
            binding: fixture.claim,
            reason: 'daemon_restart',
            executorExited: true,
          },
          {
            binding: other.claim,
            reason: 'daemon_restart',
            executorExited: true,
          },
        ]),
      ).toThrow(injected);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it.each(['succeed', 'fail', 'interrupt'] as const)(
    'rejects $operation before writes when a Terminal ToolRun tuple is invalid',
    async (operation) => {
      runtime = createTempRuntime();
      const fixture = await createActiveFixture(runtime);
      insertTerminalToolRun(fixture.database, fixture, {
        status: 'succeeded',
        dispatchState: 'prepared',
        effectState: 'not_applied',
      });
      const finalAttempt =
        operation === 'succeed'
          ? insertSucceededAttempt(fixture.database, fixture, {
              callId: 'model-call-final-after-terminal',
              attemptId: 'model-attempt-final-after-terminal',
              callOrdinal: 2,
            })
          : null;
      expect(
        fixture.database
          .prepare(
            `SELECT status, execution_mode AS executionMode,
                    dispatch_state AS dispatchState, effect_state AS effectState
             FROM tool_runs WHERE id = 'tool-run-terminal'`,
          )
          .get(),
      ).toEqual({
        status: 'succeeded',
        executionMode: 'worker',
        dispatchState: 'prepared',
        effectState: 'not_applied',
      });
      const before = captureFacts(fixture.database);
      let allocations = 0;
      let hooks = 0;
      const terminalizer = new TurnTerminalizer(fixture.database, {
        now: () => new Date(FINISH_TIME),
        createId: () => `invalid-terminal-${String(++allocations)}`,
        onCommitted: () => {
          hooks += 1;
        },
        hooks: {
          afterWriteGroup: () => {
            hooks += 1;
          },
        },
      });

      try {
        const terminalize = () => {
          if (operation === 'succeed' && finalAttempt) {
            terminalizer.succeed({
              binding: fixture.claim,
              modelAttemptId: finalAttempt.attemptId,
            });
          } else if (operation === 'fail') {
            terminalizer.fail({
              binding: fixture.claim,
              errorCode: 'MODEL_FAILED',
              errorMessage: 'Model failed',
            });
          } else {
            terminalizer.interrupt({
              binding: fixture.claim,
              reason: 'runner_lost',
              executorExited: true,
            });
          }
        };

        expect(terminalize).toThrow(/terminalization invariant/i);
        expect(captureFacts(fixture.database)).toBe(before);
        expect(allocations).toBe(0);
        expect(hooks).toBe(0);
      } finally {
        fixture.database.close();
      }
    },
  );

  it('closes a legal active ToolRun while preserving a legal Terminal ToolRun', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      dispatchState: 'prepared',
      effectState: 'unknown',
      toolStatus: 'queued',
    });
    const terminalToolRunId = insertTerminalToolRun(fixture.database, fixture, {
      suffix: 'preserved-terminal',
      ordinal: 2,
      status: 'succeeded',
      dispatchState: 'acknowledged',
      effectState: 'applied',
    });
    const terminalBefore = fixture.database
      .prepare('SELECT * FROM tool_runs WHERE id = ?')
      .get(terminalToolRunId);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('mixed-terminal'),
    });

    try {
      terminalizer.interrupt({
        binding: fixture.claim,
        reason: 'runner_lost',
        executorExited: true,
      });
      expect(
        fixture.database
          .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
          .get(active.toolRunId),
      ).toEqual({ status: 'canceled', effect_state: 'not_applied' });
      expect(
        fixture.database.prepare('SELECT * FROM tool_runs WHERE id = ?').get(terminalToolRunId),
      ).toEqual(terminalBefore);
    } finally {
      fixture.database.close();
    }
  });

  it('atomically succeeds from the latest persisted final ModelAttempt', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime, { queuedFollower: true });
    const finalAttempt = insertSucceededAttempt(fixture.database, fixture);
    const attemptBefore = fixture.database
      .prepare('SELECT * FROM model_attempts WHERE id = ?')
      .get(finalAttempt.attemptId);
    let committed = 0;
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('terminal'),
      onCommitted: () => {
        committed += 1;
      },
    });

    try {
      terminalizer.succeed({
        binding: fixture.claim,
        modelAttemptId: finalAttempt.attemptId,
      });

      const turn = fixture.database
        .prepare('SELECT * FROM turns WHERE id = ?')
        .get(fixture.turnId) as Record<string, unknown>;
      expect(turn).toMatchObject({
        status: 'succeeded',
        execution_fence: fixture.claim.executionFence + 1,
        finished_at: FINISH_TIME,
        error_code: null,
        error_message: null,
        result_message_id: expect.any(String),
      });
      expect(
        fixture.database.prepare('SELECT * FROM messages WHERE id = ?').get(
          turn.result_message_id,
        ),
      ).toMatchObject({
        session_id: fixture.sessionId,
        turn_id: fixture.turnId,
        role: 'assistant',
        status: 'completed',
        content: 'Completed',
        created_at: FINISH_TIME,
        completed_at: FINISH_TIME,
      });
      expect(
        fixture.database.prepare('SELECT status FROM runner_leases WHERE id = ?').get(
          fixture.claim.leaseId,
        ),
      ).toEqual({ status: 'expired' });
      expect(fixture.database.prepare('SELECT state, owner_turn_id FROM scheduler_slots').get()).toEqual({
        state: 'free',
        owner_turn_id: null,
      });
      expect(
        fixture.database
          .prepare('SELECT runtime_status, current_turn_id FROM sessions WHERE id = ?')
          .get(fixture.sessionId),
      ).toEqual({ runtime_status: 'queued', current_turn_id: null });
      expect(
        fixture.database
          .prepare(
            "SELECT type, payload_json FROM session_events WHERE turn_id = ? AND type = 'turn.succeeded'",
          )
          .all(fixture.turnId),
      ).toEqual([
        {
          type: 'turn.succeeded',
          payload_json: JSON.stringify({ modelAttemptId: finalAttempt.attemptId }),
        },
      ]);
      expect(
        fixture.database.prepare('SELECT * FROM model_attempts WHERE id = ?').get(
          finalAttempt.attemptId,
        ),
      ).toEqual(attemptBefore);
      expect(committed).toBe(1);
      expect(fixture.database.pragma('foreign_key_check')).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects success when the final ModelCall belongs to another Session', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const finalAttempt = insertSucceededAttempt(fixture.database, fixture);
    const foreign = createForeignSession(fixture.database, fixture);
    fixture.database
      .prepare('UPDATE model_calls SET session_id = ? WHERE id = ?')
      .run(foreign.sessionId, finalAttempt.callId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('cross-session-success'),
    });

    try {
      expect(() =>
        terminalizer.succeed({
          binding: fixture.claim,
          modelAttemptId: finalAttempt.attemptId,
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    {
      name: 'a final Attempt with Tool Calls',
      mutate: (database: Database.Database, attemptId: string) => {
        database
          .prepare(
            `INSERT INTO model_tool_calls (
              model_attempt_id, logical_call_id, call_index, tool_id,
              arguments_json, normalized_input_hash
            ) VALUES (?, 'call-1', 0, 'fs.read_text', '{}', 'hash')`,
          )
          .run(attemptId);
      },
    },
    {
      name: 'whitespace-only final content',
      mutate: (database: Database.Database, attemptId: string) => {
        database
          .prepare('UPDATE model_attempts SET result_json = ? WHERE id = ?')
          .run(
            JSON.stringify({ finishReason: 'stop', content: '   ', toolCalls: [] }),
            attemptId,
          );
      },
    },
    {
      name: 'a nonterminal ModelAttempt',
      mutate: (database: Database.Database, attemptId: string) => {
        database
          .prepare(
            `INSERT INTO model_attempts (
              id, model_call_id, attempt, status, provider_request_id,
              partial_output_json, result_json, finish_reason,
              input_tokens, output_tokens, cached_tokens, latency_ms,
              error_code, error_message, retryable, started_at, finished_at
            ) SELECT 'model-attempt-running', model_call_id, 2, 'running', NULL,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL
              FROM model_attempts WHERE id = ?`,
          )
          .run(CLAIM_TIME, attemptId);
      },
    },
    {
      name: 'a later terminal retry after the referenced successful Attempt',
      mutate: (database: Database.Database, attemptId: string) => {
        database
          .prepare(
            `INSERT INTO model_attempts (
              id, model_call_id, attempt, status, provider_request_id,
              partial_output_json, result_json, finish_reason,
              input_tokens, output_tokens, cached_tokens, latency_ms,
              error_code, error_message, retryable, started_at, finished_at
            ) SELECT 'model-attempt-later-failed', model_call_id, 2, 'failed', NULL,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              'MODEL_FAILED', 'Model failed', 0, ?, ?
              FROM model_attempts WHERE id = ?`,
          )
          .run(CLAIM_TIME, FINISH_TIME, attemptId);
      },
    },
    {
      name: 'a nonterminal ToolRun',
      mutate: (database: Database.Database, attemptId: string) => {
        const call = database
          .prepare('SELECT model_call_id AS callId FROM model_attempts WHERE id = ?')
          .get(attemptId) as { readonly callId: string };
        const owner = database
          .prepare(
            `SELECT session_id AS sessionId, turn_id AS turnId
             FROM model_calls WHERE id = ?`,
          )
          .get(call.callId) as { readonly sessionId: string; readonly turnId: string };
        insertActiveSubexecutions(database, {
          sessionId: owner.sessionId,
          turnId: owner.turnId,
        });
      },
    },
  ])('rejects success with $name without partial writes', async ({ mutate }) => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const finalAttempt = insertSucceededAttempt(fixture.database, fixture, {
      callOrdinal: 2,
    });
    mutate(fixture.database, finalAttempt.attemptId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('rejected'),
    });

    try {
      expect(() =>
        terminalizer.succeed({
          binding: fixture.claim,
          modelAttemptId: finalAttempt.attemptId,
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects an older successful Attempt and an unresolved Tool effect', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const older = insertSucceededAttempt(fixture.database, fixture, {
      callId: 'model-call-older',
      attemptId: 'model-attempt-older',
      callOrdinal: 1,
    });
    insertSucceededAttempt(fixture.database, fixture, {
      callId: 'model-call-latest',
      attemptId: 'model-attempt-latest',
      callOrdinal: 2,
    });
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('rejected'),
    });
    const beforeOlder = captureFacts(fixture.database);

    try {
      expect(() =>
        terminalizer.succeed({ binding: fixture.claim, modelAttemptId: older.attemptId }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(beforeOlder);

      const active = insertActiveSubexecutions(fixture.database, fixture, {
        worker: true,
        effectState: 'unknown',
        callOrdinal: 3,
      });
      fixture.database
        .prepare(
          `UPDATE tool_runs
           SET status = 'interrupted', finished_at = ?
           WHERE id = ?`,
        )
        .run(FINISH_TIME, active.toolRunId);
      fixture.database
        .prepare("UPDATE model_attempts SET status = 'interrupted', finished_at = ? WHERE id = ?")
        .run(FINISH_TIME, active.attemptId);
      fixture.database
        .prepare("UPDATE model_calls SET status = 'interrupted', finished_at = ? WHERE id = ?")
        .run(FINISH_TIME, active.callId);
      const beforeEffect = captureFacts(fixture.database);
      expect(() =>
        terminalizer.succeed({
          binding: fixture.claim,
          modelAttemptId: 'model-attempt-latest',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(beforeEffect);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects a successful Attempt when a later ModelCall already failed', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const older = insertSucceededAttempt(fixture.database, fixture, {
      callId: 'model-call-before-failure',
      attemptId: 'model-attempt-before-failure',
      callOrdinal: 1,
    });
    fixture.database
      .prepare(
        `INSERT INTO model_calls (
          id, session_id, turn_id, ordinal, kind, status,
          profile_snapshot_json, input_json, result_json,
          successful_attempt_id, error_code, error_message,
          created_at, started_at, finished_at
        ) VALUES (
          'model-call-later-failed', ?, ?, 2, 'craft', 'failed', '{}', '{}',
          NULL, NULL, 'MODEL_FAILED', 'Model failed', ?, ?, ?
        )`,
      )
      .run(fixture.sessionId, fixture.turnId, CLAIM_TIME, CLAIM_TIME, FINISH_TIME);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('later-failed'),
    });

    try {
      expect(() =>
        terminalizer.succeed({
          binding: fixture.claim,
          modelAttemptId: older.attemptId,
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('allows only one completion CAS winner', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const finalAttempt = insertSucceededAttempt(fixture.database, fixture);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('duplicate'),
    });

    try {
      terminalizer.succeed({ binding: fixture.claim, modelAttemptId: finalAttempt.attemptId });
      expect(
        fixture.database
          .prepare('SELECT runtime_status FROM sessions WHERE id = ?')
          .get(fixture.sessionId),
      ).toEqual({ runtime_status: 'idle' });
      const afterFirst = captureFacts(fixture.database);
      expect(() =>
        terminalizer.succeed({ binding: fixture.claim, modelAttemptId: finalAttempt.attemptId }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(afterFirst);
      expect(
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM session_events WHERE type = 'turn.succeeded'")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      fixture.database.close();
    }
  });

  it('holds BEGIN IMMEDIATE before the first terminalization write', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const finalAttempt = insertSucceededAttempt(fixture.database, fixture);
    const contender = new BetterSqlite3(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(contender);
    contender.pragma('busy_timeout = 0');
    let competingCode: string | undefined;
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('immediate'),
      hooks: {
        afterWriteGroup: (group) => {
          if (group !== 'result') {
            return;
          }
          try {
            contender
              .prepare("UPDATE scheduler_slots SET updated_at = 'competing-writer'")
              .run();
          } catch (error) {
            competingCode =
              typeof error === 'object' && error !== null && 'code' in error
                ? String(error.code)
                : undefined;
          }
        },
      },
    });

    try {
      terminalizer.succeed({
        binding: fixture.claim,
        modelAttemptId: finalAttempt.attemptId,
      });
      expect(competingCode).toMatch(/^SQLITE_BUSY/);
      expect(
        fixture.database.prepare('SELECT updated_at FROM scheduler_slots').get(),
      ).not.toEqual({ updated_at: 'competing-writer' });
    } finally {
      contender.close();
      fixture.database.close();
    }
  });

  it('rejects a mismatched Lease binding with zero writes', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const finalAttempt = insertSucceededAttempt(fixture.database, fixture);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('lease-mismatch'),
    });

    try {
      expect(() =>
        terminalizer.succeed({
          binding: { ...fixture.claim, leaseId: 'different-lease' },
          modelAttemptId: finalAttempt.attemptId,
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('leaves immutable Artifact and final Attempt facts untouched', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    insertImmutableArtifact(fixture.database, fixture);
    const finalAttempt = insertSucceededAttempt(fixture.database, fixture, {
      callId: 'final-model-call',
      attemptId: 'final-model-attempt',
      callOrdinal: 2,
    });
    const immutableBefore = {
      attempt: fixture.database
        .prepare('SELECT * FROM model_attempts WHERE id = ?')
        .get(finalAttempt.attemptId),
      blobs: fixture.database.prepare('SELECT * FROM blobs').all(),
      artifacts: fixture.database.prepare('SELECT * FROM artifacts').all(),
      versions: fixture.database.prepare('SELECT * FROM artifact_versions').all(),
    };
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('immutable'),
    });

    try {
      terminalizer.succeed({
        binding: fixture.claim,
        modelAttemptId: finalAttempt.attemptId,
      });
      expect({
        attempt: fixture.database
          .prepare('SELECT * FROM model_attempts WHERE id = ?')
          .get(finalAttempt.attemptId),
        blobs: fixture.database.prepare('SELECT * FROM blobs').all(),
        artifacts: fixture.database.prepare('SELECT * FROM artifacts').all(),
        versions: fixture.database.prepare('SELECT * FROM artifact_versions').all(),
      }).toEqual(immutableBefore);
    } finally {
      fixture.database.close();
    }
  });

  it('atomically fails active safe subexecutions and releases the tuple', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime, { queuedFollower: true });
    const active = insertActiveSubexecutions(fixture.database, fixture);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('fail'),
    });

    try {
      terminalizer.fail({
        binding: fixture.claim,
        errorCode: 'RUNNER_START_FAILED',
        errorMessage: 'Runner failed to become ready',
      });

      expect(
        fixture.database.prepare('SELECT status, error_code FROM model_attempts WHERE id = ?').get(
          active.attemptId,
        ),
      ).toEqual({ status: 'failed', error_code: 'RUNNER_START_FAILED' });
      expect(
        fixture.database.prepare('SELECT status, error_code FROM model_calls WHERE id = ?').get(
          active.callId,
        ),
      ).toEqual({ status: 'failed', error_code: 'RUNNER_START_FAILED' });
      expect(
        fixture.database.prepare('SELECT status, effect_state, error_code FROM tool_runs WHERE id = ?').get(
          active.toolRunId,
        ),
      ).toEqual({
        status: 'failed',
        effect_state: 'not_applied',
        error_code: 'RUNNER_START_FAILED',
      });
      expect(
        fixture.database.prepare('SELECT status, execution_fence FROM turns WHERE id = ?').get(
          fixture.turnId,
        ),
      ).toEqual({ status: 'failed', execution_fence: fixture.claim.executionFence + 1 });
      expect(
        fixture.database
          .prepare('SELECT type FROM session_events WHERE turn_id = ? ORDER BY seq DESC LIMIT 4')
          .all(fixture.turnId)
          .reverse(),
      ).toEqual([
        { type: 'model.attempt_failed' },
        { type: 'model.failed' },
        { type: 'tool.failed' },
        { type: 'turn.failed' },
      ]);
      expect(
        fixture.database
          .prepare('SELECT runtime_status, current_turn_id FROM sessions WHERE id = ?')
          .get(fixture.sessionId),
      ).toEqual({ runtime_status: 'queued', current_turn_id: null });
      expect(fixture.database.prepare('SELECT state FROM scheduler_slots').get()).toEqual({
        state: 'free',
      });
    } finally {
      fixture.database.close();
    }
  });

  it('rejects fail when a running ModelCall belongs to another Session', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture);
    const foreign = createForeignSession(fixture.database, fixture);
    fixture.database
      .prepare('UPDATE model_calls SET session_id = ? WHERE id = ?')
      .run(foreign.sessionId, active.callId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('cross-session-fail'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'MODEL_FAILED',
          errorMessage: 'Model failed',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects fail when a ToolRun source Attempt belongs to another ModelCall', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture);
    const other = insertSucceededAttempt(fixture.database, fixture, {
      callId: 'model-call-other-source',
      attemptId: 'model-attempt-other-source',
      callOrdinal: 2,
    });
    fixture.database
      .prepare('UPDATE tool_runs SET source_model_attempt_id = ? WHERE id = ?')
      .run(other.attemptId, active.toolRunId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('mismatched-source-fail'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'MODEL_FAILED',
          errorMessage: 'Model failed',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects fail when a ToolRun sources a ModelCall and Attempt from another Turn', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime, { queuedFollower: true });
    if (!fixture.queuedTurnId) {
      throw new Error('Fixture did not create the queued Turn');
    }
    const active = insertActiveSubexecutions(fixture.database, fixture);
    const foreignSource = insertSucceededAttempt(
      fixture.database,
      { sessionId: fixture.sessionId, turnId: fixture.queuedTurnId },
      {
        callId: 'model-call-other-turn',
        attemptId: 'model-attempt-other-turn',
      },
    );
    fixture.database
      .prepare(
        `UPDATE tool_runs
         SET source_model_call_id = ?, source_model_attempt_id = ?
         WHERE id = ?`,
      )
      .run(foreignSource.callId, foreignSource.attemptId, active.toolRunId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('cross-turn-source-fail'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'MODEL_FAILED',
          errorMessage: 'Model failed',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('optionally persists an assistant result from an earlier successful Attempt on fail', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const resultAttempt = insertSucceededAttempt(fixture.database, fixture, {
      callId: 'failure-result-call',
      attemptId: 'failure-result-attempt',
      callOrdinal: 1,
      content: 'Useful partial result',
    });
    insertActiveSubexecutions(fixture.database, fixture, { callOrdinal: 2 });
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('failure-result'),
    });

    try {
      terminalizer.fail({
        binding: fixture.claim,
        errorCode: 'MODEL_FAILED',
        errorMessage: 'The final model call failed',
        assistantResult: { modelAttemptId: resultAttempt.attemptId },
      });
      const turn = fixture.database
        .prepare('SELECT status, result_message_id AS resultMessageId FROM turns WHERE id = ?')
        .get(fixture.turnId) as {
        readonly status: string;
        readonly resultMessageId: string | null;
      };
      expect(turn.status).toBe('failed');
      expect(turn.resultMessageId).toEqual(expect.any(String));
      expect(
        fixture.database.prepare('SELECT role, status, content FROM messages WHERE id = ?').get(
          turn.resultMessageId,
        ),
      ).toEqual({
        role: 'assistant',
        status: 'completed',
        content: 'Useful partial result',
      });
    } finally {
      fixture.database.close();
    }
  });

  it('rejects fail when an active effect cannot be proven not applied', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      effectState: 'unknown',
    });
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('unsafe-fail'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'RUNNER_START_FAILED',
          errorMessage: 'Runner failed to become ready',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects fail for a dispatched worker even when its stale effect state says not_applied', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      effectState: 'not_applied',
      dispatchState: 'go_sent',
    });
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('dispatched-fail'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'RUNNER_START_FAILED',
          errorMessage: 'Runner failed to become ready',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects fail when a Terminal ToolRun still has an unresolved unknown effect', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      effectState: 'unknown',
    });
    fixture.database
      .prepare("UPDATE model_attempts SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.attemptId);
    fixture.database
      .prepare("UPDATE model_calls SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.callId);
    fixture.database
      .prepare("UPDATE tool_runs SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.toolRunId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('terminal-unknown-fail'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'MODEL_FAILED',
          errorMessage: 'Model failed after Tool execution',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects fail when a Terminal ToolRun has an applied effect', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
    });
    fixture.database
      .prepare("UPDATE model_attempts SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.attemptId);
    fixture.database
      .prepare("UPDATE model_calls SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.callId);
    fixture.database
      .prepare(
        "UPDATE tool_runs SET status = 'interrupted', effect_state = 'applied', finished_at = ? WHERE id = ?",
      )
      .run(FINISH_TIME, active.toolRunId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('terminal-applied-fail'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'MODEL_FAILED',
          errorMessage: 'Model failed after Tool execution',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects fail when a Terminal ToolRun unknown effect is confirmed applied', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      effectState: 'unknown',
    });
    fixture.database
      .prepare("UPDATE model_attempts SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.attemptId);
    fixture.database
      .prepare("UPDATE model_calls SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.callId);
    fixture.database
      .prepare("UPDATE tool_runs SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.toolRunId);
    fixture.database
      .prepare(
        `INSERT INTO effect_resolutions (
          id, resolution_key, tool_run_id, resolution,
          evidence_json, actor, created_at
        ) VALUES (?, ?, ?, 'confirmed_applied', '{}', 'daemon', ?)`,
      )
      .run(
        'terminal-confirmed-applied-resolution',
        'terminal-confirmed-applied-key',
        active.toolRunId,
        FINISH_TIME,
      );
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('terminal-confirmed-applied-fail'),
    });

    try {
      expect(() =>
        terminalizer.fail({
          binding: fixture.claim,
          errorCode: 'MODEL_FAILED',
          errorMessage: 'Model failed after Tool execution',
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('allows fail when a Terminal ToolRun unknown effect is confirmed not applied', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      effectState: 'unknown',
    });
    fixture.database
      .prepare("UPDATE model_attempts SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.attemptId);
    fixture.database
      .prepare("UPDATE model_calls SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.callId);
    fixture.database
      .prepare("UPDATE tool_runs SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.toolRunId);
    fixture.database
      .prepare(
        `INSERT INTO effect_resolutions (
          id, resolution_key, tool_run_id, resolution,
          evidence_json, actor, created_at
        ) VALUES (?, ?, ?, 'confirmed_not_applied', '{}', 'daemon', ?)`,
      )
      .run(
        'terminal-confirmed-not-applied-resolution',
        'terminal-confirmed-not-applied-key',
        active.toolRunId,
        FINISH_TIME,
      );
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('terminal-confirmed-not-applied-fail'),
    });

    try {
      terminalizer.fail({
        binding: fixture.claim,
        errorCode: 'MODEL_FAILED',
        errorMessage: 'Model failed after Tool execution',
      });
      expect(
        fixture.database
          .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
          .get(active.toolRunId),
      ).toEqual({ status: 'interrupted', effect_state: 'unknown' });
      expect(
        fixture.database.prepare('SELECT status FROM turns WHERE id = ?').get(fixture.turnId),
      ).toEqual({ status: 'failed' });
    } finally {
      fixture.database.close();
    }
  });

  it('allows fail when a Terminal ToolRun effect is not applied', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
    });
    fixture.database
      .prepare("UPDATE model_attempts SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.attemptId);
    fixture.database
      .prepare("UPDATE model_calls SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.callId);
    fixture.database
      .prepare("UPDATE tool_runs SET status = 'failed', finished_at = ? WHERE id = ?")
      .run(FINISH_TIME, active.toolRunId);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('terminal-not-applied-fail'),
    });

    try {
      terminalizer.fail({
        binding: fixture.claim,
        errorCode: 'MODEL_FAILED',
        errorMessage: 'Model failed after Tool execution',
      });
      expect(
        fixture.database
          .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
          .get(active.toolRunId),
      ).toEqual({ status: 'failed', effect_state: 'not_applied' });
      expect(
        fixture.database.prepare('SELECT status FROM turns WHERE id = ?').get(fixture.turnId),
      ).toEqual({ status: 'failed' });
    } finally {
      fixture.database.close();
    }
  });

  it('normalizes a pre-GO worker unknown effect to not_applied before failing', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      effectState: 'unknown',
      dispatchState: 'worker_ready',
      toolStatus: 'queued',
    });
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('pre-go-fail'),
    });

    try {
      terminalizer.fail({
        binding: fixture.claim,
        errorCode: 'RUNNER_START_FAILED',
        errorMessage: 'Runner failed to become ready',
      });
      expect(
        fixture.database
          .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
          .get(active.toolRunId),
      ).toEqual({ status: 'failed', effect_state: 'not_applied' });
    } finally {
      fixture.database.close();
    }
  });

  it('rejects interrupt when a running ModelCall belongs to another Session', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture);
    const foreign = createForeignSession(fixture.database, fixture);
    fixture.database
      .prepare('UPDATE model_calls SET session_id = ? WHERE id = ?')
      .run(foreign.sessionId, active.callId);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('cross-session-interrupt'),
    });

    try {
      expect(() =>
        terminalizer.interrupt({
          binding: fixture.claim,
          reason: 'runner_lost',
          executorExited: true,
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    { name: 'empty', reason: '' },
    { name: 'whitespace-only', reason: ' \t ' },
  ])('rejects interrupt with an $name reason before any write', async ({ reason }) => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('blank-reason-interrupt'),
    });

    try {
      expect(() =>
        terminalizer.interrupt({
          binding: fixture.claim,
          reason,
          executorExited: true,
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    {
      name: 'worker prepared unknown',
      executionMode: 'worker' as const,
      dispatchState: 'prepared' as const,
      effectState: 'unknown' as const,
    },
    {
      name: 'worker ready unknown',
      executionMode: 'worker' as const,
      dispatchState: 'worker_ready' as const,
      effectState: 'unknown' as const,
    },
    {
      name: 'queued read_inline',
      executionMode: 'read_inline' as const,
      dispatchState: undefined,
      effectState: 'not_applied' as const,
    },
    {
      name: 'queued transactional intrinsic',
      executionMode: 'transactional_intrinsic' as const,
      dispatchState: undefined,
      effectState: 'unknown' as const,
    },
  ])(
    'cancels a deterministically unexecuted ToolRun on interrupt: $name',
    async ({ executionMode, dispatchState, effectState }) => {
      runtime = createTempRuntime();
      const fixture = await createActiveFixture(runtime);
      const active = insertActiveSubexecutions(fixture.database, fixture, {
        executionMode,
        ...(dispatchState ? { dispatchState } : {}),
        effectState,
        toolStatus: 'queued',
      });
      const terminalizer = new TurnTerminalizer(fixture.database, {
        now: () => new Date(FINISH_TIME),
        createId: createIdFactory('safe-interrupt'),
      });

      try {
        terminalizer.interrupt({
          binding: fixture.claim,
          reason: 'runner_lost',
          executorExited: true,
        });
        expect(
          fixture.database
            .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
            .get(active.toolRunId),
        ).toEqual({ status: 'canceled', effect_state: 'not_applied' });
        expect(
          fixture.database
            .prepare('SELECT type FROM session_events WHERE turn_id = ? ORDER BY seq DESC LIMIT 5')
            .all(fixture.turnId)
            .reverse(),
        ).toEqual([
          { type: 'model.attempt_interrupted' },
          { type: 'model.interrupted' },
          { type: 'tool.canceled' },
          { type: 'turn.interrupted' },
          { type: 'recovery.detected' },
        ]);
      } finally {
        fixture.database.close();
      }
    },
  );

  it.each([
    {
      name: 'GO-sent without a Resolution',
      dispatchState: 'go_sent' as const,
      resolution: null,
    },
    {
      name: 'acknowledged with confirmed_not_applied',
      dispatchState: 'acknowledged' as const,
      resolution: 'confirmed_not_applied' as const,
    },
    {
      name: 'GO-sent with confirmed_applied',
      dispatchState: 'go_sent' as const,
      resolution: 'confirmed_applied' as const,
    },
  ])(
    'keeps a dispatched unknown ToolRun interrupted and append-only: $name',
    async ({ dispatchState, resolution }) => {
      runtime = createTempRuntime();
      const fixture = await createActiveFixture(runtime);
      const active = insertActiveSubexecutions(fixture.database, fixture, {
        worker: true,
        dispatchState,
        effectState: 'unknown',
        toolStatus: 'running',
      });
      const terminalizer = new TurnTerminalizer(fixture.database, {
        now: () => new Date(FINISH_TIME),
        createId: createIdFactory('dispatched-interrupt'),
      });

      try {
        terminalizer.interrupt({
          binding: fixture.claim,
          reason: 'runner_lost',
          executorExited: true,
          ...(resolution
            ? {
                resolutions: [
                  {
                    resolutionKey: `dispatched-${resolution}`,
                    toolRunId: active.toolRunId,
                    resolution,
                    evidence: { dispatchState },
                  },
                ],
              }
            : {}),
        });
        expect(
          fixture.database
            .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
            .get(active.toolRunId),
        ).toEqual({ status: 'interrupted', effect_state: 'unknown' });
        expect(
          fixture.database
            .prepare('SELECT resolution FROM effect_resolutions WHERE tool_run_id = ?')
            .all(active.toolRunId),
        ).toEqual(resolution ? [{ resolution }] : []);
        expect(
          fixture.database
            .prepare('SELECT type FROM session_events WHERE turn_id = ? ORDER BY seq DESC LIMIT 5')
            .all(fixture.turnId)
            .reverse(),
        ).toEqual([
          { type: 'model.attempt_interrupted' },
          { type: 'model.interrupted' },
          { type: 'tool.interrupted' },
          { type: 'turn.interrupted' },
          { type: 'recovery.detected' },
        ]);
      } finally {
        fixture.database.close();
      }
    },
  );

  it.each(workerActiveMatrixCases)(
    'enforces the active worker status matrix before interrupt writes: $name',
    async ({
      status,
      dispatchState,
      effectState,
      valid,
      expectedStatus,
      expectedEffectState,
    }) => {
      runtime = createTempRuntime();
      const fixture = await createActiveFixture(runtime);
      const active = insertActiveSubexecutions(fixture.database, fixture, {
        worker: true,
        dispatchState,
        effectState,
        toolStatus: status,
      });
      expect(
        fixture.database
          .prepare(
            `SELECT status, execution_mode AS executionMode,
                    dispatch_state AS dispatchState, effect_state AS effectState
             FROM tool_runs WHERE id = ?`,
          )
          .get(active.toolRunId),
      ).toEqual({ status, executionMode: 'worker', dispatchState, effectState });
      const before = captureFacts(fixture.database);
      let allocations = 0;
      const terminalizer = new TurnTerminalizer(fixture.database, {
        now: () => new Date(FINISH_TIME),
        createId: () => `worker-matrix-interrupt-${String(++allocations)}`,
      });

      try {
        if (!valid) {
          expect(() =>
            terminalizer.interrupt({
              binding: fixture.claim,
              reason: 'runner_lost',
              executorExited: true,
            }),
          ).toThrow(/terminalization invariant/i);
          expect(captureFacts(fixture.database)).toBe(before);
          expect(allocations).toBe(0);
          return;
        }

        terminalizer.interrupt({
          binding: fixture.claim,
          reason: 'runner_lost',
          executorExited: true,
        });
        expect(
          fixture.database
            .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
            .get(active.toolRunId),
        ).toEqual({ status: expectedStatus, effect_state: expectedEffectState });
      } finally {
        fixture.database.close();
      }
    },
  );

  it.each([
    {
      name: 'pre-GO applied effect',
      dispatchState: 'prepared' as const,
      effectState: 'applied' as const,
    },
    {
      name: 'dispatched stale not_applied effect',
      dispatchState: 'go_sent' as const,
      effectState: 'not_applied' as const,
    },
  ])('rejects interrupt for an invalid worker tuple: $name', async ({
    dispatchState,
    effectState,
  }) => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      dispatchState,
      effectState,
      toolStatus: 'queued',
    });
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('invalid-tool-interrupt'),
    });

    try {
      expect(() =>
        terminalizer.interrupt({
          binding: fixture.claim,
          reason: 'runner_lost',
          executorExited: true,
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects a confirmed_applied Resolution for a deterministically unexecuted ToolRun', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const active = insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      dispatchState: 'worker_ready',
      effectState: 'unknown',
      toolStatus: 'queued',
    });
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('contradictory-resolution'),
    });

    try {
      expect(() =>
        terminalizer.interrupt({
          binding: fixture.claim,
          reason: 'runner_lost',
          executorExited: true,
          resolutions: [
            {
              resolutionKey: 'pre-go-confirmed-applied',
              toolRunId: active.toolRunId,
              resolution: 'confirmed_applied',
              evidence: { dispatchState: 'worker_ready' },
            },
          ],
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('interrupts only after executor exit proof and appends ordered recovery events', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime, { queuedFollower: true });
    const active = insertActiveSubexecutions(fixture.database, fixture, {
      worker: true,
      effectState: 'unknown',
      dispatchState: 'worker_ready',
      toolStatus: 'queued',
    });
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('interrupt'),
    });

    try {
      terminalizer.interrupt({
        binding: fixture.claim,
        reason: 'daemon_restart',
        executorExited: true,
        resolutions: [
          {
            resolutionKey: 'restart-tool-not-applied',
            toolRunId: active.toolRunId,
            resolution: 'confirmed_not_applied',
            evidence: { policy: 'pre_go' },
          },
        ],
      });

      expect(
        fixture.database.prepare('SELECT status FROM model_attempts WHERE id = ?').get(
          active.attemptId,
        ),
      ).toEqual({ status: 'interrupted' });
      expect(
        fixture.database.prepare('SELECT status FROM model_calls WHERE id = ?').get(
          active.callId,
        ),
      ).toEqual({ status: 'interrupted' });
      expect(
        fixture.database.prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?').get(
          active.toolRunId,
        ),
      ).toEqual({ status: 'canceled', effect_state: 'not_applied' });
      expect(
        fixture.database.prepare('SELECT resolution, actor FROM effect_resolutions').all(),
      ).toEqual([{ resolution: 'confirmed_not_applied', actor: 'daemon' }]);
      expect(
        fixture.database.prepare('SELECT status, execution_fence FROM turns WHERE id = ?').get(
          fixture.turnId,
        ),
      ).toEqual({ status: 'interrupted', execution_fence: fixture.claim.executionFence + 1 });
      expect(
        fixture.database
          .prepare(
            'SELECT runtime_status, queue_block_reason, current_turn_id, recovery_episode, recovery_source_turn_id FROM sessions WHERE id = ?',
          )
          .get(fixture.sessionId),
      ).toEqual({
        runtime_status: 'recovering',
        queue_block_reason: 'recovery_review',
        current_turn_id: null,
        recovery_episode: 1,
        recovery_source_turn_id: fixture.turnId,
      });
      expect(
        fixture.database
          .prepare('SELECT type FROM session_events WHERE turn_id = ? ORDER BY seq DESC LIMIT 5')
          .all(fixture.turnId)
          .reverse(),
      ).toEqual([
        { type: 'model.attempt_interrupted' },
        { type: 'model.interrupted' },
        { type: 'tool.canceled' },
        { type: 'turn.interrupted' },
        { type: 'recovery.detected' },
      ]);
      expect(fixture.database.prepare('SELECT state FROM scheduler_slots').get()).toEqual({
        state: 'free',
      });
    } finally {
      fixture.database.close();
    }
  });

  it('keeps every fact unchanged when interrupt lacks executor exit proof', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    insertActiveSubexecutions(fixture.database, fixture);
    const before = captureFacts(fixture.database);
    const terminalizer = new TurnTerminalizer(fixture.database, {
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('unproven'),
    });

    try {
      expect(() =>
        terminalizer.interrupt({
          binding: fixture.claim,
          reason: 'runner_lost',
          executorExited: false,
        }),
      ).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    'fence',
    'effectResolutions',
    'modelAttempts',
    'modelCalls',
    'toolRuns',
    'subexecutions',
    'turn',
    'lease',
    'slot',
    'session',
    'events',
  ] as const)(
    'rolls back every interrupt write when failure is injected after %s',
    async (writeGroup) => {
      runtime = createTempRuntime();
      const fixture = await createActiveFixture(runtime);
      const active = insertActiveSubexecutions(fixture.database, fixture, {
        worker: true,
        effectState: 'unknown',
        dispatchState: 'worker_ready',
        toolStatus: 'queued',
      });
      const before = captureFacts(fixture.database);
      const injected = new Error(`injected after ${writeGroup}`);
      const terminalizer = new TurnTerminalizer(fixture.database, {
        now: () => new Date(FINISH_TIME),
        createId: createIdFactory('rollback'),
        hooks: {
          afterWriteGroup: (group: TerminalizationWriteGroup) => {
            if (group === writeGroup) {
              throw injected;
            }
          },
        },
      });

      try {
        expect(() =>
          terminalizer.interrupt({
            binding: fixture.claim,
            reason: 'runner_lost',
            executorExited: true,
            ...(writeGroup === 'effectResolutions'
              ? {
                  resolutions: [
                    {
                      resolutionKey: 'rollback-pre-go-resolution',
                      toolRunId: active.toolRunId,
                      resolution: 'confirmed_not_applied' as const,
                      evidence: { policy: 'pre_go' },
                    },
                  ],
                }
              : {}),
          }),
        ).toThrow(injected);
        expect(captureFacts(fixture.database)).toBe(before);
      } finally {
        fixture.database.close();
      }
    },
  );
});

describe('SessionEventWriter', () => {
  let runtime: TempRuntime | undefined;

  afterEach(() => {
    runtime?.cleanup();
    runtime = undefined;
  });

  it('rejects an Event whose Turn belongs to another Session before allocation', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime);
    const foreign = createForeignSession(fixture.database, fixture);
    const before = captureFacts(fixture.database);
    const writer = new SessionEventWriter(fixture.database, {
      createId: createIdFactory('cross-session-event'),
    });
    const append = fixture.database.transaction(() =>
      writer.append({
        sessionId: fixture.sessionId,
        now: FINISH_TIME,
        events: [
          {
            turnId: foreign.turnId,
            type: 'test.cross_session',
            payload: {},
          },
        ],
      }),
    );

    try {
      expect(() => append.immediate()).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects an Event whose ToolRun belongs to another Turn before allocation', async () => {
    runtime = createTempRuntime();
    const fixture = await createActiveFixture(runtime, { queuedFollower: true });
    if (!fixture.queuedTurnId) {
      throw new Error('Fixture did not create the queued Turn');
    }
    const active = insertActiveSubexecutions(fixture.database, fixture);
    const before = captureFacts(fixture.database);
    const writer = new SessionEventWriter(fixture.database, {
      createId: createIdFactory('cross-turn-tool-event'),
    });
    const append = fixture.database.transaction(() =>
      writer.append({
        sessionId: fixture.sessionId,
        now: FINISH_TIME,
        events: [
          {
            turnId: fixture.queuedTurnId,
            toolRunId: active.toolRunId,
            type: 'test.cross_turn_tool',
            payload: {},
          },
        ],
      }),
    );

    try {
      expect(() => append.immediate()).toThrow(/terminalization invariant/i);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });
});
