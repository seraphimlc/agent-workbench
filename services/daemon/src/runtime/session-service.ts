import {
  EventListAfterResultSchema,
  SessionCreateResultSchema,
  SessionSnapshotSchema,
  TurnEnqueueResultSchema,
  WorkspaceRegisterResultSchema,
  type EventListAfterPayload,
  type EventListAfterResult,
  type SessionCreatePayload,
  type SessionCreateResult,
  type SessionSnapshot,
  type TurnEnqueuePayload,
  type TurnEnqueueResult,
  type WorkspaceRegisterPayload,
  type WorkspaceRegisterResult,
} from '@agent-workbench/protocol';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import type { ZodType } from 'zod';

import { hashCanonicalJson } from '../db/canonical-json.js';
import { DomainError, domainErrors } from '../db/errors.js';
import { IdempotencyRepository } from '../db/idempotency-repository.js';
import { SessionRepository } from '../db/session-repository.js';

type MutationMethod = 'workspace.register' | 'session.create' | 'turn.enqueue';

export interface SessionServiceHooks {
  readonly afterIdempotencyMiss?: (context: {
    readonly method: MutationMethod;
  }) => void;
  readonly beforeCommit?: (context: { readonly method: MutationMethod }) => void;
}

export class SessionService {
  private readonly idempotency: IdempotencyRepository;
  private readonly sessions: SessionRepository;

  constructor(
    private readonly database: Database.Database,
    private readonly hooks: SessionServiceHooks = {},
  ) {
    this.idempotency = new IdempotencyRepository(database);
    this.sessions = new SessionRepository(database);
  }

  registerWorkspace(
    payload: WorkspaceRegisterPayload,
    clientRequestId: string,
  ): WorkspaceRegisterResult {
    return this.mutate(
      'workspace.register',
      payload,
      clientRequestId,
      WorkspaceRegisterResultSchema,
      (now) => {
        let resolvedPath: string;
        let canonicalPath: string;
        try {
          resolvedPath = resolve(payload.path);
          if (!statSync(resolvedPath).isDirectory()) {
            throw domainErrors.workspacePathInvalid();
          }
          canonicalPath = realpathSync.native(payload.path);
        } catch (error) {
          if (error instanceof DomainError) {
            throw error;
          }
          throw domainErrors.workspacePathInvalid();
        }

        const existingId = this.sessions.findWorkspaceIdByCanonicalPath(canonicalPath);
        if (existingId) {
          return { workspaceId: existingId };
        }
        const workspaceId = uuidv7();
        this.sessions.insertWorkspace({
          id: workspaceId,
          path: resolvedPath,
          canonicalPath,
          createdAt: now,
        });
        return { workspaceId };
      },
    );
  }

  createSession(
    payload: SessionCreatePayload,
    clientRequestId: string,
  ): SessionCreateResult {
    return this.mutate(
      'session.create',
      payload,
      clientRequestId,
      SessionCreateResultSchema,
      (now) => {
        if (!this.sessions.workspaceExists(payload.workspaceId)) {
          throw domainErrors.workspaceNotFound();
        }
        const sessionId = uuidv7();
        const messageId = uuidv7();
        const turnId = uuidv7();
        this.sessions.insertInitialSession({
          sessionId,
          messageId,
          turnId,
          sessionCreatedEventId: uuidv7(),
          turnQueuedEventId: uuidv7(),
          workspaceId: payload.workspaceId,
          title: payload.title,
          prompt: payload.prompt,
          clientRequestId,
          now,
        });
        return { sessionId, turnId };
      },
    );
  }

  enqueueTurn(
    payload: TurnEnqueuePayload,
    clientRequestId: string,
  ): TurnEnqueueResult {
    return this.mutate(
      'turn.enqueue',
      payload,
      clientRequestId,
      TurnEnqueueResultSchema,
      (now) => {
        const allocation = this.sessions.getSessionAllocation(payload.sessionId);
        if (!allocation) {
          throw domainErrors.sessionNotFound();
        }
        const turnId = uuidv7();
        this.sessions.insertEnqueuedTurn({
          messageId: uuidv7(),
          turnId,
          eventId: uuidv7(),
          sessionId: payload.sessionId,
          prompt: payload.prompt,
          clientRequestId,
          ordinal: allocation.nextTurnOrdinal,
          eventSeq: allocation.nextEventSeq,
          now,
        });
        return { turnId };
      },
    );
  }

  getSnapshot(sessionId: string): SessionSnapshot {
    return SessionSnapshotSchema.parse(this.sessions.getSnapshot(sessionId));
  }

  listEventsAfter(payload: EventListAfterPayload): EventListAfterResult {
    return EventListAfterResultSchema.parse(this.sessions.listEventsAfter(payload));
  }

  private mutate<Payload, Result>(
    method: MutationMethod,
    payload: Payload,
    clientRequestId: string,
    resultSchema: ZodType<Result>,
    createResult: (now: string) => Result,
  ): Result {
    const normalizedPayloadHash = hashCanonicalJson(payload);
    const transaction = this.database.transaction(() => {
      const replay = this.idempotency.lookup(
        method,
        clientRequestId,
        normalizedPayloadHash,
        resultSchema,
      );
      if (replay.hit) {
        return replay.result;
      }

      this.hooks.afterIdempotencyMiss?.({ method });
      const now = new Date().toISOString();
      const result = resultSchema.parse(createResult(now));
      this.idempotency.insert(
        method,
        clientRequestId,
        normalizedPayloadHash,
        result,
        now,
      );
      this.hooks.beforeCommit?.({ method });
      return result;
    });
    return transaction.immediate();
  }
}
