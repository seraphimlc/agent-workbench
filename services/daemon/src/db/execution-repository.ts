import type Database from 'better-sqlite3';

import type { Claim } from '../runtime/scheduler.js';

const SLOT_NOS = [1, 2] as const;

type ActiveTupleRow = {
  readonly turnId: string;
  readonly sessionId: string;
  readonly turnStatus: 'running' | 'cancel_requested';
  readonly queueKind: string;
  readonly executionFence: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultMessageId: string | null;
  readonly runtimeStatus: string;
  readonly queueBlockReason: string | null;
  readonly recoveryEpisode: number;
  readonly currentTurnId: string | null;
  readonly leaseId: string;
  readonly daemonEpoch: string;
  readonly leaseEpoch: number;
  readonly leaseSessionId: string;
  readonly leaseTurnId: string;
  readonly leaseStatus: string;
  readonly slotNo: number;
  readonly slotState: string;
  readonly ownerTurnId: string | null;
};

type ActiveTurnFact = {
  readonly turnId: string;
  readonly sessionId: string;
  readonly turnStatus: 'running' | 'cancel_requested';
  readonly queueKind: string;
  readonly executionFence: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultMessageId: string | null;
};

type ActiveSessionFact = {
  readonly sessionId: string;
  readonly runtimeStatus: string;
  readonly queueBlockReason: string | null;
  readonly currentTurnId: string | null;
};

type ActiveLeaseFact = {
  readonly leaseId: string;
  readonly daemonEpoch: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly leaseStatus: string;
};

type SlotFact = {
  readonly slotNo: number;
  readonly slotState: string;
  readonly ownerTurnId: string | null;
};

export type LeaseExecutorIdentity = {
  readonly runnerInstanceId: string | null;
  readonly pid: number | null;
  readonly processStartIdentity: string | null;
};

type FinalAttemptRow = {
  readonly attemptId: string;
  readonly attempt: number;
  readonly attemptStatus: string;
  readonly resultJson: string | null;
  readonly finishReason: string | null;
  readonly modelCallId: string;
  readonly callOrdinal: number;
  readonly callStatus: string;
  readonly successfulAttemptId: string | null;
};

export type ActiveExecutionTuple = ActiveTupleRow;

export class TurnTerminalizationInvariantError extends Error {
  constructor(message: string) {
    super(`Turn terminalization invariant violation: ${message}`);
    this.name = 'TurnTerminalizationInvariantError';
  }
}

export const expectTerminalizationChange = (
  result: Database.RunResult,
  operation: string,
): void => {
  if (result.changes !== 1) {
    throw new TurnTerminalizationInvariantError(
      `${operation} affected ${result.changes} rows`,
    );
  }
};

const parseFinalResult = (
  resultJson: string | null,
): { readonly finishReason: 'stop'; readonly content: string; readonly toolCalls: [] } => {
  if (resultJson === null) {
    throw new TurnTerminalizationInvariantError('final ModelAttempt has no result');
  }
  let value: unknown;
  try {
    value = JSON.parse(resultJson);
  } catch {
    throw new TurnTerminalizationInvariantError(
      'final ModelAttempt result is not valid JSON',
    );
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !('finishReason' in value) ||
    value.finishReason !== 'stop' ||
    !('content' in value) ||
    typeof value.content !== 'string' ||
    value.content.trim().length === 0 ||
    !('toolCalls' in value) ||
    !Array.isArray(value.toolCalls) ||
    value.toolCalls.length !== 0
  ) {
    throw new TurnTerminalizationInvariantError(
      'final ModelAttempt result is not a completed stop response',
    );
  }
  return {
    finishReason: 'stop',
    content: value.content,
    toolCalls: [],
  };
};

export class ExecutionRepository {
  constructor(private readonly database: Database.Database) {}

  assertCallerTransaction(): void {
    if (!this.database.inTransaction) {
      throw new TurnTerminalizationInvariantError(
        'execution mutation requires a caller-owned transaction',
      );
    }
  }

  readActiveTuple(
    binding: Claim,
    allowedStatuses: readonly ActiveTupleRow['turnStatus'][],
  ): ActiveExecutionTuple {
    this.assertCallerTransaction();
    this.assertGlobalActiveTuples(binding);
    const row = this.database
      .prepare(
        `SELECT
           turns.id AS turnId,
           turns.session_id AS sessionId,
           turns.status AS turnStatus,
           turns.queue_kind AS queueKind,
           turns.execution_fence AS executionFence,
           turns.started_at AS startedAt,
           turns.finished_at AS finishedAt,
           turns.error_code AS errorCode,
           turns.error_message AS errorMessage,
           turns.result_message_id AS resultMessageId,
           sessions.runtime_status AS runtimeStatus,
           sessions.queue_block_reason AS queueBlockReason,
           sessions.recovery_episode AS recoveryEpisode,
           sessions.current_turn_id AS currentTurnId,
           runner_leases.id AS leaseId,
           runner_leases.daemon_epoch AS daemonEpoch,
           runner_leases.lease_epoch AS leaseEpoch,
           runner_leases.session_id AS leaseSessionId,
           runner_leases.current_turn_id AS leaseTurnId,
           runner_leases.status AS leaseStatus,
           scheduler_slots.slot_no AS slotNo,
           scheduler_slots.state AS slotState,
           scheduler_slots.owner_turn_id AS ownerTurnId
         FROM turns
         JOIN sessions ON sessions.id = turns.session_id
         JOIN runner_leases ON runner_leases.current_turn_id = turns.id
           AND runner_leases.status = 'active'
         JOIN scheduler_slots ON scheduler_slots.owner_turn_id = turns.id
         WHERE turns.id = ? AND turns.session_id = ?`,
      )
      .get(binding.turnId, binding.sessionId) as ActiveTupleRow | undefined;
    if (!row) {
      throw new TurnTerminalizationInvariantError('active tuple is missing');
    }
    this.assertTurnExecutionOwnership(binding);
    const expectedRuntimeStatus =
      row.turnStatus === 'cancel_requested' ? 'canceling' : 'running';
    if (
      !allowedStatuses.includes(row.turnStatus) ||
      row.queueKind !== 'normal' ||
      row.executionFence !== binding.executionFence ||
      row.startedAt === null ||
      row.finishedAt !== null ||
      row.errorCode !== null ||
      row.errorMessage !== null ||
      row.resultMessageId !== null ||
      row.runtimeStatus !== expectedRuntimeStatus ||
      row.queueBlockReason !== null ||
      row.currentTurnId !== binding.turnId ||
      row.leaseId !== binding.leaseId ||
      row.daemonEpoch !== binding.daemonEpoch ||
      row.leaseEpoch !== binding.leaseEpoch ||
      row.leaseSessionId !== binding.sessionId ||
      row.leaseTurnId !== binding.turnId ||
      row.leaseStatus !== 'active' ||
      row.slotNo !== binding.slotNo ||
      row.slotState !== 'owned' ||
      row.ownerTurnId !== binding.turnId
    ) {
      throw new TurnTerminalizationInvariantError('active tuple is inconsistent');
    }
    return row;
  }

  assertExactActiveTupleBindings(bindings: readonly Claim[]): void {
    this.assertCallerTransaction();
    if (bindings.length === 0) {
      throw new TurnTerminalizationInvariantError(
        'interrupt batch must include at least one active tuple',
      );
    }
    const firstBinding = bindings[0];
    if (!firstBinding) {
      throw new TurnTerminalizationInvariantError(
        'interrupt batch must include at least one active tuple',
      );
    }
    this.assertGlobalActiveTuples(firstBinding);
    const bindingKeys = new Set(
      bindings.map(
        (binding) =>
          `${String(binding.slotNo)}:${binding.sessionId}:${binding.turnId}:${binding.leaseId}:${binding.daemonEpoch}:${String(binding.leaseEpoch)}:${String(binding.executionFence)}`,
      ),
    );
    if (bindingKeys.size !== bindings.length) {
      throw new TurnTerminalizationInvariantError(
        'interrupt batch bindings must be unique',
      );
    }
    const activeBindings = this.database
      .prepare(
        `SELECT scheduler_slots.slot_no AS slotNo,
                turns.session_id AS sessionId, turns.id AS turnId,
                runner_leases.id AS leaseId,
                runner_leases.daemon_epoch AS daemonEpoch,
                runner_leases.lease_epoch AS leaseEpoch,
                turns.execution_fence AS executionFence
         FROM scheduler_slots
         JOIN turns ON turns.id = scheduler_slots.owner_turn_id
         JOIN runner_leases
           ON runner_leases.current_turn_id = turns.id
          AND runner_leases.status = 'active'
         WHERE scheduler_slots.state = 'owned'
         ORDER BY scheduler_slots.slot_no`,
      )
      .all() as Claim[];
    if (
      activeBindings.length !== bindings.length ||
      activeBindings.some(
        (active) =>
          !bindingKeys.has(
            `${String(active.slotNo)}:${active.sessionId}:${active.turnId}:${active.leaseId}:${active.daemonEpoch}:${String(active.leaseEpoch)}:${String(active.executionFence)}`,
          ),
      )
    ) {
      throw new TurnTerminalizationInvariantError(
        'interrupt batch does not match the complete active tuple set',
      );
    }
  }

  assertLeaseExecutorIdentity(
    binding: Claim,
    expected: LeaseExecutorIdentity,
  ): void {
    this.assertCallerTransaction();
    const current = this.database
      .prepare(
        `SELECT runner_instance_id AS runnerInstanceId, pid,
                process_start_identity AS processStartIdentity
         FROM runner_leases
         WHERE id = ? AND daemon_epoch = ? AND lease_epoch = ?
           AND session_id = ? AND current_turn_id = ? AND status = 'active'`,
      )
      .get(
        binding.leaseId,
        binding.daemonEpoch,
        binding.leaseEpoch,
        binding.sessionId,
        binding.turnId,
      ) as LeaseExecutorIdentity | undefined;
    if (
      !current ||
      current.runnerInstanceId !== expected.runnerInstanceId ||
      current.pid !== expected.pid ||
      current.processStartIdentity !== expected.processStartIdentity
    ) {
      throw new TurnTerminalizationInvariantError(
        'active Lease executor identity changed before recovery',
      );
    }
  }

  private assertGlobalActiveTuples(binding: Pick<Claim, 'daemonEpoch'>): void {
    const slots = this.database
      .prepare(
        `SELECT slot_no AS slotNo, state AS slotState,
                owner_turn_id AS ownerTurnId
         FROM scheduler_slots ORDER BY slot_no`,
      )
      .all() as SlotFact[];
    if (
      slots.length !== SLOT_NOS.length ||
      slots.some((slot, index) => slot.slotNo !== SLOT_NOS[index])
    ) {
      throw new TurnTerminalizationInvariantError('slots must be exactly 1 and 2');
    }
    if (
      slots.some(
        (slot) =>
          !(
            (slot.slotState === 'free' && slot.ownerTurnId === null) ||
            (slot.slotState === 'owned' && slot.ownerTurnId !== null)
          ),
      )
    ) {
      throw new TurnTerminalizationInvariantError('slot ownership projection is invalid');
    }

    const activeTurns = this.database
      .prepare(
        `SELECT id AS turnId, session_id AS sessionId, status AS turnStatus,
                queue_kind AS queueKind, execution_fence AS executionFence,
                started_at AS startedAt, finished_at AS finishedAt,
                error_code AS errorCode, error_message AS errorMessage,
                result_message_id AS resultMessageId
         FROM turns
         WHERE status IN ('running', 'cancel_requested')
         ORDER BY id`,
      )
      .all() as ActiveTurnFact[];
    const activeSessions = this.database
      .prepare(
        `SELECT id AS sessionId, runtime_status AS runtimeStatus,
                queue_block_reason AS queueBlockReason,
                current_turn_id AS currentTurnId
         FROM sessions
         WHERE current_turn_id IS NOT NULL
            OR runtime_status IN ('running', 'canceling')
         ORDER BY id`,
      )
      .all() as ActiveSessionFact[];
    const activeLeases = this.database
      .prepare(
        `SELECT id AS leaseId, daemon_epoch AS daemonEpoch,
                session_id AS sessionId,
                current_turn_id AS turnId, status AS leaseStatus
         FROM runner_leases
         WHERE status = 'active'
         ORDER BY id`,
      )
      .all() as ActiveLeaseFact[];
    const ownedSlots = slots.filter((slot) => slot.slotState === 'owned');
    const activeCount = ownedSlots.length;

    if (
      activeTurns.length !== activeCount ||
      activeSessions.length !== activeCount ||
      activeLeases.length !== activeCount ||
      new Set(ownedSlots.map((slot) => slot.ownerTurnId)).size !== activeCount ||
      new Set(activeTurns.map((turn) => turn.turnId)).size !== activeCount ||
      new Set(activeSessions.map((session) => session.sessionId)).size !== activeCount ||
      new Set(activeLeases.map((lease) => lease.turnId)).size !== activeCount
    ) {
      throw new TurnTerminalizationInvariantError(
        'active facts do not match owned slot count',
      );
    }

    for (const slot of ownedSlots) {
      const ownerTurnId = slot.ownerTurnId as string;
      const turn = activeTurns.find((row) => row.turnId === ownerTurnId);
      const session = turn
        ? activeSessions.find((row) => row.sessionId === turn.sessionId)
        : undefined;
      const lease = activeLeases.find((row) => row.turnId === ownerTurnId);
      const expectedRuntimeStatus =
        turn?.turnStatus === 'cancel_requested' ? 'canceling' : 'running';
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
        lease.daemonEpoch !== binding.daemonEpoch ||
        lease.sessionId !== turn.sessionId ||
        lease.turnId !== turn.turnId ||
        lease.leaseStatus !== 'active'
      ) {
        throw new TurnTerminalizationInvariantError(
          'active slot tuple is inconsistent',
        );
      }
    }
  }

  assertTurnExecutionOwnership(
    binding: Pick<Claim, 'sessionId' | 'turnId'>,
  ): void {
    this.assertCallerTransaction();
    const invalid = this.database
      .prepare(
        `SELECT
           EXISTS (
             SELECT 1
             FROM model_calls
             LEFT JOIN model_attempts AS successful_attempt
               ON successful_attempt.id = model_calls.successful_attempt_id
             WHERE model_calls.turn_id = ?
               AND (
                 model_calls.session_id <> ?
                 OR (
                   model_calls.successful_attempt_id IS NOT NULL
                   AND (
                     successful_attempt.id IS NULL
                     OR successful_attempt.model_call_id <> model_calls.id
                   )
                 )
               )
           ) AS modelCalls,
           EXISTS (
             SELECT 1
             FROM tool_runs
             LEFT JOIN model_calls AS source_call
               ON source_call.id = tool_runs.source_model_call_id
             LEFT JOIN model_attempts AS source_attempt
               ON source_attempt.id = tool_runs.source_model_attempt_id
             LEFT JOIN model_calls AS attempt_call
               ON attempt_call.id = source_attempt.model_call_id
             WHERE (
               tool_runs.turn_id = ?
               OR source_call.turn_id = ?
               OR attempt_call.turn_id = ?
             )
               AND (
                 tool_runs.session_id <> ?
                 OR tool_runs.turn_id <> ?
                 OR source_call.id IS NULL
                 OR source_call.session_id <> ?
                 OR source_call.turn_id <> ?
                 OR source_attempt.id IS NULL
                 OR attempt_call.id IS NULL
                 OR attempt_call.session_id <> ?
                 OR attempt_call.turn_id <> ?
                 OR source_attempt.model_call_id <> source_call.id
               )
           ) AS toolRuns`,
      )
      .get(
        binding.turnId,
        binding.sessionId,
        binding.turnId,
        binding.turnId,
        binding.turnId,
        binding.sessionId,
        binding.turnId,
        binding.sessionId,
        binding.turnId,
        binding.sessionId,
        binding.turnId,
      ) as { readonly modelCalls: number; readonly toolRuns: number };
    if (invalid.modelCalls || invalid.toolRuns) {
      throw new TurnTerminalizationInvariantError(
        'execution ownership is inconsistent',
      );
    }
  }

  readFinalAssistantContent(
    sessionId: string,
    turnId: string,
    modelAttemptId: string,
  ): string {
    this.assertCallerTransaction();
    const nonterminal = this.database
      .prepare(
        `SELECT
           EXISTS(SELECT 1 FROM model_calls
             WHERE session_id = ? AND turn_id = ? AND status = 'running') AS modelCalls,
           EXISTS(SELECT 1 FROM model_attempts
             JOIN model_calls ON model_calls.id = model_attempts.model_call_id
             WHERE model_calls.session_id = ? AND model_calls.turn_id = ?
               AND model_attempts.status = 'running') AS attempts,
           EXISTS(SELECT 1 FROM tool_runs
             WHERE session_id = ? AND turn_id = ?
               AND status IN ('queued', 'running', 'cancel_requested')) AS tools`,
      )
      .get(sessionId, turnId, sessionId, turnId, sessionId, turnId) as {
      readonly modelCalls: number;
      readonly attempts: number;
      readonly tools: number;
    };
    if (nonterminal.modelCalls || nonterminal.attempts || nonterminal.tools) {
      throw new TurnTerminalizationInvariantError(
        'success requires every subexecution to be terminal',
      );
    }

    const latest = this.database
      .prepare(
        `SELECT
           model_attempts.id AS attemptId,
           model_attempts.attempt,
           model_attempts.status AS attemptStatus,
           model_attempts.result_json AS resultJson,
           model_attempts.finish_reason AS finishReason,
           model_calls.id AS modelCallId,
           model_calls.ordinal AS callOrdinal,
           model_calls.status AS callStatus,
           model_calls.successful_attempt_id AS successfulAttemptId
         FROM model_attempts
         JOIN model_calls ON model_calls.id = model_attempts.model_call_id
         WHERE model_calls.session_id = ? AND model_calls.turn_id = ?
           AND model_attempts.status = 'succeeded'
           AND model_calls.ordinal = (
             SELECT MAX(latest_call.ordinal)
             FROM model_calls AS latest_call
             WHERE latest_call.session_id = ? AND latest_call.turn_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM model_attempts AS later_attempt
             WHERE later_attempt.model_call_id = model_attempts.model_call_id
               AND later_attempt.attempt > model_attempts.attempt
           )
         ORDER BY model_attempts.attempt DESC, model_attempts.id DESC
         LIMIT 1`,
      )
      .get(sessionId, turnId, sessionId, turnId) as FinalAttemptRow | undefined;
    if (
      !latest ||
      latest.attemptId !== modelAttemptId ||
      latest.attemptStatus !== 'succeeded' ||
      latest.callStatus !== 'succeeded' ||
      latest.successfulAttemptId !== modelAttemptId ||
      latest.finishReason !== 'stop'
    ) {
      throw new TurnTerminalizationInvariantError(
        'completion does not reference the latest successful ModelAttempt',
      );
    }
    const toolCallCount = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM model_tool_calls
         WHERE model_attempt_id = ?`,
      )
      .get(modelAttemptId) as { readonly count: number };
    if (toolCallCount.count !== 0) {
      throw new TurnTerminalizationInvariantError(
        'final ModelAttempt contains Tool Calls',
      );
    }
    const unresolvedEffects = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tool_runs
         WHERE session_id = ? AND turn_id = ? AND effect_state = 'unknown'
           AND (
             NOT EXISTS (
               SELECT 1 FROM effect_resolutions
               WHERE effect_resolutions.tool_run_id = tool_runs.id
             )
             OR (
               EXISTS (
                 SELECT 1 FROM effect_resolutions
                 WHERE effect_resolutions.tool_run_id = tool_runs.id
                   AND resolution = 'confirmed_applied'
               )
               AND EXISTS (
                 SELECT 1 FROM effect_resolutions
                 WHERE effect_resolutions.tool_run_id = tool_runs.id
                   AND resolution = 'confirmed_not_applied'
               )
             )
           )`,
      )
      .get(sessionId, turnId) as { readonly count: number };
    if (unresolvedEffects.count !== 0) {
      throw new TurnTerminalizationInvariantError(
        'success requires every Tool effect to be resolved',
      );
    }
    return parseFinalResult(latest.resultJson).content;
  }

  readPersistedAssistantContent(
    sessionId: string,
    turnId: string,
    modelAttemptId: string,
  ): string {
    this.assertCallerTransaction();
    const attempt = this.database
      .prepare(
        `SELECT
           model_attempts.id AS attemptId,
           model_attempts.attempt,
           model_attempts.status AS attemptStatus,
           model_attempts.result_json AS resultJson,
           model_attempts.finish_reason AS finishReason,
           model_calls.id AS modelCallId,
           model_calls.ordinal AS callOrdinal,
           model_calls.status AS callStatus,
           model_calls.successful_attempt_id AS successfulAttemptId
         FROM model_attempts
         JOIN model_calls ON model_calls.id = model_attempts.model_call_id
         WHERE model_attempts.id = ? AND model_calls.session_id = ?
           AND model_calls.turn_id = ?`,
      )
      .get(modelAttemptId, sessionId, turnId) as FinalAttemptRow | undefined;
    if (
      !attempt ||
      attempt.attemptStatus !== 'succeeded' ||
      attempt.callStatus !== 'succeeded' ||
      attempt.successfulAttemptId !== modelAttemptId ||
      attempt.finishReason !== 'stop'
    ) {
      throw new TurnTerminalizationInvariantError(
        'assistant result does not reference a persisted successful ModelAttempt',
      );
    }
    const toolCallCount = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM model_tool_calls
         WHERE model_attempt_id = ?`,
      )
      .get(modelAttemptId) as { readonly count: number };
    if (toolCallCount.count !== 0) {
      throw new TurnTerminalizationInvariantError(
        'assistant result ModelAttempt contains Tool Calls',
      );
    }
    return parseFinalResult(attempt.resultJson).content;
  }

  insertAssistantMessage(input: {
    readonly messageId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly content: string;
    readonly now: string;
  }): void {
    this.assertCallerTransaction();
    expectTerminalizationChange(
      this.database
        .prepare(
          `INSERT INTO messages (
            id, session_id, turn_id, role, status, content, created_at, completed_at
          ) VALUES (?, ?, ?, 'assistant', 'completed', ?, ?, ?)`,
        )
        .run(
          input.messageId,
          input.sessionId,
          input.turnId,
          input.content,
          input.now,
          input.now,
        ),
      'assistant Message insert',
    );
  }

  revokeFence(binding: Claim): number {
    this.assertCallerTransaction();
    expectTerminalizationChange(
      this.database
        .prepare(
          `UPDATE turns
           SET execution_fence = execution_fence + 1
           WHERE id = ? AND session_id = ?
             AND status IN ('running', 'cancel_requested')
             AND execution_fence = ?`,
        )
        .run(binding.turnId, binding.sessionId, binding.executionFence),
      'Turn execution fence revocation CAS',
    );
    return binding.executionFence + 1;
  }

  updateTurn(input: {
    readonly binding: Claim;
    readonly expectedStatus: 'running' | 'cancel_requested';
    readonly expectedFence: number;
    readonly status: 'succeeded' | 'failed' | 'interrupted';
    readonly now: string;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly resultMessageId: string | null;
    readonly incrementFence: boolean;
  }): void {
    this.assertCallerTransaction();
    expectTerminalizationChange(
      this.database
        .prepare(
          `UPDATE turns
           SET status = ?, finished_at = ?, error_code = ?, error_message = ?,
               result_message_id = ?,
               execution_fence = execution_fence + ?
           WHERE id = ? AND session_id = ? AND status = ?
             AND execution_fence = ? AND started_at IS NOT NULL
             AND finished_at IS NULL AND error_code IS NULL
             AND error_message IS NULL AND result_message_id IS NULL`,
        )
        .run(
          input.status,
          input.now,
          input.errorCode,
          input.errorMessage,
          input.resultMessageId,
          input.incrementFence ? 1 : 0,
          input.binding.turnId,
          input.binding.sessionId,
          input.expectedStatus,
          input.expectedFence,
        ),
      'Turn terminal CAS',
    );
  }

  expireLease(binding: Claim, now: string): void {
    this.assertCallerTransaction();
    expectTerminalizationChange(
      this.database
        .prepare(
          `UPDATE runner_leases
           SET status = 'expired', lease_expires_at = ?
           WHERE id = ? AND daemon_epoch = ? AND lease_epoch = ?
             AND session_id = ? AND current_turn_id = ? AND status = 'active'`,
        )
        .run(
          now,
          binding.leaseId,
          binding.daemonEpoch,
          binding.leaseEpoch,
          binding.sessionId,
          binding.turnId,
        ),
      'Lease expiration CAS',
    );
  }

  freeSlot(binding: Claim, now: string): void {
    this.assertCallerTransaction();
    expectTerminalizationChange(
      this.database
        .prepare(
          `UPDATE scheduler_slots
           SET state = 'free', owner_turn_id = NULL, updated_at = ?
           WHERE slot_no = ? AND state = 'owned' AND owner_turn_id = ?`,
        )
        .run(now, binding.slotNo, binding.turnId),
      'slot release CAS',
    );
  }

  projectSessionAfterTerminal(input: {
    readonly tuple: ActiveExecutionTuple;
    readonly now: string;
  }): 'queued' | 'idle' {
    this.assertCallerTransaction();
    const eligible = this.database
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM turns
           WHERE turns.session_id = ?
             AND turns.status = 'queued'
             AND turns.queue_kind = 'normal'
             AND NOT EXISTS (
               SELECT 1 FROM turns AS earlier_turns
               WHERE earlier_turns.session_id = turns.session_id
                 AND earlier_turns.status = 'queued'
                 AND earlier_turns.ordinal < turns.ordinal
             )
         ) AS eligible`,
      )
      .get(input.tuple.sessionId) as { readonly eligible: number };
    const runtimeStatus = eligible.eligible ? 'queued' : 'idle';
    expectTerminalizationChange(
      this.database
        .prepare(
          `UPDATE sessions
           SET current_turn_id = NULL, runtime_status = ?, updated_at = ?
           WHERE id = ? AND current_turn_id = ? AND runtime_status = ?
             AND queue_block_reason IS NULL`,
        )
        .run(
          runtimeStatus,
          input.now,
          input.tuple.sessionId,
          input.tuple.turnId,
          input.tuple.runtimeStatus,
        ),
      'Session terminal projection CAS',
    );
    return runtimeStatus;
  }

  projectSessionForRecovery(input: {
    readonly tuple: ActiveExecutionTuple;
    readonly now: string;
  }): number {
    this.assertCallerTransaction();
    expectTerminalizationChange(
      this.database
        .prepare(
          `UPDATE sessions
           SET current_turn_id = NULL,
               queue_block_reason = 'recovery_review',
               recovery_episode = recovery_episode + 1,
               recovery_source_turn_id = ?,
               runtime_status = 'recovering',
               updated_at = ?
           WHERE id = ? AND current_turn_id = ? AND runtime_status = ?
             AND queue_block_reason IS NULL AND recovery_episode = ?`,
        )
        .run(
          input.tuple.turnId,
          input.now,
          input.tuple.sessionId,
          input.tuple.turnId,
          input.tuple.runtimeStatus,
          input.tuple.recoveryEpisode,
        ),
      'Session recovery projection CAS',
    );
    return input.tuple.recoveryEpisode + 1;
  }
}
