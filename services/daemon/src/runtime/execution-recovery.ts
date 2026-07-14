import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';

import type { SessionEventDraft } from '../db/session-event-writer.js';
import {
  ExecutionRepository,
  TurnTerminalizationInvariantError,
  expectTerminalizationChange,
} from '../db/execution-repository.js';

type ActiveAttemptRow = {
  readonly id: string;
  readonly callOrdinal: number;
  readonly attempt: number;
};

type ActiveModelCallRow = {
  readonly id: string;
  readonly ordinal: number;
};

type ActiveToolRunRow = {
  readonly id: string;
  readonly ordinal: number;
  readonly status: 'queued' | 'running' | 'cancel_requested';
  readonly executionMode: 'read_inline' | 'worker' | 'transactional_intrinsic';
  readonly dispatchState: 'prepared' | 'worker_ready' | 'go_sent' | 'acknowledged' | null;
  readonly effectState: 'not_applied' | 'applied' | 'unknown';
};

type ToolTerminalDecision = ActiveToolRunRow & {
  readonly outcome: 'failed' | 'canceled' | 'interrupted';
  readonly terminalEffectState: 'not_applied' | 'applied' | 'unknown';
  readonly eventSuffix: 'failed' | 'canceled' | 'interrupted';
};

export interface EffectResolutionInput {
  readonly resolutionKey: string;
  readonly toolRunId: string;
  readonly resolution: 'confirmed_applied' | 'confirmed_not_applied';
  readonly evidence: unknown;
}

export interface ExecutionRecoveryOptions {
  readonly createId?: () => string;
  readonly afterWriteGroup?: (group: ExecutionRecoveryWriteGroup) => void;
}

export type ExecutionRecoveryWriteGroup =
  | 'effectResolutions'
  | 'modelAttempts'
  | 'modelCalls'
  | 'toolRuns';

export class ExecutionRecovery {
  private readonly repository: ExecutionRepository;
  private readonly createId: () => string;
  private readonly afterWriteGroup: (group: ExecutionRecoveryWriteGroup) => void;

  constructor(
    private readonly database: Database.Database,
    options: ExecutionRecoveryOptions = {},
  ) {
    this.repository = new ExecutionRepository(database);
    this.createId = options.createId ?? uuidv7;
    this.afterWriteGroup = options.afterWriteGroup ?? (() => undefined);
  }

  fail(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly now: string;
  }): SessionEventDraft[] {
    this.assertCallerTransaction();
    this.assertFailSafeEffects(input.sessionId, input.turnId);
    const tools = this.readActiveToolRuns(input.sessionId, input.turnId).map(
      (tool) => this.decideFailedTool(tool),
    );
    return this.closeSubexecutions({
      ...input,
      outcome: 'failed',
      eventSuffix: 'failed',
      payload: { errorCode: input.errorCode },
      tools,
    });
  }

  interrupt(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly reason: string;
    readonly now: string;
    readonly resolutions?: readonly EffectResolutionInput[];
  }): SessionEventDraft[] {
    this.assertCallerTransaction();
    const tools = this.readActiveToolRuns(input.sessionId, input.turnId).map(
      (tool) => this.decideInterruptedTool(tool),
    );
    const resolutions = input.resolutions ?? [];
    this.assertInterruptResolutions(tools, resolutions);
    this.insertResolutions(
      input.sessionId,
      input.turnId,
      input.now,
      resolutions,
    );
    this.afterWriteGroup('effectResolutions');
    return this.closeSubexecutions({
      sessionId: input.sessionId,
      turnId: input.turnId,
      errorCode: null,
      errorMessage: null,
      now: input.now,
      outcome: 'interrupted',
      eventSuffix: 'interrupted',
      payload: { reason: input.reason },
      tools,
    });
  }

  private assertCallerTransaction(): void {
    if (!this.database.inTransaction) {
      throw new TurnTerminalizationInvariantError(
        'ExecutionRecovery requires a caller-owned transaction',
      );
    }
    this.repository.assertCallerTransaction();
  }

  private assertFailSafeEffects(sessionId: string, turnId: string): void {
    const unsafe = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tool_runs
         WHERE session_id = ? AND turn_id = ?
           AND (
             effect_state = 'applied'
             OR EXISTS (
               SELECT 1 FROM effect_resolutions
               WHERE effect_resolutions.tool_run_id = tool_runs.id
                 AND resolution = 'confirmed_applied'
             )
             OR (
               status NOT IN ('queued', 'running', 'cancel_requested')
               AND effect_state = 'unknown'
               AND NOT EXISTS (
                 SELECT 1 FROM effect_resolutions
                 WHERE effect_resolutions.tool_run_id = tool_runs.id
                   AND resolution = 'confirmed_not_applied'
               )
             )
             OR (
               status IN ('queued', 'running', 'cancel_requested')
               AND (
                 (
                   execution_mode = 'worker'
                   AND dispatch_state IN ('go_sent', 'acknowledged')
                   AND NOT (
                     EXISTS (
                       SELECT 1 FROM effect_resolutions
                       WHERE effect_resolutions.tool_run_id = tool_runs.id
                         AND resolution = 'confirmed_not_applied'
                     )
                     AND NOT EXISTS (
                       SELECT 1 FROM effect_resolutions
                       WHERE effect_resolutions.tool_run_id = tool_runs.id
                         AND resolution = 'confirmed_applied'
                     )
                   )
                 )
                 OR (
                   effect_state = 'unknown'
                   AND NOT (
                     execution_mode IN ('read_inline', 'transactional_intrinsic')
                     OR (
                       execution_mode = 'worker'
                       AND dispatch_state IN ('prepared', 'worker_ready')
                     )
                     OR (
                       EXISTS (
                         SELECT 1 FROM effect_resolutions
                         WHERE effect_resolutions.tool_run_id = tool_runs.id
                           AND resolution = 'confirmed_not_applied'
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM effect_resolutions
                         WHERE effect_resolutions.tool_run_id = tool_runs.id
                           AND resolution = 'confirmed_applied'
                       )
                     )
                   )
                 )
               )
             )
           )`,
      )
      .get(sessionId, turnId) as { readonly count: number };
    if (unsafe.count !== 0) {
      throw new TurnTerminalizationInvariantError(
        'failure cannot prove every Tool effect is safe and resolved',
      );
    }
  }

  private insertResolutions(
    sessionId: string,
    turnId: string,
    now: string,
    resolutions: readonly EffectResolutionInput[],
  ): void {
    const seen = new Set<string>();
    for (const resolution of resolutions) {
      if (seen.has(resolution.toolRunId)) {
        throw new TurnTerminalizationInvariantError(
          'recovery supplied duplicate Tool effect resolutions',
        );
      }
      seen.add(resolution.toolRunId);
      const tool = this.database
        .prepare(
          `SELECT effect_state AS effectState
           FROM tool_runs
           WHERE id = ? AND session_id = ? AND turn_id = ?`,
        )
        .get(resolution.toolRunId, sessionId, turnId) as
        | { readonly effectState: string }
        | undefined;
      if (!tool || tool.effectState !== 'unknown') {
        throw new TurnTerminalizationInvariantError(
          'recovery resolution does not own an unknown Tool effect',
        );
      }
      const existing = this.database
        .prepare(
          `SELECT resolution FROM effect_resolutions
           WHERE tool_run_id = ?`,
        )
        .all(resolution.toolRunId) as Array<{ readonly resolution: string }>;
      if (
        existing.some((row) => row.resolution !== resolution.resolution) ||
        existing.some((row) => row.resolution === resolution.resolution)
      ) {
        throw new TurnTerminalizationInvariantError(
          'recovery resolution conflicts with persisted evidence',
        );
      }
      expectTerminalizationChange(
        this.database
          .prepare(
            `INSERT INTO effect_resolutions (
              id, resolution_key, tool_run_id, resolution,
              evidence_json, actor, created_at
            ) VALUES (?, ?, ?, ?, ?, 'daemon', ?)`,
          )
          .run(
            this.createId(),
            resolution.resolutionKey,
            resolution.toolRunId,
            resolution.resolution,
            JSON.stringify(resolution.evidence),
            now,
          ),
        'effect Resolution insert',
      );
    }
  }

  private assertInterruptResolutions(
    tools: readonly ToolTerminalDecision[],
    resolutions: readonly EffectResolutionInput[],
  ): void {
    const activeTools = new Map(tools.map((tool) => [tool.id, tool]));
    for (const resolution of resolutions) {
      const tool = activeTools.get(resolution.toolRunId);
      if (
        tool?.terminalEffectState === 'not_applied' &&
        resolution.resolution === 'confirmed_applied'
      ) {
        throw new TurnTerminalizationInvariantError(
          'recovery Resolution contradicts a deterministically not-applied ToolRun',
        );
      }
    }
  }

  private readActiveToolRuns(
    sessionId: string,
    turnId: string,
  ): ActiveToolRunRow[] {
    return this.database
      .prepare(
        `SELECT id, ordinal, status,
                execution_mode AS executionMode,
                dispatch_state AS dispatchState,
                effect_state AS effectState
         FROM tool_runs
         WHERE session_id = ? AND turn_id = ?
           AND status IN ('queued', 'running', 'cancel_requested')
         ORDER BY ordinal, id`,
      )
      .all(sessionId, turnId) as ActiveToolRunRow[];
  }

  private decideFailedTool(tool: ActiveToolRunRow): ToolTerminalDecision {
    const deterministicallyNotApplied =
      tool.executionMode === 'read_inline' ||
      tool.executionMode === 'transactional_intrinsic' ||
      (tool.executionMode === 'worker' &&
        (tool.dispatchState === 'prepared' || tool.dispatchState === 'worker_ready'));
    return {
      ...tool,
      outcome: 'failed',
      terminalEffectState:
        tool.effectState === 'unknown' && deterministicallyNotApplied
          ? 'not_applied'
          : tool.effectState,
      eventSuffix: 'failed',
    };
  }

  private decideInterruptedTool(tool: ActiveToolRunRow): ToolTerminalDecision {
    if (tool.executionMode === 'worker') {
      if (tool.dispatchState === 'prepared' || tool.dispatchState === 'worker_ready') {
        if (tool.effectState === 'applied') {
          throw new TurnTerminalizationInvariantError(
            'pre-GO worker ToolRun cannot have an applied effect',
          );
        }
        return {
          ...tool,
          outcome: 'canceled',
          terminalEffectState: 'not_applied',
          eventSuffix: 'canceled',
        };
      }
      if (tool.dispatchState === 'go_sent' || tool.dispatchState === 'acknowledged') {
        if (tool.effectState === 'not_applied') {
          throw new TurnTerminalizationInvariantError(
            'dispatched worker ToolRun cannot claim a not-applied effect',
          );
        }
        return {
          ...tool,
          outcome: 'interrupted',
          terminalEffectState: tool.effectState,
          eventSuffix: 'interrupted',
        };
      }
      throw new TurnTerminalizationInvariantError(
        'worker ToolRun dispatch state is invalid',
      );
    }

    if (tool.dispatchState !== null) {
      throw new TurnTerminalizationInvariantError(
        'inline ToolRun cannot have a dispatch state',
      );
    }
    if (
      tool.executionMode === 'read_inline' &&
      tool.effectState !== 'not_applied'
    ) {
      throw new TurnTerminalizationInvariantError(
        'read-inline ToolRun effect state is invalid',
      );
    }
    if (
      tool.executionMode === 'transactional_intrinsic' &&
      tool.effectState === 'applied'
    ) {
      throw new TurnTerminalizationInvariantError(
        'active transactional ToolRun cannot have an applied effect',
      );
    }
    const canceled = tool.status === 'queued';
    return {
      ...tool,
      outcome: canceled ? 'canceled' : 'interrupted',
      terminalEffectState: 'not_applied',
      eventSuffix: canceled ? 'canceled' : 'interrupted',
    };
  }

  private closeSubexecutions(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly now: string;
    readonly outcome: 'failed' | 'interrupted';
    readonly eventSuffix: 'failed' | 'interrupted';
    readonly payload: unknown;
    readonly tools: readonly ToolTerminalDecision[];
  }): SessionEventDraft[] {
    const attempts = this.database
      .prepare(
        `SELECT model_attempts.id,
                model_calls.ordinal AS callOrdinal,
                model_attempts.attempt
         FROM model_attempts
         JOIN model_calls ON model_calls.id = model_attempts.model_call_id
         WHERE model_calls.session_id = ? AND model_calls.turn_id = ?
           AND model_attempts.status = 'running'
         ORDER BY model_calls.ordinal, model_attempts.attempt, model_attempts.id`,
      )
      .all(input.sessionId, input.turnId) as ActiveAttemptRow[];
    const calls = this.database
      .prepare(
        `SELECT id, ordinal FROM model_calls
         WHERE session_id = ? AND turn_id = ? AND status = 'running'
         ORDER BY ordinal, id`,
      )
      .all(input.sessionId, input.turnId) as ActiveModelCallRow[];
    const events: SessionEventDraft[] = [];
    for (const attempt of attempts) {
      expectTerminalizationChange(
        this.database
          .prepare(
            `UPDATE model_attempts
             SET status = ?, error_code = ?, error_message = ?,
                 retryable = 0, finished_at = ?
             WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
          )
          .run(
            input.outcome,
            input.errorCode,
            input.errorMessage,
            input.now,
            attempt.id,
          ),
        'ModelAttempt terminal CAS',
      );
      events.push({
        turnId: input.turnId,
        type: `model.attempt_${input.eventSuffix}`,
        actor: 'daemon',
        audience: 'both',
        payload: input.payload,
      });
    }
    this.afterWriteGroup('modelAttempts');
    for (const call of calls) {
      expectTerminalizationChange(
        this.database
          .prepare(
            `UPDATE model_calls
             SET status = ?, error_code = ?, error_message = ?, finished_at = ?
             WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
          )
          .run(
            input.outcome,
            input.errorCode,
            input.errorMessage,
            input.now,
            call.id,
          ),
        'ModelCall terminal CAS',
      );
      events.push({
        turnId: input.turnId,
        type: `model.${input.eventSuffix}`,
        actor: 'daemon',
        audience: 'both',
        payload: input.payload,
      });
    }
    this.afterWriteGroup('modelCalls');
    for (const tool of input.tools) {
      expectTerminalizationChange(
        this.database
          .prepare(
            `UPDATE tool_runs
             SET status = ?, effect_state = ?,
                 error_code = ?, error_message = ?, finished_at = ?
             WHERE id = ? AND status IN ('queued', 'running', 'cancel_requested')
               AND finished_at IS NULL`,
          )
          .run(
            tool.outcome,
            tool.terminalEffectState,
            input.errorCode,
            input.errorMessage,
            input.now,
            tool.id,
          ),
        'ToolRun terminal CAS',
      );
      events.push({
        turnId: input.turnId,
        toolRunId: tool.id,
        type: `tool.${tool.eventSuffix}`,
        actor: 'daemon',
        audience: 'both',
        payload: input.payload,
      });
    }
    this.afterWriteGroup('toolRuns');
    return events;
  }
}
