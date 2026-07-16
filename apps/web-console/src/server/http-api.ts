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

const rpcErrorStatus = (
  error: ReturnType<typeof ErrorEnvelopeSchema.parse>,
): number => {
  if (error.code === 'SESSION_NOT_FOUND') return 404;
  if (error.category === 'validation') return 400;
  if (error.retryable) return 503;
  return 500;
};

const callRpc = async (
  rpc: HttpApiRpc,
  input: HttpApiRpcCall,
): Promise<unknown> => {
  const reply = await rpc.call(input);
  if (reply.ok) return reply.result;

  const error = ErrorEnvelopeSchema.parse(reply.error);
  throw new RpcPublicError(
    rpcErrorStatus(error),
    PublicErrorResponseSchema.parse({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        userAction: error.userAction,
      },
    }),
  );
};

const sendRpcFailure = (response: ServerResponse, error: unknown): void => {
  if (error instanceof RpcPublicError) {
    sendJson(response, error.statusCode, error.response);
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
  const query = Object.fromEntries(url.searchParams.entries());
  if ([...url.searchParams.keys()].length !== Object.keys(query).length) {
    throw new Error('Duplicate event query parameter');
  }
  const parsed = EventQuerySchema.parse(query);
  return EventListAfterPayloadSchema.parse({ sessionId, ...parsed });
};

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
      try {
        const health = AppHealthResultSchema.parse(
          await callRpc(options.rpc, { method: 'app.health', payload: {} }),
        );
        sendJson(
          response,
          200,
          RuntimePublicInfoSchema.parse({
            daemon: health,
            provider: options.provider,
            workspace: { name: options.workspace.name },
          }),
        );
      } catch (error) {
        sendRpcFailure(response, error);
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
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
