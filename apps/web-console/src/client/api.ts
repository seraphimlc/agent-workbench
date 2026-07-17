import {
  EventListAfterPayloadSchema,
  type EventListAfterPayload,
  type SessionSnapshot,
} from '@agent-workbench/protocol';
import type { ZodType } from 'zod';

import {
  CancelTurnSubmissionSchema,
  PublicErrorResponseSchema,
  RuntimePublicInfoSchema,
  SessionCreatedHttpResponseSchema,
  SessionListHttpResponseSchema,
  SessionSnapshotHttpResponseSchema,
  SessionSubmissionSchema,
  TurnSubmissionSchema,
  TurnCanceledHttpResponseSchema,
  TurnSubmittedHttpResponseSchema,
  createSessionEventsHttpResponseSchema,
  type CancelTurnSubmission,
  type PublicError,
  type RuntimePublicInfo,
  type SessionCreatedHttpResponse,
  type SessionListHttpResponse,
  type SessionEventsHttpResponse,
  type SessionSubmission,
  type TurnSubmittedHttpResponse,
  type TurnCanceledHttpResponse,
  type TurnSubmission,
} from '../shared/contracts.js';

const CSRF_META_NAME = 'agent-workbench-csrf';
const CSRF_HEADER_NAME = 'x-agent-workbench-csrf';

type Fetch = typeof globalThis.fetch;

type ClientDependencies = {
  readonly document?: Document;
  readonly fetch?: Fetch;
  readonly uuidSource?: RandomUuidSource;
};

type RandomUuidSource = {
  randomUUID(): string;
};

export type MutationOperationInput = Readonly<{
  prompt: string;
}>;

export type MutationOperation<Result> = Readonly<{
  execute(): Promise<Result>;
  retry(): Promise<Result>;
}>;

export class ApiPublicError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly userAction: string | null;

  constructor(status: number, error: PublicError) {
    super(error.message);
    this.name = 'ApiPublicError';
    this.status = status;
    this.code = error.code;
    this.retryable = error.retryable;
    this.userAction = error.userAction;
  }
}

export const readCsrfToken = (source: Document = document): string => {
  const meta = source.querySelector<HTMLMetaElement>(
    `meta[name="${CSRF_META_NAME}"]`,
  );
  const token = meta?.content.trim();
  if (!token) throw new Error('CSRF_BOOTSTRAP_MISSING');
  return token;
};

export const createLogicalSubmission = (
  prompt: string,
  uuidSource: RandomUuidSource = crypto,
): SessionSubmission =>
  SessionSubmissionSchema.parse({
    submissionId: uuidSource.randomUUID(),
    prompt,
  });

const createCancelTurnSubmission = (
  uuidSource: RandomUuidSource,
): CancelTurnSubmission =>
  CancelTurnSubmissionSchema.parse({ submissionId: uuidSource.randomUUID() });

const parseResponse = async <Output>(
  response: Response,
  schema: ZodType<Output>,
): Promise<Output> => {
  const body: unknown = await response.json();
  if (!response.ok) {
    const failure = PublicErrorResponseSchema.parse(body);
    throw new ApiPublicError(response.status, failure.error);
  }
  return schema.parse(body);
};

const sessionPath = (sessionId: string): string => encodeURIComponent(sessionId);
const turnPath = (turnId: string): string => encodeURIComponent(turnId);

export type ApiClient = {
  getRuntime(): Promise<RuntimePublicInfo>;
  listSessions(): Promise<SessionListHttpResponse>;
  createSession(submission: SessionSubmission): Promise<SessionCreatedHttpResponse>;
  createSessionOperation(
    input: MutationOperationInput,
  ): MutationOperation<SessionCreatedHttpResponse>;
  submitTurn(
    sessionId: string,
    submission: TurnSubmission,
  ): Promise<TurnSubmittedHttpResponse>;
  createTurnOperation(
    sessionId: string,
    input: MutationOperationInput,
  ): MutationOperation<TurnSubmittedHttpResponse>;
  cancelTurn(
    sessionId: string,
    turnId: string,
    submission: CancelTurnSubmission,
  ): Promise<TurnCanceledHttpResponse>;
  createCancelTurnOperation(
    sessionId: string,
    turnId: string,
  ): MutationOperation<TurnCanceledHttpResponse>;
  getSnapshot(sessionId: string): Promise<SessionSnapshot>;
  getEvents(request: EventListAfterPayload): Promise<SessionEventsHttpResponse>;
};

const mutationOperation = <Result>(
  execute: () => Promise<Result>,
): MutationOperation<Result> => Object.freeze({ execute, retry: execute });

export const createApiClient = (
  dependencies: ClientDependencies = {},
): ApiClient => {
  const csrfToken = readCsrfToken(dependencies.document ?? document);
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const uuidSource = dependencies.uuidSource ?? crypto;
  const get = async <Output>(url: string, schema: ZodType<Output>) =>
    parseResponse(
      await fetch(url, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      }),
      schema,
    );
  const post = async <Output>(
    url: string,
    body: SessionSubmission | TurnSubmission | CancelTurnSubmission,
    schema: ZodType<Output>,
  ) =>
    parseResponse(
      await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [CSRF_HEADER_NAME]: csrfToken,
        },
        body: JSON.stringify(body),
      }),
      schema,
    );

  const createSession = (submission: SessionSubmission) =>
    post(
      '/api/sessions',
      SessionSubmissionSchema.parse(submission),
      SessionCreatedHttpResponseSchema,
    );
  const submitTurn = (sessionId: string, submission: TurnSubmission) =>
    post(
      `/api/sessions/${sessionPath(sessionId)}/turns`,
      TurnSubmissionSchema.parse(submission),
      TurnSubmittedHttpResponseSchema,
    );
  const cancelTurn = (
    sessionId: string,
    turnId: string,
    submission: CancelTurnSubmission,
  ) =>
    post(
      `/api/sessions/${sessionPath(sessionId)}/turns/${turnPath(turnId)}/cancel`,
      CancelTurnSubmissionSchema.parse(submission),
      TurnCanceledHttpResponseSchema,
    );

  return {
    getRuntime: () => get('/api/runtime', RuntimePublicInfoSchema),
    listSessions: () => get('/api/sessions', SessionListHttpResponseSchema),
    createSession,
    createSessionOperation: (input) => {
      const submission = createLogicalSubmission(input.prompt, uuidSource);
      return mutationOperation(() => createSession(submission));
    },
    submitTurn,
    createTurnOperation: (sessionId, input) => {
      const submission = createLogicalSubmission(input.prompt, uuidSource);
      return mutationOperation(() => submitTurn(sessionId, submission));
    },
    cancelTurn,
    createCancelTurnOperation: (sessionId, turnId) => {
      const submission = createCancelTurnSubmission(uuidSource);
      return mutationOperation(() => cancelTurn(sessionId, turnId, submission));
    },
    getSnapshot: async (sessionId) =>
      (
        await get(
          `/api/sessions/${sessionPath(sessionId)}/snapshot`,
          SessionSnapshotHttpResponseSchema,
        )
      ).snapshot,
    getEvents: (input) => {
      const request = EventListAfterPayloadSchema.parse(input);
      const query = new URLSearchParams({
        afterSeq: String(request.afterSeq),
        limit: String(request.limit),
      });
      return get(
        `/api/sessions/${sessionPath(request.sessionId)}/events?${query.toString()}`,
        createSessionEventsHttpResponseSchema(request),
      );
    },
  };
};
