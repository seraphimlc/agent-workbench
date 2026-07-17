import {
  EventListAfterResultSchema,
  MessageRowSchema,
  RendererSessionEventEnvelopeSchema,
  SessionRowSchema,
  SessionListResultSchema,
  SessionSnapshotSchema,
  TurnRowSchema,
  createEventListAfterResultSchema,
  type EventListAfterPayload,
  type EventListAfterResult,
  type MessageRow,
  type RendererSessionEventEnvelope,
  type SessionRow,
  type SessionListResult,
  type SessionSnapshot,
  type TurnRow,
} from '@agent-workbench/protocol';
import type Database from 'better-sqlite3';

import { domainErrors } from './errors.js';

export interface WorkspaceFact {
  readonly id: string;
  readonly path: string;
  readonly canonicalPath: string;
  readonly createdAt: string;
}

export interface InitialSessionFacts {
  readonly sessionId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly sessionCreatedEventId: string;
  readonly turnQueuedEventId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly prompt: string;
  readonly clientRequestId: string;
  readonly now: string;
}

export interface EnqueuedTurnFacts {
  readonly messageId: string;
  readonly turnId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly clientRequestId: string;
  readonly ordinal: number;
  readonly eventSeq: number;
  readonly now: string;
}

export interface CanceledTurnFacts {
  readonly eventId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly now: string;
}

type SessionAllocation = {
  readonly nextTurnOrdinal: number;
  readonly nextEventSeq: number;
};

type CancelSession = {
  readonly nextEventSeq: number;
  readonly runtimeStatus: string;
  readonly queueBlockReason: string | null;
  readonly recoveryEpisode: number;
  readonly recoverySourceTurnId: string | null;
  readonly currentTurnId: string | null;
};

type CancelTurn = {
  readonly ordinal: number;
  readonly queueKind: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultMessageId: string | null;
  readonly executionFence: number;
};

type CancelEvent = {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly toolRunId: string | null;
  readonly seq: number;
  readonly type: string;
  readonly actor: string;
  readonly audience: string;
  readonly payloadJson: string;
  readonly blobId: string | null;
  readonly createdAt: string;
};

type StoredEvent = {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly toolRunId: string | null;
  readonly seq: number;
  readonly type: string;
  readonly actor: string;
  readonly audience: string;
  readonly payloadJson: string;
  readonly blobId: string | null;
  readonly createdAt: string;
};

export interface SessionRepositoryHooks {
  readonly afterSnapshotSessionRead?: () => void;
  readonly afterEventHighWaterRead?: () => void;
}

export class SessionRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly hooks: SessionRepositoryHooks = {},
  ) {}

  findWorkspaceIdByCanonicalPath(canonicalPath: string): string | undefined {
    const row = this.database
      .prepare('SELECT id FROM workspaces WHERE canonical_path = ?')
      .get(canonicalPath) as { readonly id: string } | undefined;
    return row?.id;
  }

  insertWorkspace(fact: WorkspaceFact): void {
    this.database
      .prepare(
        `INSERT INTO workspaces (id, path, canonical_path, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(fact.id, fact.path, fact.canonicalPath, fact.createdAt);
  }

  workspaceExists(workspaceId: string): boolean {
    return (
      this.database
        .prepare('SELECT 1 FROM workspaces WHERE id = ?')
        .get(workspaceId) !== undefined
    );
  }

  insertInitialSession(facts: InitialSessionFacts): void {
    this.database
      .prepare(
        `INSERT INTO sessions (
          id, title, workspace_id, lifecycle_status, runtime_status,
          queue_block_reason, recovery_episode, recovery_source_turn_id,
          current_turn_id, mode, access_mode, next_turn_ordinal, next_event_seq,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', 'queued', NULL, 0, NULL, NULL, 'craft',
          'full_access', 2, 3, 1, ?, ?)`,
      )
      .run(
        facts.sessionId,
        facts.title,
        facts.workspaceId,
        facts.now,
        facts.now,
      );
    this.database
      .prepare(
        `INSERT INTO messages (
          id, session_id, turn_id, role, status, content, created_at, completed_at
        ) VALUES (?, ?, ?, 'user', 'completed', ?, ?, ?)`,
      )
      .run(
        facts.messageId,
        facts.sessionId,
        facts.turnId,
        facts.prompt,
        facts.now,
        facts.now,
      );
    this.database
      .prepare(
        `INSERT INTO turns (
          id, session_id, ordinal, client_request_id, queue_kind, status,
          input_message_id, mode_snapshot, access_mode_snapshot, queued_at,
          started_at, finished_at, error_code, error_message, result_message_id
        ) VALUES (?, ?, 1, ?, 'normal', 'queued', ?, 'craft', 'full_access', ?,
          NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(
        facts.turnId,
        facts.sessionId,
        facts.clientRequestId,
        facts.messageId,
        facts.now,
      );
    this.insertEvent({
      id: facts.sessionCreatedEventId,
      sessionId: facts.sessionId,
      turnId: null,
      seq: 1,
      type: 'session.created',
      payload: {
        workspaceId: facts.workspaceId,
        title: facts.title,
        mode: 'craft',
        accessMode: 'full_access',
      },
      now: facts.now,
    });
    this.insertEvent({
      id: facts.turnQueuedEventId,
      sessionId: facts.sessionId,
      turnId: facts.turnId,
      seq: 2,
      type: 'turn.queued',
      payload: { ordinal: 1, queueKind: 'normal' },
      now: facts.now,
    });
  }

  getSessionAllocation(sessionId: string): SessionAllocation | undefined {
    return this.database
      .prepare(
        `SELECT next_turn_ordinal AS nextTurnOrdinal,
                next_event_seq AS nextEventSeq
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as SessionAllocation | undefined;
  }

  insertEnqueuedTurn(facts: EnqueuedTurnFacts): void {
    this.database
      .prepare(
        `INSERT INTO messages (
          id, session_id, turn_id, role, status, content, created_at, completed_at
        ) VALUES (?, ?, ?, 'user', 'completed', ?, ?, ?)`,
      )
      .run(
        facts.messageId,
        facts.sessionId,
        facts.turnId,
        facts.prompt,
        facts.now,
        facts.now,
      );
    this.database
      .prepare(
        `INSERT INTO turns (
          id, session_id, ordinal, client_request_id, queue_kind, status,
          input_message_id, mode_snapshot, access_mode_snapshot, queued_at,
          started_at, finished_at, error_code, error_message, result_message_id
        ) VALUES (?, ?, ?, ?, 'normal', 'queued', ?, 'craft', 'full_access', ?,
          NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(
        facts.turnId,
        facts.sessionId,
        facts.ordinal,
        facts.clientRequestId,
        facts.messageId,
        facts.now,
      );
    this.insertEvent({
      id: facts.eventId,
      sessionId: facts.sessionId,
      turnId: facts.turnId,
      seq: facts.eventSeq,
      type: 'turn.queued',
      payload: { ordinal: facts.ordinal, queueKind: 'normal' },
      now: facts.now,
    });
    const update = this.database
      .prepare(
        `UPDATE sessions
         SET next_turn_ordinal = next_turn_ordinal + 1,
             next_event_seq = next_event_seq + 1,
             revision = revision + 1,
             updated_at = ?,
             runtime_status = CASE
               WHEN runtime_status = 'idle' THEN 'queued'
               ELSE runtime_status
             END
         WHERE id = ?
           AND next_turn_ordinal = ?
           AND next_event_seq = ?`,
      )
      .run(
        facts.now,
        facts.sessionId,
        facts.ordinal,
        facts.eventSeq,
      );
    if (update.changes !== 1) {
      throw new Error('Session allocation changed during enqueue');
    }
  }

  listActiveSessions(): SessionListResult {
    const sessions = this.database
      .prepare(
        `SELECT sessions.id,
                sessions.title,
                sessions.runtime_status AS runtimeStatus,
                sessions.current_turn_id AS currentTurnId,
                COUNT(turns.id) AS queuedTurnCount,
                sessions.updated_at AS updatedAt
         FROM sessions
         LEFT JOIN turns
           ON turns.session_id = sessions.id
          AND turns.status = 'queued'
          AND turns.queue_kind = 'normal'
         WHERE sessions.lifecycle_status = 'active'
         GROUP BY sessions.id
         ORDER BY sessions.updated_at DESC, sessions.id DESC`,
      )
      .all();
    return SessionListResultSchema.parse({ sessions });
  }

  cancelQueuedTurn(facts: CanceledTurnFacts): void {
    const { session, turn } = this.readCancelTarget(facts.sessionId, facts.turnId);
    this.assertConsistentRecoveryProjection(session);

    if (turn.status === 'canceled') {
      this.assertCanceledTurnCanReplay(facts.sessionId, facts.turnId, session, turn);
      return;
    }

    if (!this.isCleanQueuedTurn(facts.turnId, turn, session)) {
      throw domainErrors.turnNotCancellable();
    }
    if (this.hasExecutionFacts(facts.turnId)) {
      throw domainErrors.turnNotCancellable();
    }

    const canceled = this.database
      .prepare(
        `UPDATE turns
         SET status = 'canceled', finished_at = ?
         WHERE id = ? AND session_id = ?
           AND status = 'queued' AND queue_kind = 'normal'
           AND started_at IS NULL AND finished_at IS NULL
           AND error_code IS NULL AND error_message IS NULL
           AND result_message_id IS NULL AND execution_fence = 0
           AND NOT EXISTS (
             SELECT 1 FROM sessions
             WHERE sessions.id = turns.session_id
               AND sessions.current_turn_id = turns.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM scheduler_slots WHERE owner_turn_id = turns.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM runner_leases WHERE current_turn_id = turns.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_events
             WHERE turn_id = turns.id AND type = 'turn.started'
           )
           AND NOT EXISTS (
             SELECT 1 FROM model_calls WHERE turn_id = turns.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM model_attempts
             JOIN model_calls ON model_calls.id = model_attempts.model_call_id
             WHERE model_calls.turn_id = turns.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM tool_runs WHERE turn_id = turns.id
           )`,
      )
      .run(facts.now, facts.turnId, facts.sessionId);
    if (canceled.changes !== 1) {
      throw domainErrors.turnNotCancellable();
    }

    this.insertEvent({
      id: facts.eventId,
      sessionId: facts.sessionId,
      turnId: facts.turnId,
      seq: session.nextEventSeq,
      type: 'turn.canceled',
      payload: { ordinal: turn.ordinal, queueKind: 'normal' },
      now: facts.now,
    });
    const projection = this.database
      .prepare(
        `UPDATE sessions
         SET next_event_seq = next_event_seq + 1,
             revision = revision + 1,
             updated_at = ?,
             runtime_status = CASE
               WHEN queue_block_reason = 'recovery_review' THEN 'recovering'
               WHEN current_turn_id IS NOT NULL THEN runtime_status
               WHEN EXISTS (
                 SELECT 1 FROM turns
                 WHERE turns.session_id = sessions.id
                   AND turns.status = 'queued'
                   AND turns.queue_kind = 'normal'
               ) THEN 'queued'
               ELSE 'idle'
             END
         WHERE id = ? AND next_event_seq = ?`,
      )
      .run(facts.now, facts.sessionId, session.nextEventSeq);
    if (projection.changes !== 1) {
      throw new Error('Session allocation changed during cancel');
    }
  }

  verifyCanceledTurnCanReplay(sessionId: string, turnId: string): void {
    const { session, turn } = this.readCancelTarget(sessionId, turnId);
    this.assertConsistentRecoveryProjection(session);
    this.assertCanceledTurnCanReplay(sessionId, turnId, session, turn);
  }

  getSnapshot(sessionId: string): SessionSnapshot {
    const readSnapshot = this.database.transaction(() => {
      const session = this.readSession(sessionId);
      if (!session) {
        throw domainErrors.sessionNotFound();
      }
      this.hooks.afterSnapshotSessionRead?.();
      const messages = this.readMessages(sessionId);
      const turns = this.readTurns(sessionId);
      const highWaterSeq = session.nextEventSeq - 1;
      const events = this.readEvents(sessionId, 0, highWaterSeq);
      return SessionSnapshotSchema.parse({
        session,
        messages,
        turns,
        highWaterSeq,
        events,
      });
    });
    return readSnapshot.deferred();
  }

  listEventsAfter(request: EventListAfterPayload): EventListAfterResult {
    const readPage = this.database.transaction(() => {
      const session = this.readSession(request.sessionId);
      if (!session) {
        throw domainErrors.sessionNotFound();
      }
      const highWaterSeq = session.nextEventSeq - 1;
      this.hooks.afterEventHighWaterRead?.();
      if (request.afterSeq > highWaterSeq) {
        throw domainErrors.eventCursorAhead();
      }
      const eventCount = Math.min(
        request.limit,
        highWaterSeq - request.afterSeq,
      );
      const events = this.readEvents(
        request.sessionId,
        request.afterSeq,
        highWaterSeq,
        eventCount,
      );
      return createEventListAfterResultSchema(request).parse({
        events,
        highWaterSeq,
      });
    });
    return EventListAfterResultSchema.parse(readPage.deferred());
  }

  private readCancelTarget(
    sessionId: string,
    turnId: string,
  ): { readonly session: CancelSession; readonly turn: CancelTurn } {
    const session = this.database
      .prepare(
        `SELECT next_event_seq AS nextEventSeq, runtime_status AS runtimeStatus,
                queue_block_reason AS queueBlockReason,
                recovery_episode AS recoveryEpisode,
                recovery_source_turn_id AS recoverySourceTurnId,
                current_turn_id AS currentTurnId
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as CancelSession | undefined;
    if (!session) {
      throw domainErrors.sessionNotFound();
    }

    const turn = this.database
      .prepare(
        `SELECT ordinal, queue_kind AS queueKind, status,
                started_at AS startedAt, finished_at AS finishedAt,
                error_code AS errorCode, error_message AS errorMessage,
                result_message_id AS resultMessageId,
                execution_fence AS executionFence
         FROM turns WHERE id = ? AND session_id = ?`,
      )
      .get(turnId, sessionId) as CancelTurn | undefined;
    if (!turn) {
      throw domainErrors.turnNotFound();
    }
    return { session, turn };
  }

  private isCleanQueuedTurn(
    turnId: string,
    turn: CancelTurn,
    session: CancelSession,
  ): boolean {
    return (
      turn.status === 'queued' &&
      turn.queueKind === 'normal' &&
      turn.startedAt === null &&
      turn.finishedAt === null &&
      turn.errorCode === null &&
      turn.errorMessage === null &&
      turn.resultMessageId === null &&
      turn.executionFence === 0 &&
      session.currentTurnId !== turnId
    );
  }

  private assertCanceledTurnCanReplay(
    sessionId: string,
    turnId: string,
    session: CancelSession,
    turn: CancelTurn,
  ): void {
    if (
      turn.status !== 'canceled' ||
      turn.queueKind !== 'normal' ||
      turn.startedAt !== null ||
      turn.finishedAt === null ||
      turn.errorCode !== null ||
      turn.errorMessage !== null ||
      turn.resultMessageId !== null ||
      turn.executionFence !== 0 ||
      session.currentTurnId === turnId ||
      !this.hasCanonicalCanceledEvent(sessionId, turnId, session, turn) ||
      this.hasExecutionFacts(turnId)
    ) {
      throw domainErrors.turnNotCancellable();
    }
  }

  private hasExecutionFacts(turnId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT (
           EXISTS (SELECT 1 FROM scheduler_slots WHERE owner_turn_id = @turnId)
           OR EXISTS (SELECT 1 FROM runner_leases WHERE current_turn_id = @turnId)
           OR EXISTS (
             SELECT 1 FROM session_events
             WHERE turn_id = @turnId AND type = 'turn.started'
           )
           OR EXISTS (SELECT 1 FROM model_calls WHERE turn_id = @turnId)
           OR EXISTS (
             SELECT 1 FROM model_attempts
             JOIN model_calls ON model_calls.id = model_attempts.model_call_id
             WHERE model_calls.turn_id = @turnId
           )
           OR EXISTS (SELECT 1 FROM tool_runs WHERE turn_id = @turnId)
         ) AS hasExecutionFacts`,
      )
      .get({ turnId }) as { readonly hasExecutionFacts: number };
    return row.hasExecutionFacts === 1;
  }

  private assertConsistentRecoveryProjection(session: CancelSession): void {
    const hasRecoveryMarker =
      session.runtimeStatus === 'recovering' ||
      session.queueBlockReason !== null ||
      session.recoveryEpisode !== 0 ||
      session.recoverySourceTurnId !== null;
    const consistentRecovery =
      session.runtimeStatus === 'recovering' &&
      session.queueBlockReason === 'recovery_review' &&
      session.currentTurnId === null &&
      session.recoveryEpisode > 0 &&
      session.recoverySourceTurnId !== null;
    if (hasRecoveryMarker && !consistentRecovery) {
      throw domainErrors.turnNotCancellable();
    }
  }

  private hasCanonicalCanceledEvent(
    sessionId: string,
    turnId: string,
    session: CancelSession,
    turn: CancelTurn,
  ): boolean {
    const events = this.database
      .prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, tool_run_id AS toolRunId,
                seq, type, actor, audience, payload_json AS payloadJson,
                blob_id AS blobId, created_at AS createdAt
         FROM session_events
         WHERE session_id = ?
         ORDER BY seq`,
      )
      .all(sessionId) as CancelEvent[];
    const canceledEvents = this.database
      .prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, tool_run_id AS toolRunId,
                seq, type, actor, audience, payload_json AS payloadJson,
                blob_id AS blobId, created_at AS createdAt
         FROM session_events
         WHERE turn_id = ? AND type = 'turn.canceled'`,
      )
      .all(turnId) as CancelEvent[];
    if (
      canceledEvents.length !== 1 ||
      events.length !== session.nextEventSeq - 1 ||
      events.some((event, index) => event.seq !== index + 1)
    ) {
      return false;
    }

    const canceled = canceledEvents[0];
    if (
      !canceled ||
      canceled.sessionId !== sessionId ||
      canceled.turnId !== turnId ||
      canceled.type !== 'turn.canceled' ||
      canceled.actor !== 'daemon' ||
      canceled.audience !== 'both' ||
      canceled.toolRunId !== null ||
      canceled.blobId !== null ||
      canceled.createdAt !== turn.finishedAt ||
      !this.hasCanonicalCanceledPayload(canceled.payloadJson, turn.ordinal)
    ) {
      return false;
    }

    const queuedEvents = events.filter(
      (event) =>
        event.turnId === turnId && event.type === 'turn.queued' && event.seq < canceled.seq,
    );
    return queuedEvents.length === 1;
  }

  private hasCanonicalCanceledPayload(payloadJson: string, ordinal: number): boolean {
    try {
      const payload = JSON.parse(payloadJson) as unknown;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return false;
      }
      const record = payload as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return (
        keys.length === 2 &&
        keys[0] === 'ordinal' &&
        keys[1] === 'queueKind' &&
        record.ordinal === ordinal &&
        record.queueKind === 'normal'
      );
    } catch {
      return false;
    }
  }

  private insertEvent(event: {
    readonly id: string;
    readonly sessionId: string;
    readonly turnId: string | null;
    readonly seq: number;
    readonly type: string;
    readonly payload: unknown;
    readonly now: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO session_events (
          id, session_id, turn_id, tool_run_id, seq, type, actor, audience,
          payload_json, blob_id, created_at
        ) VALUES (?, ?, ?, NULL, ?, ?, 'daemon', 'both', ?, NULL, ?)`,
      )
      .run(
        event.id,
        event.sessionId,
        event.turnId,
        event.seq,
        event.type,
        JSON.stringify(event.payload),
        event.now,
      );
  }

  private readSession(sessionId: string): SessionRow | undefined {
    const row = this.database
      .prepare(
        `SELECT
          id,
          title,
          workspace_id AS workspaceId,
          lifecycle_status AS lifecycleStatus,
          runtime_status AS runtimeStatus,
          queue_block_reason AS queueBlockReason,
          recovery_episode AS recoveryEpisode,
          recovery_source_turn_id AS recoverySourceTurnId,
          current_turn_id AS currentTurnId,
          mode,
          access_mode AS accessMode,
          next_turn_ordinal AS nextTurnOrdinal,
          next_event_seq AS nextEventSeq,
          revision,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM sessions WHERE id = ?`,
      )
      .get(sessionId);
    return row === undefined ? undefined : SessionRowSchema.parse(row);
  }

  private readMessages(sessionId: string): MessageRow[] {
    return this.database
      .prepare(
        `SELECT
          messages.id,
          messages.session_id AS sessionId,
          messages.turn_id AS turnId,
          messages.role,
          messages.status,
          messages.content,
          messages.created_at AS createdAt,
          messages.completed_at AS completedAt
        FROM messages
        JOIN turns ON turns.id = messages.turn_id
        WHERE messages.session_id = ?
        ORDER BY turns.ordinal, messages.created_at, messages.id`,
      )
      .all(sessionId)
      .map((row) => MessageRowSchema.parse(row));
  }

  private readTurns(sessionId: string): TurnRow[] {
    return this.database
      .prepare(
        `SELECT
          id,
          session_id AS sessionId,
          ordinal,
          client_request_id AS clientRequestId,
          queue_kind AS queueKind,
          status,
          input_message_id AS inputMessageId,
          mode_snapshot AS modeSnapshot,
          access_mode_snapshot AS accessModeSnapshot,
          execution_fence AS executionFence,
          queued_at AS queuedAt,
          started_at AS startedAt,
          finished_at AS finishedAt,
          error_code AS errorCode,
          error_message AS errorMessage,
          result_message_id AS resultMessageId
        FROM turns
        WHERE session_id = ?
        ORDER BY ordinal`,
      )
      .all(sessionId)
      .map((row) => TurnRowSchema.parse(row));
  }

  private readEvents(
    sessionId: string,
    afterSeq: number,
    highWaterSeq: number,
    limit?: number,
  ): RendererSessionEventEnvelope[] {
    const limitClause = limit === undefined ? '' : ' LIMIT ?';
    const statement = this.database.prepare(
      `SELECT
        id,
        session_id AS sessionId,
        turn_id AS turnId,
        tool_run_id AS toolRunId,
        seq,
        type,
        actor,
        audience,
        payload_json AS payloadJson,
        blob_id AS blobId,
        created_at AS createdAt
      FROM session_events
      WHERE session_id = ? AND seq > ? AND seq <= ?
      ORDER BY seq${limitClause}`,
    );
    const rows = (limit === undefined
      ? statement.all(sessionId, afterSeq, highWaterSeq)
      : statement.all(sessionId, afterSeq, highWaterSeq, limit)) as StoredEvent[];
    return rows.map((event) => this.projectEvent(event));
  }

  private projectEvent(event: StoredEvent): RendererSessionEventEnvelope {
    if (event.audience === 'model') {
      return RendererSessionEventEnvelopeSchema.parse({
        id: event.id,
        sessionId: event.sessionId,
        turnId: event.turnId,
        toolRunId: event.toolRunId,
        seq: event.seq,
        type: 'redacted',
        actor: event.actor,
        audience: 'model',
        redacted: true,
        payload: null,
        blobId: null,
        createdAt: event.createdAt,
      });
    }
    return RendererSessionEventEnvelopeSchema.parse({
      id: event.id,
      sessionId: event.sessionId,
      turnId: event.turnId,
      toolRunId: event.toolRunId,
      seq: event.seq,
      type: event.type,
      actor: event.actor,
      audience: event.audience,
      redacted: false,
      payload: JSON.parse(event.payloadJson),
      blobId: event.blobId,
      createdAt: event.createdAt,
    });
  }
}
