import type Database from 'better-sqlite3';

import type { Claim } from './scheduler.js';
import { TurnTerminalizer } from './turn-terminalizer.js';

const SLOT_NO = 1 as const;

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
  readonly executionFence: number;
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
  readonly executionFence: number;
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

const parsePayload = (payloadJson: string): Record<string, unknown> => {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
  } catch {
    // Fall through to the fail-closed invariant below.
  }
  throw new StartupRecoveryInvariantError('recovery Event payload is invalid');
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
                execution_fence AS executionFence,
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
    const turn = recoveredTurns[0];
    if (
      recoveredTurns.length !== 1 ||
      !turn ||
      turn.queueKind !== 'normal' ||
      turn.status !== 'interrupted' ||
      turn.executionFence < 2 ||
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
      detectedEvent.createdAt !== turn.finishedAt
    ) {
      throw new StartupRecoveryInvariantError(
        'already-recovered Event projection is incomplete',
      );
    }
    const interruptedPayload = parsePayload(interruptedEvent.payloadJson);
    const detectedPayload = parsePayload(detectedEvent.payloadJson);
    if (
      Object.keys(interruptedPayload).length !== 1 ||
      typeof interruptedPayload.reason !== 'string' ||
      interruptedPayload.reason.length === 0 ||
      Object.keys(detectedPayload).length !== 3 ||
      detectedPayload.reason !== interruptedPayload.reason ||
      detectedPayload.recoveryEpisode !== session.recoveryEpisode ||
      detectedPayload.recoverySourceTurnId !== turn.turnId
    ) {
      throw new StartupRecoveryInvariantError(
        'already-recovered Event payload is incomplete',
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

const inspectStartupState = (
  database: Database.Database,
  daemonEpoch: string,
): Claim | null => {
  assertRecoveredStatesAreComplete(database, daemonEpoch);

  const slots = database
    .prepare(
      `SELECT slot_no AS slotNo, state, owner_turn_id AS ownerTurnId
       FROM scheduler_slots ORDER BY slot_no`,
    )
    .all() as SlotRow[];
  if (slots.length !== 1 || slots[0]?.slotNo !== SLOT_NO) {
    throw new StartupRecoveryInvariantError('slot 1 is missing or duplicated');
  }
  const slot = slots[0];
  const activeTurns = database
    .prepare(
      `SELECT id AS turnId, session_id AS sessionId, status,
              queue_kind AS queueKind, execution_fence AS executionFence,
              started_at AS startedAt, finished_at AS finishedAt,
              error_code AS errorCode, error_message AS errorMessage,
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
              current_turn_id AS currentTurnId
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

  if (
    slot.state === 'free' &&
    slot.ownerTurnId === null &&
    activeTurns.length === 0 &&
    activeSessions.length === 0 &&
    activeLeases.length === 0
  ) {
    return null;
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
  if (lease.daemonEpoch === daemonEpoch) {
    throw new StartupRecoveryInvariantError(
      'active Lease already uses the new daemon epoch',
    );
  }
  if (
    slot.ownerTurnId !== turn.turnId ||
    turn.queueKind !== 'normal' ||
    turn.executionFence <= 0 ||
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
  return {
    slotNo: SLOT_NO,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    leaseId: lease.leaseId,
    daemonEpoch: lease.daemonEpoch,
    leaseEpoch: lease.leaseEpoch,
    executionFence: turn.executionFence,
  };
};

export const recoverStartupState: StartupRecovery = (database, options) => {
  const inspect = database.transaction(() =>
    inspectStartupState(database, options.daemonEpoch),
  );
  const binding = inspect.immediate();
  if (!binding) {
    return;
  }

  const terminalizer = new TurnTerminalizer(database, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
    hooks: {
      afterWriteGroup: (group) => {
        if (group === 'events') {
          options.hooks?.beforeCommit?.({
            sessionId: binding.sessionId,
            turnId: binding.turnId,
          });
        }
      },
    },
  });
  terminalizer.interrupt({
    binding,
    reason: 'daemon_restart',
    executorExited: true,
  });
};
