import {
  EventListAfterPayloadSchema,
  type EventListAfterPayload,
  type SessionSnapshot,
} from '@agent-workbench/protocol';
import type { ZodType } from 'zod';

import {
  PublicErrorResponseSchema,
  RuntimePublicInfoSchema,
  SessionCreatedHttpResponseSchema,
  SessionSnapshotHttpResponseSchema,
  SessionSubmissionSchema,
  TurnSubmissionSchema,
  TurnSubmittedHttpResponseSchema,
  createSessionEventsHttpResponseSchema,
  type PublicError,
  type RuntimePublicInfo,
  type SessionCreatedHttpResponse,
  type SessionEventsHttpResponse,
  type SessionSubmission,
  type TurnSubmittedHttpResponse,
  type TurnSubmission,
} from '../shared/contracts.js';

const CSRF_META_NAME = 'agent-workbench-csrf';
const CSRF_HEADER_NAME = 'x-agent-workbench-csrf';

type Fetch = typeof globalThis.fetch;

type ClientDependencies = {
  readonly document?: Document;
  readonly fetch?: Fetch;
};

type RandomUuidSource = {
  randomUUID(): string;
};

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

export type ApiClient = {
  getRuntime(): Promise<RuntimePublicInfo>;
  createSession(submission: SessionSubmission): Promise<SessionCreatedHttpResponse>;
  submitTurn(
    sessionId: string,
    submission: TurnSubmission,
  ): Promise<TurnSubmittedHttpResponse>;
  getSnapshot(sessionId: string): Promise<SessionSnapshot>;
  getEvents(request: EventListAfterPayload): Promise<SessionEventsHttpResponse>;
};

export const createApiClient = (
  dependencies: ClientDependencies = {},
): ApiClient => {
  const csrfToken = readCsrfToken(dependencies.document ?? document);
  const fetch = dependencies.fetch ?? globalThis.fetch;
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
    body: SessionSubmission | TurnSubmission,
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

  return {
    getRuntime: () => get('/api/runtime', RuntimePublicInfoSchema),
    createSession: (submission) =>
      post(
        '/api/sessions',
        SessionSubmissionSchema.parse(submission),
        SessionCreatedHttpResponseSchema,
      ),
    submitTurn: (sessionId, submission) =>
      post(
        `/api/sessions/${sessionPath(sessionId)}/turns`,
        TurnSubmissionSchema.parse(submission),
        TurnSubmittedHttpResponseSchema,
      ),
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
