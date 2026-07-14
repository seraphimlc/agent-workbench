import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';

const SLOT_NO = 1;

type SlotRow = {
  readonly slotNo: number;
  readonly state: string;
  readonly ownerTurnId: string | null;
};

type ActiveTurnRow = {
  readonly turnId: string;
  readonly sessionId: string;
  readonly status: 'running' | 'cancel_requested';
  readonly queueKind: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultMessageId: string | null;
};

type ActiveSessionRow = {
  readonly sessionId: string;
  readonly runtimeStatus: string;
  readonly queueBlockReason: string | null;
  readonly recoveryEpisode: number;
  readonly currentTurnId: string | null;
  readonly nextEventSeq: number;
  readonly revision: number;
};

type ActiveLeaseRow = {
  readonly leaseId: string;
  readonly daemonEpoch: string;
  readonly leaseEpoch: number;
  readonly sessionId: string;
  readonly turnId: string;
};

type RecoveryMarkerSessionRow = {
  readonly sessionId: string;
  readonly runtimeStatus: string;
  readonly queueBlockReason: string | null;
  readonly recoveryEpisode: number;
  readonly recoverySourceTurnId: string | null;
  readonly currentTurnId: string | null;
  readonly nextEventSeq: number;
};

type RecoveredTurnRow = {
  readonly turnId: string;
  readonly sessionId: string;
  readonly queueKind: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultMessageId: string | null;
};

type ExpiredLeaseRow = {
  readonly daemonEpoch: string;
  readonly leaseExpiresAt: string;
};

type RecoveryEventRow = {
  readonly seq: number;
  readonly type: string;
  readonly actor: string;
  readonly audience: string;
  readonly payloadJson: string;
  readonly toolRunId: string | null;
  readonly blobId: string | null;
  readonly createdAt: string;
};

export interface StartupRecoveryHooks {
  readonly beforeCommit?: (context: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => void;
}

export interface StartupRecoveryOptions {
  readonly daemonEpoch: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly hooks?: StartupRecoveryHooks;
}

export type StartupRecovery = (
  database: Database.Database,
  options: StartupRecoveryOptions,
) => void;

export class StartupRecoveryInvariantError extends Error {
  constructor(message: string) {
    super(`Startup recovery invariant violation: ${message}`);
    this.name = 'StartupRecoveryInvariantError';
  }
}

const expectOneChange = (
  result: Database.RunResult,
  operation: string,
): void => {
  if (result.changes !== 1) {
    throw new StartupRecoveryInvariantError(
      `${operation} affected ${result.changes} rows`,
    );
  }
};

const assertRecoveredStatesAreComplete = (
  database: Database.Database,
  daemonEpoch: string,
): void => {
  const markerSessions = database
    .prepare(
      `SELECT id AS sessionId, runtime_status AS runtimeStatus,
              queue_block_reason AS queueBlockReason,
              recovery_episode AS recoveryEpisode,
              recovery_source_turn_id AS recoverySourceTurnId,
              current_turn_id AS currentTurnId,
              next_event_seq AS nextEventSeq
       FROM sessions
       WHERE runtime_status = 'recovering'
          OR queue_block_reason IS NOT NULL
          OR recovery_source_turn_id IS NOT NULL
       ORDER BY id`,
    )
    .all() as RecoveryMarkerSessionRow[];

  for (const session of markerSessions) {
    if (
      session.runtimeStatus !== 'recovering' ||
      session.queueBlockReason !== 'recovery_review' ||
      session.recoveryEpisode <= 0 ||
      session.recoverySourceTurnId === null ||
      session.currentTurnId !== null
    ) {
      throw new StartupRecoveryInvariantError(
        'already-recovered Session projection is incomplete',
      );
    }

    const recoveredTurns = database
      .prepare(
        `SELECT id AS turnId, session_id AS sessionId,
                queue_kind AS queueKind, status,
                started_at AS startedAt, finished_at AS finishedAt,
                error_code AS errorCode, error_message AS errorMessage,
                result_message_id AS resultMessageId
         FROM turns
         WHERE id = ? AND session_id = ?`,
      )
      .all(
        session.recoverySourceTurnId,
        session.sessionId,
      ) as RecoveredTurnRow[];
    if (recoveredTurns.length !== 1) {
      throw new StartupRecoveryInvariantError(
        'already-recovered source Turn is missing or mismatched',
      );
    }
    const turn = recoveredTurns[0] as RecoveredTurnRow;
    if (
      turn.queueKind !== 'normal' ||
      turn.status !== 'interrupted' ||
      turn.startedAt === null ||
      turn.finishedAt === null ||
      turn.errorCode !== null ||
      turn.errorMessage !== null ||
      turn.resultMessageId !== null
    ) {
      throw new StartupRecoveryInvariantError(
        'already-recovered source Turn projection is incomplete',
      );
    }

    const expiredLeases = database
      .prepare(
        `SELECT daemon_epoch AS daemonEpoch,
                lease_expires_at AS leaseExpiresAt
         FROM runner_leases
         WHERE session_id = ? AND current_turn_id = ? AND status = 'expired'
         ORDER BY id`,
      )
      .all(session.sessionId, turn.turnId) as ExpiredLeaseRow[];
    if (
      expiredLeases.length !== 1 ||
      expiredLeases[0]?.daemonEpoch === daemonEpoch ||
      expiredLeases[0]?.leaseExpiresAt !== turn.finishedAt
    ) {
      throw new StartupRecoveryInvariantError(
        'already-recovered Lease projection is incomplete',
      );
    }

    const recoveryEvents = database
      .prepare(
        `SELECT seq, type, actor, audience, payload_json AS payloadJson,
                tool_run_id AS toolRunId, blob_id AS blobId,
                created_at AS createdAt
         FROM session_events
         WHERE session_id = ? AND turn_id = ?
           AND type IN ('turn.interrupted', 'recovery.detected')
         ORDER BY seq`,
      )
      .all(session.sessionId, turn.turnId) as RecoveryEventRow[];
    const interruptedEvent = recoveryEvents[0];
    const detectedEvent = recoveryEvents[1];
    if (
      recoveryEvents.length !== 2 ||
      interruptedEvent?.type !== 'turn.interrupted' ||
      detectedEvent?.type !== 'recovery.detected' ||
      detectedEvent.seq !== interruptedEvent.seq + 1 ||
      interruptedEvent.actor !== 'daemon' ||
      detectedEvent.actor !== 'daemon' ||
      interruptedEvent.audience !== 'both' ||
      detectedEvent.audience !== 'both' ||
      interruptedEvent.toolRunId !== null ||
      detectedEvent.toolRunId !== null ||
      interruptedEvent.blobId !== null ||
      detectedEvent.blobId !== null ||
      interruptedEvent.createdAt !== turn.finishedAt ||
      detectedEvent.createdAt !== turn.finishedAt ||
      interruptedEvent.payloadJson !==
        JSON.stringify({ reason: 'daemon_restart' }) ||
      detectedEvent.payloadJson !==
        JSON.stringify({
          reason: 'daemon_restart',
          recoveryEpisode: session.recoveryEpisode,
          recoverySourceTurnId: turn.turnId,
        })
    ) {
      throw new StartupRecoveryInvariantError(
        'already-recovered Event projection is incomplete',
      );
    }

    const eventHighWater = database
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS nextEventSeq
         FROM session_events
         WHERE session_id = ?`,
      )
      .get(session.sessionId) as { readonly nextEventSeq: number };
    if (eventHighWater.nextEventSeq !== session.nextEventSeq) {
      throw new StartupRecoveryInvariantError(
        'already-recovered Event high-water is inconsistent',
      );
    }
  }
};

export const recoverStartupState: StartupRecovery = (database, options) => {
  const recover = database.transaction(() => {
    const slotRows = database
      .prepare(
        `SELECT slot_no AS slotNo, state, owner_turn_id AS ownerTurnId
         FROM scheduler_slots
         ORDER BY slot_no`,
      )
      .all() as SlotRow[];
    if (slotRows.length !== 1 || slotRows[0]?.slotNo !== SLOT_NO) {
      throw new StartupRecoveryInvariantError('slot 1 is missing or duplicated');
    }
    const slot = slotRows[0];
    const activeTurns = database
      .prepare(
        `SELECT id AS turnId, session_id AS sessionId, status,
                queue_kind AS queueKind, started_at AS startedAt,
                finished_at AS finishedAt, error_code AS errorCode,
                error_message AS errorMessage,
                result_message_id AS resultMessageId
         FROM turns
         WHERE status IN ('running', 'cancel_requested')
         ORDER BY id`,
      )
      .all() as ActiveTurnRow[];
    const activeSessions = database
      .prepare(
        `SELECT id AS sessionId, runtime_status AS runtimeStatus,
                queue_block_reason AS queueBlockReason,
                recovery_episode AS recoveryEpisode,
                current_turn_id AS currentTurnId,
                next_event_seq AS nextEventSeq, revision
         FROM sessions
         WHERE current_turn_id IS NOT NULL
            OR runtime_status IN ('running', 'canceling')
         ORDER BY id`,
      )
      .all() as ActiveSessionRow[];
    const activeLeases = database
      .prepare(
        `SELECT id AS leaseId, daemon_epoch AS daemonEpoch,
                lease_epoch AS leaseEpoch, session_id AS sessionId,
                current_turn_id AS turnId
         FROM runner_leases
         WHERE status = 'active'
         ORDER BY id`,
      )
      .all() as ActiveLeaseRow[];

    assertRecoveredStatesAreComplete(database, options.daemonEpoch);

    if (
      slot.state === 'free' &&
      slot.ownerTurnId === null &&
      activeTurns.length === 0 &&
      activeSessions.length === 0 &&
      activeLeases.length === 0
    ) {
      return;
    }

    if (
      slot.state !== 'owned' ||
      slot.ownerTurnId === null ||
      activeTurns.length !== 1 ||
      activeSessions.length !== 1 ||
      activeLeases.length !== 1
    ) {
      throw new StartupRecoveryInvariantError(
        'persistent ownership facts do not form one complete tuple',
      );
    }

    const turn = activeTurns[0] as ActiveTurnRow;
    const session = activeSessions[0] as ActiveSessionRow;
    const lease = activeLeases[0] as ActiveLeaseRow;
    const expectedRuntimeStatus =
      turn.status === 'running' ? 'running' : 'canceling';
    if (lease.daemonEpoch === options.daemonEpoch) {
      throw new StartupRecoveryInvariantError(
        'active Lease already uses the new daemon epoch',
      );
    }
    if (
      slot.ownerTurnId !== turn.turnId ||
      turn.queueKind !== 'normal' ||
      turn.startedAt === null ||
      turn.finishedAt !== null ||
      turn.errorCode !== null ||
      turn.errorMessage !== null ||
      turn.resultMessageId !== null ||
      session.sessionId !== turn.sessionId ||
      session.currentTurnId !== turn.turnId ||
      session.runtimeStatus !== expectedRuntimeStatus ||
      session.queueBlockReason !== null ||
      lease.sessionId !== turn.sessionId ||
      lease.turnId !== turn.turnId
    ) {
      throw new StartupRecoveryInvariantError(
        'persistent ownership tuple is inconsistent',
      );
    }

    const now = (options.now?.() ?? new Date()).toISOString();
    const createId = options.createId ?? uuidv7;
    const interruptedEventId = createId();
    const recoveryEventId = createId();
    const recoveryEpisode = session.recoveryEpisode + 1;

    expectOneChange(
      database
        .prepare(
          `UPDATE turns
           SET status = 'interrupted', finished_at = ?,
               error_code = NULL, error_message = NULL, result_message_id = NULL
           WHERE id = ? AND session_id = ? AND status = ?
             AND queue_kind = 'normal' AND started_at = ?
             AND finished_at IS NULL AND error_code IS NULL
             AND error_message IS NULL AND result_message_id IS NULL`,
        )
        .run(
          now,
          turn.turnId,
          turn.sessionId,
          turn.status,
          turn.startedAt,
        ),
      'Turn recovery CAS',
    );
    expectOneChange(
      database
        .prepare(
          `UPDATE runner_leases
           SET status = 'expired', lease_expires_at = ?
           WHERE id = ? AND daemon_epoch = ? AND lease_epoch = ?
             AND session_id = ? AND current_turn_id = ? AND status = 'active'`,
        )
        .run(
          now,
          lease.leaseId,
          lease.daemonEpoch,
          lease.leaseEpoch,
          lease.sessionId,
          lease.turnId,
        ),
      'Lease recovery CAS',
    );
    expectOneChange(
      database
        .prepare(
          `UPDATE scheduler_slots
           SET state = 'free', owner_turn_id = NULL, updated_at = ?
           WHERE slot_no = ? AND state = 'owned' AND owner_turn_id = ?`,
        )
        .run(now, SLOT_NO, turn.turnId),
      'slot recovery CAS',
    );
    expectOneChange(
      database
        .prepare(
          `UPDATE sessions
           SET current_turn_id = NULL,
               queue_block_reason = 'recovery_review',
               recovery_episode = recovery_episode + 1,
               recovery_source_turn_id = ?, runtime_status = 'recovering',
               next_event_seq = next_event_seq + 2,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND current_turn_id = ? AND runtime_status = ?
             AND queue_block_reason IS NULL AND recovery_episode = ?
             AND next_event_seq = ? AND revision = ?`,
        )
        .run(
          turn.turnId,
          now,
          session.sessionId,
          turn.turnId,
          session.runtimeStatus,
          session.recoveryEpisode,
          session.nextEventSeq,
          session.revision,
        ),
      'Session recovery CAS',
    );
    expectOneChange(
      database
        .prepare(
          `INSERT INTO session_events (
            id, session_id, turn_id, tool_run_id, seq, type, actor, audience,
            payload_json, blob_id, created_at
          ) VALUES (?, ?, ?, NULL, ?, 'turn.interrupted', 'daemon', 'both', ?, NULL, ?)`,
        )
        .run(
          interruptedEventId,
          session.sessionId,
          turn.turnId,
          session.nextEventSeq,
          JSON.stringify({ reason: 'daemon_restart' }),
          now,
        ),
      'turn.interrupted Event insert',
    );
    expectOneChange(
      database
        .prepare(
          `INSERT INTO session_events (
            id, session_id, turn_id, tool_run_id, seq, type, actor, audience,
            payload_json, blob_id, created_at
          ) VALUES (?, ?, ?, NULL, ?, 'recovery.detected', 'daemon', 'both', ?, NULL, ?)`,
        )
        .run(
          recoveryEventId,
          session.sessionId,
          turn.turnId,
          session.nextEventSeq + 1,
          JSON.stringify({
            reason: 'daemon_restart',
            recoveryEpisode,
            recoverySourceTurnId: turn.turnId,
          }),
          now,
        ),
      'recovery.detected Event insert',
    );

    options.hooks?.beforeCommit?.({
      sessionId: session.sessionId,
      turnId: turn.turnId,
    });
  });

  recover.immediate();
};
