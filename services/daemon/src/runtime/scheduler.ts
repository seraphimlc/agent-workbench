import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';

const SLOT_NOS = [1, 2] as const;
const LEASE_DURATION_MS = 20_000;

export type SlotNo = (typeof SLOT_NOS)[number];

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
  readonly currentTurnId: string | null;
};

type ActiveLeaseRow = {
  readonly leaseId: string;
  readonly daemonEpoch: string;
  readonly leaseEpoch: number;
  readonly sessionId: string;
  readonly turnId: string;
};

type SlotRow = {
  readonly slotNo: number;
  readonly state: string;
  readonly ownerTurnId: string | null;
};

type CandidateRow = {
  readonly turnId: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly queueKind: 'normal';
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultMessageId: string | null;
  readonly executionFence: number;
  readonly nextEventSeq: number;
  readonly revision: number;
};

export interface Claim {
  readonly slotNo: SlotNo;
  readonly sessionId: string;
  readonly turnId: string;
  readonly leaseId: string;
  readonly daemonEpoch: string;
  readonly leaseEpoch: number;
  readonly executionFence: number;
}

export interface SchedulerOptions {
  readonly daemonEpoch: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class SchedulerInvariantError extends Error {
  constructor(message: string) {
    super(`Scheduler invariant violation: ${message}`);
    this.name = 'SchedulerInvariantError';
  }
}

const expectOneChange = (
  result: Database.RunResult,
  operation: string,
): void => {
  if (result.changes !== 1) {
    throw new SchedulerInvariantError(`${operation} affected ${result.changes} rows`);
  }
};

export class Scheduler {
  private readonly daemonEpoch: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly database: Database.Database,
    options: SchedulerOptions,
  ) {
    this.daemonEpoch = options.daemonEpoch;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? uuidv7;
  }

  claimNext(): Claim | null {
    const claim = this.database.transaction(() => this.claimWithinTransaction());
    return claim.immediate();
  }

  private claimWithinTransaction(): Claim | null {
    const slots = this.readSlots();
    const activeTurns = this.readActiveTurns();
    const activeSessions = this.readActiveSessions();
    const activeLeases = this.readActiveLeases();
    this.assertActiveTuples(slots, activeTurns, activeSessions, activeLeases);

    const slot = slots.find((row) => row.state === 'free');
    if (!slot) {
      return null;
    }

    const candidate = this.readCandidate();
    if (!candidate) {
      return null;
    }
    if (
      candidate.startedAt !== null ||
      candidate.finishedAt !== null ||
      candidate.errorCode !== null ||
      candidate.errorMessage !== null ||
      candidate.resultMessageId !== null ||
      candidate.executionFence !== 0
    ) {
      throw new SchedulerInvariantError(
        'queued candidate has active or terminal projection fields',
      );
    }

    const nowDate = this.now();
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(
      nowDate.getTime() + LEASE_DURATION_MS,
    ).toISOString();
    const leaseEpoch = this.readNextLeaseEpoch();
    const leaseId = this.createId();
    const eventId = this.createId();
    const slotNo = slot.slotNo as SlotNo;

    expectOneChange(
      this.database
        .prepare(
          `UPDATE scheduler_slots
           SET state = 'owned', owner_turn_id = ?, updated_at = ?
           WHERE slot_no = ? AND state = 'free' AND owner_turn_id IS NULL`,
        )
        .run(candidate.turnId, now, slotNo),
      'slot claim CAS',
    );
    expectOneChange(
      this.database
        .prepare(
          `UPDATE turns
           SET status = 'running', started_at = ?,
               execution_fence = execution_fence + 1
           WHERE id = ? AND session_id = ? AND ordinal = ?
             AND status = 'queued' AND queue_kind = 'normal'
             AND execution_fence = ?
             AND started_at IS NULL AND finished_at IS NULL
             AND error_code IS NULL AND error_message IS NULL
             AND result_message_id IS NULL`,
        )
        .run(
          now,
          candidate.turnId,
          candidate.sessionId,
          candidate.ordinal,
          candidate.executionFence,
        ),
      'Turn claim CAS',
    );
    expectOneChange(
      this.database
        .prepare(
          `UPDATE sessions
           SET current_turn_id = ?, runtime_status = 'running',
               next_event_seq = next_event_seq + 1,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND runtime_status = 'queued'
             AND current_turn_id IS NULL AND queue_block_reason IS NULL
             AND next_event_seq = ? AND revision = ?`,
        )
        .run(
          candidate.turnId,
          now,
          candidate.sessionId,
          candidate.nextEventSeq,
          candidate.revision,
        ),
      'Session claim CAS',
    );
    expectOneChange(
      this.database
        .prepare(
          `INSERT INTO runner_leases (
            id, daemon_epoch, lease_epoch, session_id, current_turn_id, status,
            heartbeat_at, lease_expires_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          leaseId,
          this.daemonEpoch,
          leaseEpoch,
          candidate.sessionId,
          candidate.turnId,
          now,
          leaseExpiresAt,
        ),
      'Lease insert',
    );
    expectOneChange(
      this.database
        .prepare(
          `INSERT INTO session_events (
            id, session_id, turn_id, tool_run_id, seq, type, actor, audience,
            payload_json, blob_id, created_at
          ) VALUES (?, ?, ?, NULL, ?, 'turn.started', 'daemon', 'both', ?, NULL, ?)`,
        )
        .run(
          eventId,
          candidate.sessionId,
          candidate.turnId,
          candidate.nextEventSeq,
          JSON.stringify({
            ordinal: candidate.ordinal,
            queueKind: candidate.queueKind,
            slotNo,
          }),
          now,
        ),
      'turn.started Event insert',
    );

    return {
      slotNo,
      sessionId: candidate.sessionId,
      turnId: candidate.turnId,
      leaseId,
      daemonEpoch: this.daemonEpoch,
      leaseEpoch,
      executionFence: candidate.executionFence + 1,
    };
  }

  private readSlots(): SlotRow[] {
    const rows = this.database
      .prepare(
        `SELECT slot_no AS slotNo, state, owner_turn_id AS ownerTurnId
         FROM scheduler_slots
         ORDER BY slot_no`,
      )
      .all() as SlotRow[];
    if (
      rows.length !== SLOT_NOS.length ||
      rows.some((row, index) => row.slotNo !== SLOT_NOS[index])
    ) {
      throw new SchedulerInvariantError('slots must be exactly 1 and 2');
    }
    return rows;
  }

  private readActiveTurns(): ActiveTurnRow[] {
    return this.database
      .prepare(
        `SELECT id AS turnId, session_id AS sessionId, status,
                queue_kind AS queueKind, execution_fence AS executionFence,
                started_at AS startedAt,
                finished_at AS finishedAt, error_code AS errorCode,
                error_message AS errorMessage,
                result_message_id AS resultMessageId
         FROM turns
         WHERE status IN ('running', 'cancel_requested')
         ORDER BY id`,
      )
      .all() as ActiveTurnRow[];
  }

  private readActiveSessions(): ActiveSessionRow[] {
    return this.database
      .prepare(
        `SELECT id AS sessionId, runtime_status AS runtimeStatus,
                queue_block_reason AS queueBlockReason,
                current_turn_id AS currentTurnId
         FROM sessions
         WHERE current_turn_id IS NOT NULL
            OR runtime_status IN ('running', 'canceling')
         ORDER BY id`,
      )
      .all() as ActiveSessionRow[];
  }

  private readActiveLeases(): ActiveLeaseRow[] {
    return this.database
      .prepare(
        `SELECT id AS leaseId, daemon_epoch AS daemonEpoch,
                lease_epoch AS leaseEpoch, session_id AS sessionId,
                current_turn_id AS turnId
         FROM runner_leases
         WHERE status = 'active'
         ORDER BY id`,
      )
      .all() as ActiveLeaseRow[];
  }

  private assertActiveTuples(
    slots: readonly SlotRow[],
    activeTurns: readonly ActiveTurnRow[],
    activeSessions: readonly ActiveSessionRow[],
    activeLeases: readonly ActiveLeaseRow[],
  ): void {
    const ownedSlots = slots.filter((slot) => slot.state === 'owned');
    for (const slot of slots) {
      if (
        (slot.state === 'free' && slot.ownerTurnId === null) ||
        (slot.state === 'owned' && slot.ownerTurnId !== null)
      ) {
        continue;
      }
      throw new SchedulerInvariantError('slot has an invalid ownership projection');
    }

    const activeCount = ownedSlots.length;
    if (
      activeTurns.length !== activeCount ||
      activeSessions.length !== activeCount ||
      activeLeases.length !== activeCount
    ) {
      throw new SchedulerInvariantError('active facts do not match owned slot count');
    }

    const ownerTurnIds = new Set(
      ownedSlots.map((slot) => slot.ownerTurnId as string),
    );
    if (ownerTurnIds.size !== ownedSlots.length) {
      throw new SchedulerInvariantError('owned slots have duplicate Turn owners');
    }
    const turnIds = new Set(activeTurns.map((turn) => turn.turnId));
    const sessionIds = new Set(activeSessions.map((session) => session.sessionId));
    const leaseTurnIds = new Set(activeLeases.map((lease) => lease.turnId));
    if (
      turnIds.size !== activeTurns.length ||
      sessionIds.size !== activeSessions.length ||
      leaseTurnIds.size !== activeLeases.length
    ) {
      throw new SchedulerInvariantError('active facts contain duplicate identities');
    }

    for (const slot of ownedSlots) {
      const ownerTurnId = slot.ownerTurnId as string;
      const turn = activeTurns.find((row) => row.turnId === ownerTurnId);
      const session = turn
        ? activeSessions.find((row) => row.sessionId === turn.sessionId)
        : undefined;
      const lease = activeLeases.find((row) => row.turnId === ownerTurnId);
      const expectedRuntimeStatus =
        turn?.status === 'running' ? 'running' : 'canceling';
      if (
        !turn ||
        !session ||
        !lease ||
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
        lease.daemonEpoch !== this.daemonEpoch ||
        lease.sessionId !== turn.sessionId
      ) {
        throw new SchedulerInvariantError('owned slot tuple is inconsistent');
      }
    }
  }

  private readCandidate(): CandidateRow | undefined {
    return this.database
      .prepare(
        `SELECT turns.id AS turnId, turns.session_id AS sessionId,
                turns.ordinal, turns.queue_kind AS queueKind,
                turns.execution_fence AS executionFence,
                turns.started_at AS startedAt,
                turns.finished_at AS finishedAt,
                turns.error_code AS errorCode,
                turns.error_message AS errorMessage,
                turns.result_message_id AS resultMessageId,
                sessions.next_event_seq AS nextEventSeq,
                sessions.revision
         FROM turns
         JOIN sessions ON sessions.id = turns.session_id
         WHERE turns.status = 'queued'
           AND turns.queue_kind = 'normal'
           AND sessions.runtime_status = 'queued'
           AND sessions.current_turn_id IS NULL
           AND sessions.queue_block_reason IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM turns AS earlier_turns
             WHERE earlier_turns.session_id = turns.session_id
               AND earlier_turns.status = 'queued'
               AND earlier_turns.ordinal < turns.ordinal
           )
         ORDER BY turns.queued_at, turns.session_id, turns.ordinal, turns.id
         LIMIT 1`,
      )
      .get() as CandidateRow | undefined;
  }

  private readNextLeaseEpoch(): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(lease_epoch), 0) + 1 AS leaseEpoch
         FROM runner_leases
         WHERE daemon_epoch = ?`,
      )
      .get(this.daemonEpoch) as { readonly leaseEpoch: number };
    return row.leaseEpoch;
  }
}
