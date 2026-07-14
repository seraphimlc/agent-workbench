import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';

export interface SessionEventDraft {
  readonly turnId: string | null;
  readonly toolRunId?: string | null;
  readonly type: string;
  readonly actor?: 'user' | 'daemon' | 'runner' | 'model' | 'tool';
  readonly audience?: 'ui' | 'model' | 'both';
  readonly payload: unknown;
  readonly blobId?: string | null;
}

export interface SessionEventWriterOptions {
  readonly createId?: () => string;
}

type SessionAllocationRow = {
  readonly nextEventSeq: number;
  readonly revision: number;
};

export class SessionEventWriterInvariantError extends Error {
  constructor(message: string) {
    super(`Turn terminalization invariant violation: ${message}`);
    this.name = 'SessionEventWriterInvariantError';
  }
}

const expectOneChange = (
  result: Database.RunResult,
  operation: string,
): void => {
  if (result.changes !== 1) {
    throw new SessionEventWriterInvariantError(
      `${operation} affected ${result.changes} rows`,
    );
  }
};

export class SessionEventWriter {
  private readonly createId: () => string;

  constructor(
    private readonly database: Database.Database,
    options: SessionEventWriterOptions = {},
  ) {
    this.createId = options.createId ?? uuidv7;
  }

  append(input: {
    readonly sessionId: string;
    readonly now: string;
    readonly events: readonly SessionEventDraft[];
  }): { readonly firstSeq: number; readonly nextEventSeq: number } {
    if (!this.database.inTransaction) {
      throw new SessionEventWriterInvariantError(
        'SessionEventWriter requires a caller-owned transaction',
      );
    }
    if (input.events.length === 0) {
      throw new SessionEventWriterInvariantError(
        'SessionEventWriter requires an exact positive Event count',
      );
    }
    this.assertEventOwnership(input.sessionId, input.events);

    const allocation = this.database
      .prepare(
        `SELECT next_event_seq AS nextEventSeq, revision
         FROM sessions WHERE id = ?`,
      )
      .get(input.sessionId) as SessionAllocationRow | undefined;
    if (!allocation) {
      throw new SessionEventWriterInvariantError('Session is missing');
    }

    expectOneChange(
      this.database
        .prepare(
          `UPDATE sessions
           SET next_event_seq = next_event_seq + ?,
               revision = revision + 1,
               updated_at = ?
           WHERE id = ? AND next_event_seq = ? AND revision = ?`,
        )
        .run(
          input.events.length,
          input.now,
          input.sessionId,
          allocation.nextEventSeq,
          allocation.revision,
        ),
      'Session Event allocation CAS',
    );

    for (const [offset, event] of input.events.entries()) {
      expectOneChange(
        this.database
          .prepare(
            `INSERT INTO session_events (
              id, session_id, turn_id, tool_run_id, seq, type, actor, audience,
              payload_json, blob_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.createId(),
            input.sessionId,
            event.turnId,
            event.toolRunId ?? null,
            allocation.nextEventSeq + offset,
            event.type,
            event.actor ?? 'daemon',
            event.audience ?? 'both',
            JSON.stringify(event.payload),
            event.blobId ?? null,
            input.now,
          ),
        `${event.type} Event insert`,
      );
    }

    return {
      firstSeq: allocation.nextEventSeq,
      nextEventSeq: allocation.nextEventSeq + input.events.length,
    };
  }

  private assertEventOwnership(
    sessionId: string,
    events: readonly SessionEventDraft[],
  ): void {
    const ownsTurn = this.database.prepare(
      'SELECT 1 FROM turns WHERE id = ? AND session_id = ?',
    );
    const ownsToolRun = this.database.prepare(
      `SELECT 1 FROM tool_runs
       WHERE id = ? AND session_id = ? AND turn_id = ?`,
    );

    for (const event of events) {
      if (event.turnId !== null && !ownsTurn.get(event.turnId, sessionId)) {
        throw new SessionEventWriterInvariantError(
          'Event Turn does not belong to the Session',
        );
      }
      if (
        event.toolRunId !== undefined &&
        event.toolRunId !== null &&
        (event.turnId === null ||
          !ownsToolRun.get(event.toolRunId, sessionId, event.turnId))
      ) {
        throw new SessionEventWriterInvariantError(
          'Event ToolRun does not belong to the Session and Turn',
        );
      }
    }
  }
}
