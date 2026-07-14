import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';

import {
  ExecutionRepository,
  TurnTerminalizationInvariantError,
} from '../db/execution-repository.js';
import {
  SessionEventWriter,
  type SessionEventDraft,
} from '../db/session-event-writer.js';
import {
  ExecutionRecovery,
  type EffectResolutionInput,
} from './execution-recovery.js';
import type { Claim } from './scheduler.js';

export type TerminalizationWriteGroup =
  | 'fence'
  | 'effectResolutions'
  | 'modelAttempts'
  | 'modelCalls'
  | 'toolRuns'
  | 'subexecutions'
  | 'result'
  | 'turn'
  | 'lease'
  | 'slot'
  | 'session'
  | 'events';

export interface TurnTerminalizerHooks {
  readonly afterWriteGroup?: (group: TerminalizationWriteGroup) => void;
}

export interface TurnTerminalizerOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly onCommitted?: () => void;
  readonly hooks?: TurnTerminalizerHooks;
}

export type TurnSuccessResult = {
  readonly status: 'succeeded';
  readonly resultMessageId: string;
};

const stableErrorMessage = (message: string): string =>
  message.trim().length === 0 ? 'Execution failed' : message;

export class TurnTerminalizer {
  private readonly repository: ExecutionRepository;
  private readonly recovery: ExecutionRecovery;
  private readonly events: SessionEventWriter;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly onCommitted: () => void;
  private readonly hooks: TurnTerminalizerHooks;

  constructor(
    private readonly database: Database.Database,
    options: TurnTerminalizerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? uuidv7;
    this.onCommitted = options.onCommitted ?? (() => undefined);
    this.hooks = options.hooks ?? {};
    this.repository = new ExecutionRepository(database);
    this.recovery = new ExecutionRecovery(database, {
      createId: this.createId,
      afterWriteGroup: (group) => {
        this.after(group);
      },
    });
    this.events = new SessionEventWriter(database, { createId: this.createId });
  }

  succeed(input: {
    readonly binding: Claim;
    readonly modelAttemptId: string;
  }): TurnSuccessResult {
    return this.commit(() => {
      const now = this.now().toISOString();
      const tuple = this.repository.readActiveTuple(input.binding, ['running']);
      const content = this.repository.readFinalAssistantContent(
        input.binding.sessionId,
        input.binding.turnId,
        input.modelAttemptId,
      );
      const resultMessageId = this.createId();
      this.repository.insertAssistantMessage({
        messageId: resultMessageId,
        sessionId: input.binding.sessionId,
        turnId: input.binding.turnId,
        content,
        now,
      });
      this.after('result');
      this.repository.updateTurn({
        binding: input.binding,
        expectedStatus: tuple.turnStatus,
        expectedFence: input.binding.executionFence,
        status: 'succeeded',
        now,
        errorCode: null,
        errorMessage: null,
        resultMessageId,
        incrementFence: true,
      });
      this.after('turn');
      this.repository.expireLease(input.binding, now);
      this.after('lease');
      this.repository.freeSlot(input.binding, now);
      this.after('slot');
      this.repository.projectSessionAfterTerminal({ tuple, now });
      this.after('session');
      this.events.append({
        sessionId: input.binding.sessionId,
        now,
        events: [
          {
            turnId: input.binding.turnId,
            type: 'turn.succeeded',
            payload: { modelAttemptId: input.modelAttemptId },
          },
        ],
      });
      this.after('events');
      return { status: 'succeeded', resultMessageId };
    });
  }

  fail(input: {
    readonly binding: Claim;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly assistantResult?: {
      readonly modelAttemptId: string;
    };
  }): void {
    this.commit(() => {
      const now = this.now().toISOString();
      const tuple = this.repository.readActiveTuple(input.binding, ['running']);
      const errorMessage = stableErrorMessage(input.errorMessage);
      const subexecutionEvents = this.recovery.fail({
        sessionId: input.binding.sessionId,
        turnId: input.binding.turnId,
        errorCode: input.errorCode,
        errorMessage,
        now,
      });
      this.after('subexecutions');

      let resultMessageId: string | null = null;
      if (input.assistantResult) {
        const content = this.repository.readPersistedAssistantContent(
          input.binding.sessionId,
          input.binding.turnId,
          input.assistantResult.modelAttemptId,
        );
        resultMessageId = this.createId();
        this.repository.insertAssistantMessage({
          messageId: resultMessageId,
          sessionId: input.binding.sessionId,
          turnId: input.binding.turnId,
          content,
          now,
        });
        this.after('result');
      }

      this.repository.updateTurn({
        binding: input.binding,
        expectedStatus: tuple.turnStatus,
        expectedFence: input.binding.executionFence,
        status: 'failed',
        now,
        errorCode: input.errorCode,
        errorMessage,
        resultMessageId,
        incrementFence: true,
      });
      this.after('turn');
      this.repository.expireLease(input.binding, now);
      this.after('lease');
      this.repository.freeSlot(input.binding, now);
      this.after('slot');
      this.repository.projectSessionAfterTerminal({ tuple, now });
      this.after('session');
      this.events.append({
        sessionId: input.binding.sessionId,
        now,
        events: [
          ...subexecutionEvents,
          {
            turnId: input.binding.turnId,
            type: 'turn.failed',
            payload: { errorCode: input.errorCode },
          },
        ],
      });
      this.after('events');
    });
  }

  interrupt(input: {
    readonly binding: Claim;
    readonly reason: string;
    readonly executorExited: boolean;
    readonly resolutions?: readonly EffectResolutionInput[];
  }): void {
    if (input.reason.trim().length === 0) {
      throw new TurnTerminalizationInvariantError(
        'interrupt reason must be non-blank',
      );
    }
    this.commit(() => {
      if (!input.executorExited) {
        throw new TurnTerminalizationInvariantError(
          'executor exit must be proven before releasing the slot',
        );
      }
      const now = this.now().toISOString();
      const tuple = this.repository.readActiveTuple(input.binding, [
        'running',
        'cancel_requested',
      ]);
      const revokedFence = this.repository.revokeFence(input.binding);
      this.after('fence');
      const subexecutionEvents = this.recovery.interrupt({
        sessionId: input.binding.sessionId,
        turnId: input.binding.turnId,
        reason: input.reason,
        now,
        ...(input.resolutions ? { resolutions: input.resolutions } : {}),
      });
      this.after('subexecutions');
      this.repository.updateTurn({
        binding: input.binding,
        expectedStatus: tuple.turnStatus,
        expectedFence: revokedFence,
        status: 'interrupted',
        now,
        errorCode: null,
        errorMessage: null,
        resultMessageId: null,
        incrementFence: false,
      });
      this.after('turn');
      this.repository.expireLease(input.binding, now);
      this.after('lease');
      this.repository.freeSlot(input.binding, now);
      this.after('slot');
      const recoveryEpisode = this.repository.projectSessionForRecovery({
        tuple,
        now,
      });
      this.after('session');
      const terminalEvents: SessionEventDraft[] = [
        ...subexecutionEvents,
        {
          turnId: input.binding.turnId,
          type: 'turn.interrupted',
          payload: { reason: input.reason },
        },
        {
          turnId: input.binding.turnId,
          type: 'recovery.detected',
          payload: {
            reason: input.reason,
            recoveryEpisode,
            recoverySourceTurnId: input.binding.turnId,
          },
        },
      ];
      this.events.append({
        sessionId: input.binding.sessionId,
        now,
        events: terminalEvents,
      });
      this.after('events');
    });
  }

  private commit<Result>(operation: () => Result): Result {
    if (this.database.inTransaction) {
      throw new TurnTerminalizationInvariantError(
        'TurnTerminalizer owns its BEGIN IMMEDIATE transaction',
      );
    }
    const transaction = this.database.transaction(operation);
    const result = transaction.immediate();
    try {
      this.onCommitted();
    } catch {
      // The durable commit is authoritative; a wake callback is advisory only.
    }
    return result;
  }

  private after(group: TerminalizationWriteGroup): void {
    this.hooks.afterWriteGroup?.(group);
  }
}

export { TurnTerminalizationInvariantError };
