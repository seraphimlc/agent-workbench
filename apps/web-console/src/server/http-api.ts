import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  AppHealthResultSchema,
  ErrorEnvelopeSchema,
  EventListAfterPayloadSchema,
  SessionCreateResultSchema,
  SessionGetSnapshotResultSchema,
  TurnEnqueueResultSchema,
  WorkspaceRegisterResultSchema,
} from '@agent-workbench/protocol';
import { z } from 'zod';

import {
  PublicErrorResponseSchema,
  RuntimePublicInfoSchema,
  createSessionEventsHttpResponseSchema,
  SessionCreatedHttpResponseSchema,
  SessionSnapshotHttpResponseSchema,
  SessionSubmissionSchema,
  TurnSubmissionSchema,
  TurnSubmittedHttpResponseSchema,
} from '../shared/contracts.js';
import {
  createHttpSecurityHeaders,
  type RuntimeSecurity,
  validateBrowserRequest,
} from './http-security.js';

export type HttpApiRpcCall = {
  readonly method: string;
  readonly payload: unknown;
  readonly sessionId?: string;
  readonly clientRequestId?: string;
};

export type HttpApiRpcReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: unknown };

export interface HttpApiRpc {
  call(input: HttpApiRpcCall): Promise<HttpApiRpcReply>;
}

export class HttpApiRpcUnavailableError extends Error {
  constructor() {
    super('Runtime RPC is unavailable');
    this.name = 'HttpApiRpcUnavailableError';
  }
}

export type HttpApiHandlerOptions = {
  readonly rpc: HttpApiRpc;
  readonly runtimeSecurity: RuntimeSecurity;
  readonly provider: {
    readonly baseHost: string;
    readonly modelId: string;
  };
  readonly workspace: {
    readonly name: string;
    readonly path: string;
  };
};

const SessionPathSchema = z
  .object({
    sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  })
  .strict();
const EventQuerySchema = z
  .object({
    afterSeq: z.string().regex(/^\d+$/).transform(Number),
    limit: z.string().regex(/^[1-9]\d*$/).transform(Number),
  })
  .strict();
const EmptyQuerySchema = z.object({}).strict();

const headerValue = (
  value: string | readonly string[] | undefined,
): string | undefined => {
  if (typeof value === 'string' || value === undefined) return value;
  return value[0];
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  response.writeHead(statusCode, {
    ...createHttpSecurityHeaders('api'),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
};

const sendPublicError = (
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void => {
  sendJson(
    response,
    statusCode,
    PublicErrorResponseSchema.parse({
      error: {
        code,
        message,
        retryable: false,
        userAction: null,
      },
    }),
  );
};

class RpcPublicError extends Error {
  constructor(
    readonly statusCode: number,
    readonly response: ReturnType<typeof PublicErrorResponseSchema.parse>,
  ) {
    super(response.error.message);
    this.name = 'RpcPublicError';
  }
}

type LocalRpcError = {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
};

const knownRpcError = (
  error: ReturnType<typeof ErrorEnvelopeSchema.parse>,
): LocalRpcError | null => {
  switch (error.code) {
    case 'SESSION_NOT_FOUND':
      return {
        statusCode: 404,
        code: 'SESSION_NOT_FOUND',
        message: 'Session was not found',
        retryable: false,
      };
    case 'WORKSPACE_NOT_FOUND':
      return {
        statusCode: 404,
        code: 'WORKSPACE_NOT_FOUND',
        message: 'Workspace was not found',
        retryable: false,
      };
    case 'WORKSPACE_PATH_INVALID':
      return {
        statusCode: 400,
        code: 'INVALID_REQUEST',
        message: 'Request was rejected',
        retryable: false,
      };
    case 'EVENT_CURSOR_AHEAD':
      return {
        statusCode: 409,
        code: 'EVENT_CURSOR_INVALID',
        message: 'Event cursor is invalid',
        retryable: false,
      };
    case 'IDEMPOTENCY_CONFLICT':
      return {
        statusCode: 409,
        code: 'REQUEST_CONFLICT',
        message: 'Request conflicts with an earlier submission',
        retryable: false,
      };
    default:
      return null;
  }
};

const mapRpcError = (
  error: ReturnType<typeof ErrorEnvelopeSchema.parse>,
): LocalRpcError => {
  const known = knownRpcError(error);
  if (known !== null) return known;

  switch (error.category) {
    case 'validation':
      return {
        statusCode: 400,
        code: 'INVALID_REQUEST',
        message: 'Request was rejected',
        retryable: false,
      };
    case 'configuration':
    case 'model':
    case 'tool':
    case 'connector':
    case 'runtime':
    case 'storage':
      return {
        statusCode: 503,
        code: 'RUNTIME_UNAVAILABLE',
        message: 'Runtime is unavailable',
        retryable: true,
      };
    case 'canceled':
      return {
        statusCode: 409,
        code: 'REQUEST_CANCELED',
        message: 'Request was canceled',
        retryable: false,
      };
    case 'interrupted':
      return {
        statusCode: 503,
        code: 'REQUEST_INTERRUPTED',
        message: 'Request was interrupted',
        retryable: true,
      };
    case 'internal':
      return {
        statusCode: 500,
        code: 'INTERNAL',
        message: 'Request failed',
        retryable: false,
      };
  }
};

const callRpc = async (
  rpc: HttpApiRpc,
  input: HttpApiRpcCall,
): Promise<unknown> => {
  const reply = await rpc.call(input);
  if (reply.ok) return reply.result;

  const error = ErrorEnvelopeSchema.parse(reply.error);
  const local = mapRpcError(error);
  throw new RpcPublicError(
    local.statusCode,
    PublicErrorResponseSchema.parse({
      error: {
        code: local.code,
        message: local.message,
        retryable: local.retryable,
        userAction: null,
      },
    }),
  );
};

const sendRpcFailure = (response: ServerResponse, error: unknown): void => {
  if (error instanceof RpcPublicError) {
    sendJson(response, error.statusCode, error.response);
    return;
  }
  if (error instanceof HttpApiRpcUnavailableError) {
    sendJson(
      response,
      503,
      PublicErrorResponseSchema.parse({
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'Runtime is unavailable',
          retryable: true,
          userAction: null,
        },
      }),
    );
    return;
  }
  sendPublicError(
    response,
    502,
    'RPC_PROTOCOL_ERROR',
    'Runtime returned an invalid response',
  );
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const matchSessionPath = (
  pathname: string,
  suffix: 'turns' | 'snapshot' | 'events',
): { readonly sessionId: string } | null => {
  const match = new RegExp(`^/api/sessions/([^/]+)/${suffix}$`).exec(pathname);
  if (!match?.[1]) return null;
  try {
    return SessionPathSchema.parse({ sessionId: decodeURIComponent(match[1]) });
  } catch {
    return null;
  }
};

const parseEventQuery = (
  url: URL,
  sessionId: string,
): ReturnType<typeof EventListAfterPayloadSchema.parse> => {
  const parsed = parseExactQuery(url.searchParams, EventQuerySchema);
  return EventListAfterPayloadSchema.parse({ sessionId, ...parsed });
};

const parseExactQuery = <Output>(
  searchParams: URLSearchParams,
  schema: z.ZodType<Output>,
): Output => {
  const query: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (Object.hasOwn(query, key)) {
      throw new Error('Duplicate query parameter');
    }
    query[key] = value;
  }
  return schema.parse(query);
};

const hasInvalidEmptyQuery = (url: URL): boolean => {
  try {
    parseExactQuery(url.searchParams, EmptyQuerySchema);
    return false;
  } catch {
    return true;
  }
};

const unavailableRuntime = (options: HttpApiHandlerOptions) =>
  RuntimePublicInfoSchema.parse({
    daemon: { status: 'unavailable', protocolVersion: null, pid: null },
    provider: options.provider,
    workspace: { name: options.workspace.name },
  });

const readRuntimeHealth = async (options: HttpApiHandlerOptions) =>
  AppHealthResultSchema.parse(
    await callRpc(options.rpc, { method: 'app.health', payload: {} }),
  );

export const createHttpApiHandler = (
  options: HttpApiHandlerOptions,
): ((request: IncomingMessage, response: ServerResponse) => Promise<void>) => {
  let workspaceId: string | undefined;

  return async (request, response) => {
    const security = validateBrowserRequest(
      {
        method: request.method ?? '',
        host: headerValue(request.headers.host),
        origin: headerValue(request.headers.origin),
        contentType: headerValue(request.headers['content-type']),
        csrfToken: headerValue(request.headers['x-agent-workbench-csrf']),
      },
      options.runtimeSecurity,
    );
    if (!security.allowed) {
      sendPublicError(
        response,
        security.statusCode,
        security.code,
        'Browser request was rejected',
      );
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/runtime') {
      if (hasInvalidEmptyQuery(url)) {
        sendPublicError(
          response,
          400,
          'WEB_REQUEST_INVALID',
          'Request query is invalid',
        );
        return;
      }
      try {
        const health = await readRuntimeHealth(options);
        sendJson(
          response,
          200,
          RuntimePublicInfoSchema.parse({
            daemon: health,
            provider: options.provider,
            workspace: { name: options.workspace.name },
          }),
        );
      } catch {
        sendJson(response, 200, unavailableRuntime(options));
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      if (hasInvalidEmptyQuery(url)) {
        sendPublicError(
          response,
          400,
          'WEB_REQUEST_INVALID',
          'Request query is invalid',
        );
        return;
      }
      let submission;
      try {
        submission = SessionSubmissionSchema.parse(await readJsonBody(request));
      } catch {
        sendPublicError(
          response,
          400,
          'WEB_REQUEST_INVALID',
          'Request body is invalid',
        );
        return;
      }

      const clientRequestId = `web:session:${submission.submissionId}`;
      try {
        if (workspaceId === undefined) {
          const registered = WorkspaceRegisterResultSchema.parse(
            await callRpc(options.rpc, {
              method: 'workspace.register',
              payload: { path: options.workspace.path },
              clientRequestId,
            }),
          );
          workspaceId = registered.workspaceId;
        }
        const created = SessionCreateResultSchema.parse(
          await callRpc(options.rpc, {
            method: 'session.create',
            payload: {
              workspaceId,
              title: submission.prompt,
              prompt: submission.prompt,
            },
            clientRequestId,
          }),
        );
        sendJson(
          response,
          201,
          SessionCreatedHttpResponseSchema.parse(created),
        );
      } catch (error) {
        sendRpcFailure(response, error);
      }
      return;
    }

    const turnPath = matchSessionPath(url.pathname, 'turns');
    if (request.method === 'POST' && turnPath !== null) {
      if (hasInvalidEmptyQuery(url)) {
        sendPublicError(
          response,
          400,
          'WEB_REQUEST_INVALID',
          'Request query is invalid',
        );
        return;
      }
      let submission;
      try {
        submission = TurnSubmissionSchema.parse(await readJsonBody(request));
      } catch {
        sendPublicError(
          response,
          400,
          'WEB_REQUEST_INVALID',
          'Request body is invalid',
        );
        return;
      }

      try {
        const submitted = TurnEnqueueResultSchema.parse(
          await callRpc(options.rpc, {
            method: 'turn.enqueue',
            payload: {
              sessionId: turnPath.sessionId,
              prompt: submission.prompt,
            },
            sessionId: turnPath.sessionId,
            clientRequestId: `web:turn:${submission.submissionId}`,
          }),
        );
        sendJson(
          response,
          202,
          TurnSubmittedHttpResponseSchema.parse(submitted),
        );
      } catch (error) {
        sendRpcFailure(response, error);
      }
      return;
    }

    const snapshotPath = matchSessionPath(url.pathname, 'snapshot');
    if (request.method === 'GET' && snapshotPath !== null) {
      if (hasInvalidEmptyQuery(url)) {
        sendPublicError(
          response,
          400,
          'WEB_REQUEST_INVALID',
          'Request query is invalid',
        );
        return;
      }
      try {
        const snapshot = SessionGetSnapshotResultSchema.parse(
          await callRpc(options.rpc, {
            method: 'session.getSnapshot',
            payload: { sessionId: snapshotPath.sessionId },
            sessionId: snapshotPath.sessionId,
          }),
        );
        sendJson(
          response,
          200,
          SessionSnapshotHttpResponseSchema.parse({ snapshot }),
        );
      } catch (error) {
        sendRpcFailure(response, error);
      }
      return;
    }

    const eventsPath = matchSessionPath(url.pathname, 'events');
    if (request.method === 'GET' && eventsPath !== null) {
      let eventRequest;
      try {
        eventRequest = parseEventQuery(url, eventsPath.sessionId);
      } catch {
        sendPublicError(
          response,
          400,
          'WEB_REQUEST_INVALID',
          'Request query is invalid',
        );
        return;
      }

      try {
        const events = createSessionEventsHttpResponseSchema(eventRequest).parse(
          await callRpc(options.rpc, {
            method: 'event.listAfter',
            payload: eventRequest,
            sessionId: eventsPath.sessionId,
          }),
        );
        sendJson(response, 200, events);
      } catch (error) {
        sendRpcFailure(response, error);
      }
      return;
    }

    const allowedMethod =
      url.pathname === '/api/runtime'
        ? 'GET'
        : url.pathname === '/api/sessions' || turnPath !== null
          ? 'POST'
          : snapshotPath !== null || eventsPath !== null
            ? 'GET'
            : null;
    if (allowedMethod !== null) {
      response.setHeader('allow', allowedMethod);
      sendPublicError(
        response,
        405,
        'WEB_METHOD_NOT_ALLOWED',
        'HTTP method is not allowed for this API route',
      );
      return;
    }

    sendPublicError(
      response,
      404,
      'WEB_ROUTE_NOT_FOUND',
      'API route was not found',
    );
  };
};
