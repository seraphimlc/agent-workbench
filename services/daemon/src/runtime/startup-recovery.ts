import type Database from 'better-sqlite3';

import {
  TurnTerminalizationInvariantError,
  type LeaseExecutorIdentity,
} from '../db/execution-repository.js';
import type { Claim } from './scheduler.js';
import { TurnTerminalizer } from './turn-terminalizer.js';
import { ExecutionRecovery } from './execution-recovery.js';

const SLOT_NOS = [1, 2] as const;

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
  readonly runnerInstanceId: string | null;
  readonly pid: number | null;
  readonly processStartIdentity: string | null;
};

type PersistedExecutorIdentity = {
  readonly runnerInstanceId: string;
  readonly pid: number;
  readonly processStartIdentity: string;
};

type StartupInspection = {
  readonly binding: Claim;
  readonly executorIdentity: LeaseExecutorIdentity;
};

const hasPersistedExecutorIdentity = (
  identity: LeaseExecutorIdentity,
): identity is PersistedExecutorIdentity =>
  identity.runnerInstanceId !== null &&
  identity.pid !== null &&
  identity.processStartIdentity !== null;

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
  readonly inspectExecutor?: (
    identity: PersistedExecutorIdentity,
  ) => 'live' | 'exited' | 'ambiguous';
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

export class StartupRecoveryExecutorError extends Error {
  readonly code = 'ORPHAN_EXECUTOR_SUSPECTED';

  constructor() {
    super('Persisted Runner executor may still be active');
    this.name = 'StartupRecoveryExecutorError';
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

const assertRecoveredSubexecutionsAreComplete = (
  database: Database.Database,
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly turnFinishedAt: string;
  },
): void => {
  try {
    new ExecutionRecovery(database).assertSubexecutionsValid(
      input.sessionId,
      input.turnId,
      input.turnFinishedAt,
    );
  } catch (error) {
    if (error instanceof TurnTerminalizationInvariantError) {
      throw new StartupRecoveryInvariantError(
        'already-recovered subexecution projection is incomplete',
      );
    }
    throw error;
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
    const turnFinishedAt = turn?.finishedAt ?? null;
    if (
      recoveredTurns.length !== 1 ||
      !turn ||
      turn.queueKind !== 'normal' ||
      turn.status !== 'interrupted' ||
      turn.executionFence < 2 ||
      turn.startedAt === null ||
      turnFinishedAt === null ||
      turn.errorCode !== null ||
      turn.errorMessage !== null ||
      turn.resultMessageId !== null
    ) {
      throw new StartupRecoveryInvariantError(
        'already-recovered source Turn projection is incomplete',
      );
    }

    assertRecoveredSubexecutionsAreComplete(database, {
      sessionId: session.sessionId,
      turnId: turn.turnId,
      turnFinishedAt,
    });

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
      expiredLeases[0]?.leaseExpiresAt !== turnFinishedAt
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
      interruptedEvent.createdAt !== turnFinishedAt ||
      detectedEvent.createdAt !== turnFinishedAt
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
      interruptedPayload.reason.trim().length === 0 ||
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
): readonly StartupInspection[] => {
  assertRecoveredStatesAreComplete(database, daemonEpoch);

  const slots = database
    .prepare(
      `SELECT slot_no AS slotNo, state, owner_turn_id AS ownerTurnId
       FROM scheduler_slots ORDER BY slot_no`,
    )
    .all() as SlotRow[];
  if (
    slots.length !== SLOT_NOS.length ||
    slots.some((slot, index) => slot.slotNo !== SLOT_NOS[index])
  ) {
    throw new StartupRecoveryInvariantError('slots must be exactly 1 and 2');
  }
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
              current_turn_id AS turnId,
              runner_instance_id AS runnerInstanceId, pid,
              process_start_identity AS processStartIdentity
       FROM runner_leases
       WHERE status = 'active'
       ORDER BY id`,
    )
    .all() as ActiveLeaseRow[];

  const invalidSlotProjection = slots.some(
    (slot) =>
      !(
        (slot.state === 'free' && slot.ownerTurnId === null) ||
        (slot.state === 'owned' && slot.ownerTurnId !== null)
      ),
  );
  if (invalidSlotProjection) {
    throw new StartupRecoveryInvariantError('slot ownership projection is invalid');
  }
  const ownedSlots = slots.filter((slot) => slot.state === 'owned');

  if (
    ownedSlots.length === 0 &&
    activeTurns.length === 0 &&
    activeSessions.length === 0 &&
    activeLeases.length === 0
  ) {
    return [];
  }
  if (
    activeTurns.length !== ownedSlots.length ||
    activeSessions.length !== ownedSlots.length ||
    activeLeases.length !== ownedSlots.length ||
    new Set(ownedSlots.map((slot) => slot.ownerTurnId)).size !== ownedSlots.length ||
    new Set(activeTurns.map((turn) => turn.turnId)).size !== ownedSlots.length ||
    new Set(activeSessions.map((session) => session.sessionId)).size !==
      ownedSlots.length ||
    new Set(activeLeases.map((lease) => lease.turnId)).size !== ownedSlots.length
  ) {
    throw new StartupRecoveryInvariantError(
      'persistent ownership facts do not form complete tuples',
    );
  }

  const recovery = new ExecutionRecovery(database);
  return ownedSlots.map((slot) => {
    const turn = activeTurns.find((row) => row.turnId === slot.ownerTurnId);
    const session = turn
      ? activeSessions.find((row) => row.sessionId === turn.sessionId)
      : undefined;
    const lease = activeLeases.find((row) => row.turnId === slot.ownerTurnId);
    const expectedRuntimeStatus =
      turn?.status === 'running' ? 'running' : 'canceling';
    if (
      !turn ||
      !session ||
      !lease ||
      lease.daemonEpoch === daemonEpoch ||
      turn.queueKind !== 'normal' ||
      turn.executionFence <= 0 ||
      turn.startedAt === null ||
      turn.finishedAt !== null ||
      turn.errorCode !== null ||
      turn.errorMessage !== null ||
      turn.resultMessageId !== null ||
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
    try {
      recovery.assertSubexecutionsValid(turn.sessionId, turn.turnId);
    } catch (error) {
      if (error instanceof TurnTerminalizationInvariantError) {
        throw new StartupRecoveryInvariantError(
          'active subexecution ownership is inconsistent',
        );
      }
      throw error;
    }
    const executorIdentity: LeaseExecutorIdentity = {
      runnerInstanceId: lease.runnerInstanceId,
      pid: lease.pid,
      processStartIdentity: lease.processStartIdentity,
    };
    const identityValues = Object.values(executorIdentity);
    const hasIdentity = identityValues.every((value) => value !== null);
    if (!hasIdentity && identityValues.some((value) => value !== null)) {
      throw new StartupRecoveryExecutorError();
    }
    return {
      binding: {
        slotNo: slot.slotNo as Claim['slotNo'],
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        leaseId: lease.leaseId,
        daemonEpoch: lease.daemonEpoch,
        leaseEpoch: lease.leaseEpoch,
        executionFence: turn.executionFence,
      },
      executorIdentity,
    };
  });
};

export const recoverStartupState: StartupRecovery = (database, options) => {
  const inspect = database.transaction(() =>
    inspectStartupState(database, options.daemonEpoch),
  );
  const inspections = inspect.immediate();
  if (inspections.length === 0) {
    return;
  }
  const executorStates = inspections.map(({ executorIdentity }) =>
    hasPersistedExecutorIdentity(executorIdentity)
      ? (options.inspectExecutor?.(executorIdentity) ?? 'ambiguous')
      : 'exited',
  );
  if (executorStates.some((state) => state !== 'exited')) {
    throw new StartupRecoveryExecutorError();
  }

  const terminalizer = new TurnTerminalizer(database, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
    beforeCommit: () => {
      const first = inspections[0];
      if (!first) {
        throw new StartupRecoveryInvariantError('recovery batch is unexpectedly empty');
      }
      options.hooks?.beforeCommit?.({
        sessionId: first.binding.sessionId,
        turnId: first.binding.turnId,
      });
    },
  });
  terminalizer.interruptMany(
    inspections.map(({ binding, executorIdentity }) => ({
      binding,
      reason: 'daemon_restart',
      executorExited: true,
      expectedExecutorIdentity: executorIdentity,
    })),
  );
};
