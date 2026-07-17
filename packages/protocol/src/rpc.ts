import { z } from 'zod';

import { RendererSessionEventEnvelopeSchema } from './events.js';
import { SessionRuntimeStatusSchema, SessionSnapshotSchema } from './runtime.js';

const NonEmptyStringSchema = z.string().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const ProtocolVersionSchema = z.literal(1);

export const RpcMethodSchema = z.enum([
  'auth.respond',
  'app.health',
  'workspace.register',
  'session.create',
  'session.list',
  'session.getSnapshot',
  'turn.enqueue',
  'turn.cancel',
  'event.listAfter',
]);

export const AuthRespondPayloadSchema = z
  .object({
    nonce: NonEmptyStringSchema,
    mac: NonEmptyStringSchema,
  })
  .strict();
export const AppHealthPayloadSchema = z.object({}).strict();
export const WorkspaceRegisterPayloadSchema = z
  .object({ path: NonEmptyStringSchema })
  .strict();
export const SessionCreatePayloadSchema = z
  .object({
    workspaceId: NonEmptyStringSchema,
    title: z.string().min(1),
    prompt: z.string().min(1),
  })
  .strict();
export const SessionGetSnapshotPayloadSchema = z
  .object({ sessionId: NonEmptyStringSchema })
  .strict();
export const SessionListPayloadSchema = z.object({}).strict();
export const TurnEnqueuePayloadSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    prompt: z.string().min(1),
  })
  .strict();
export const TurnCancelPayloadSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
  })
  .strict();
export const EventListAfterPayloadSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    afterSeq: NonNegativeIntegerSchema,
    limit: z.number().int().positive(),
  })
  .strict();

export const AuthRespondResultSchema = z.object({ authenticated: z.literal(true) }).strict();
export const AppHealthResultSchema = z
  .object({
    status: z.literal('ready'),
    protocolVersion: ProtocolVersionSchema,
    pid: z.number().int().positive(),
  })
  .strict();
export const WorkspaceRegisterResultSchema = z
  .object({ workspaceId: NonEmptyStringSchema })
  .strict();
export const SessionCreateResultSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
  })
  .strict();
export const SessionGetSnapshotResultSchema = SessionSnapshotSchema;
export const SessionSummarySchema = z
  .object({
    id: NonEmptyStringSchema,
    title: z.string(),
    runtimeStatus: SessionRuntimeStatusSchema,
    currentTurnId: NonEmptyStringSchema.nullable(),
    queuedTurnCount: NonNegativeIntegerSchema,
    updatedAt: NonEmptyStringSchema,
  })
  .strict();
export const SessionListResultSchema = z
  .object({ sessions: z.array(SessionSummarySchema) })
  .strict()
  .superRefine((result, context) => {
    result.sessions.forEach((session, index) => {
      const previous = result.sessions[index - 1];
      if (
        previous &&
        (previous.updatedAt < session.updatedAt ||
          (previous.updatedAt === session.updatedAt && previous.id < session.id))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Sessions must be ordered by updatedAt and id descending',
          path: ['sessions', index],
        });
      }
    });
  });
export const TurnEnqueueResultSchema = z.object({ turnId: NonEmptyStringSchema }).strict();
export const TurnCancelResultSchema = z
  .object({
    turnId: NonEmptyStringSchema,
    status: z.literal('canceled'),
  })
  .strict();
export const EventListAfterResultSchema = z
  .object({
    events: z.array(RendererSessionEventEnvelopeSchema),
    highWaterSeq: NonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((result, context) => {
    result.events.forEach((event, index) => {
      if (event.seq > result.highWaterSeq) {
        context.addIssue({
          code: 'custom',
          message: 'Event seq cannot exceed highWaterSeq',
          path: ['events', index, 'seq'],
        });
      }

      const firstEvent = result.events[0];
      if (firstEvent && event.sessionId !== firstEvent.sessionId) {
        context.addIssue({
          code: 'custom',
          message: 'All events must belong to one session',
          path: ['events', index, 'sessionId'],
        });
      }

      const previousEvent = result.events[index - 1];
      if (previousEvent && event.seq !== previousEvent.seq + 1) {
        context.addIssue({
          code: 'custom',
          message: 'Events must be ascending and consecutive',
          path: ['events', index, 'seq'],
        });
      }
    });
  });

export const createEventListAfterResultSchema = (
  request: z.infer<typeof EventListAfterPayloadSchema>,
) => {
  const validatedRequest = EventListAfterPayloadSchema.parse(request);

  return EventListAfterResultSchema.superRefine((result, context) => {
    if (result.highWaterSeq < validatedRequest.afterSeq) {
      context.addIssue({
        code: 'custom',
        message: 'highWaterSeq cannot precede the request cursor',
        path: ['highWaterSeq'],
      });
    }

    const availableCount = Math.max(0, result.highWaterSeq - validatedRequest.afterSeq);
    const expectedCount = Math.min(validatedRequest.limit, availableCount);
    if (result.events.length !== expectedCount) {
      context.addIssue({
        code: 'custom',
        message: 'Event count must match the request cursor, limit, and high-water mark',
        path: ['events'],
      });
    }

    result.events.forEach((event, index) => {
      if (event.sessionId !== validatedRequest.sessionId) {
        context.addIssue({
          code: 'custom',
          message: 'Event belongs to a different session than the request',
          path: ['events', index, 'sessionId'],
        });
      }

      if (event.seq !== validatedRequest.afterSeq + index + 1) {
        context.addIssue({
          code: 'custom',
          message: 'Event seq must continue exactly after the request cursor',
          path: ['events', index, 'seq'],
        });
      }
    });
  });
};

const RequestBaseShape = {
  kind: z.literal('request'),
  protocolVersion: ProtocolVersionSchema,
  requestId: NonEmptyStringSchema,
  traceId: NonEmptyStringSchema,
};
const UnscopedRequestBaseShape = {
  ...RequestBaseShape,
  sessionId: z.null(),
  turnId: z.null(),
};
const SessionScopedRequestBaseShape = {
  ...RequestBaseShape,
  sessionId: NonEmptyStringSchema,
  turnId: z.null(),
};

export const RpcRequestEnvelopeSchema = z
  .object({
    ...RequestBaseShape,
    sessionId: NonEmptyStringSchema.nullable(),
    turnId: NonEmptyStringSchema.nullable(),
    method: RpcMethodSchema,
    payload: z.unknown(),
    clientRequestId: z.string().nullable(),
  })
  .strict();

export const AuthRespondRequestSchema = z
  .object({
    ...UnscopedRequestBaseShape,
    method: z.literal('auth.respond'),
    payload: AuthRespondPayloadSchema,
    clientRequestId: z.null(),
  })
  .strict();
export const AppHealthRequestSchema = z
  .object({
    ...UnscopedRequestBaseShape,
    method: z.literal('app.health'),
    payload: AppHealthPayloadSchema,
    clientRequestId: z.null(),
  })
  .strict();
export const WorkspaceRegisterRequestSchema = z
  .object({
    ...UnscopedRequestBaseShape,
    method: z.literal('workspace.register'),
    payload: WorkspaceRegisterPayloadSchema,
    clientRequestId: NonEmptyStringSchema,
  })
  .strict();
export const SessionCreateRequestSchema = z
  .object({
    ...UnscopedRequestBaseShape,
    method: z.literal('session.create'),
    payload: SessionCreatePayloadSchema,
    clientRequestId: NonEmptyStringSchema,
  })
  .strict();
export const SessionGetSnapshotRequestSchema = z
  .object({
    ...SessionScopedRequestBaseShape,
    method: z.literal('session.getSnapshot'),
    payload: SessionGetSnapshotPayloadSchema,
    clientRequestId: z.null(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.sessionId !== request.payload.sessionId) {
      context.addIssue({
        code: 'custom',
        message: 'Top-level sessionId must match payload.sessionId',
        path: ['sessionId'],
      });
    }
  });
export const SessionListRequestSchema = z
  .object({
    ...UnscopedRequestBaseShape,
    method: z.literal('session.list'),
    payload: SessionListPayloadSchema,
    clientRequestId: z.null(),
  })
  .strict();
export const TurnEnqueueRequestSchema = z
  .object({
    ...SessionScopedRequestBaseShape,
    method: z.literal('turn.enqueue'),
    payload: TurnEnqueuePayloadSchema,
    clientRequestId: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.sessionId !== request.payload.sessionId) {
      context.addIssue({
        code: 'custom',
        message: 'Top-level sessionId must match payload.sessionId',
        path: ['sessionId'],
      });
    }
  });
export const TurnCancelRequestSchema = z
  .object({
    ...SessionScopedRequestBaseShape,
    method: z.literal('turn.cancel'),
    payload: TurnCancelPayloadSchema,
    clientRequestId: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.sessionId !== request.payload.sessionId) {
      context.addIssue({
        code: 'custom',
        message: 'Top-level sessionId must match payload.sessionId',
        path: ['sessionId'],
      });
    }
  });
export const EventListAfterRequestSchema = z
  .object({
    ...SessionScopedRequestBaseShape,
    method: z.literal('event.listAfter'),
    payload: EventListAfterPayloadSchema,
    clientRequestId: z.null(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.sessionId !== request.payload.sessionId) {
      context.addIssue({
        code: 'custom',
        message: 'Top-level sessionId must match payload.sessionId',
        path: ['sessionId'],
      });
    }
  });

export const RpcRequestSchema = z.discriminatedUnion('method', [
  AuthRespondRequestSchema,
  AppHealthRequestSchema,
  WorkspaceRegisterRequestSchema,
  SessionCreateRequestSchema,
  SessionListRequestSchema,
  SessionGetSnapshotRequestSchema,
  TurnEnqueueRequestSchema,
  TurnCancelRequestSchema,
  EventListAfterRequestSchema,
]);

export const ErrorCategorySchema = z.enum([
  'validation',
  'configuration',
  'model',
  'tool',
  'connector',
  'runtime',
  'storage',
  'canceled',
  'interrupted',
  'internal',
]);
export const ErrorEnvelopeSchema = z
  .object({
    code: NonEmptyStringSchema,
    category: ErrorCategorySchema,
    message: NonEmptyStringSchema,
    retryable: z.boolean(),
    userAction: NonEmptyStringSchema.nullable(),
    detailsRef: NonEmptyStringSchema.nullable(),
    traceId: NonEmptyStringSchema,
  })
  .strict();

const ResponseBaseShape = {
  kind: z.literal('response'),
  protocolVersion: ProtocolVersionSchema,
  requestId: NonEmptyStringSchema,
  traceId: NonEmptyStringSchema,
};

export const RpcSuccessResponseSchema = z
  .object({
    ...ResponseBaseShape,
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();
export const RpcErrorResponseSchema = z
  .object({
    ...ResponseBaseShape,
    ok: z.literal(false),
    error: ErrorEnvelopeSchema,
  })
  .strict();
export const RpcResponseSchema = z.discriminatedUnion('ok', [
  RpcSuccessResponseSchema,
  RpcErrorResponseSchema,
]);

export const AuthChallengePayloadSchema = z
  .object({ nonce: NonEmptyStringSchema })
  .strict();
export const ResyncRequiredPayloadSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    highWaterSeq: NonNegativeIntegerSchema,
  })
  .strict();

const NotificationBaseShape = {
  kind: z.literal('notification'),
  protocolVersion: ProtocolVersionSchema,
  traceId: NonEmptyStringSchema,
};

export const AuthChallengeNotificationSchema = z
  .object({
    ...NotificationBaseShape,
    method: z.literal('auth.challenge'),
    payload: AuthChallengePayloadSchema,
  })
  .strict();
export const EventNotificationSchema = z
  .object({
    ...NotificationBaseShape,
    method: z.literal('event'),
    payload: RendererSessionEventEnvelopeSchema,
  })
  .strict();
export const ResyncRequiredNotificationSchema = z
  .object({
    ...NotificationBaseShape,
    method: z.literal('resync_required'),
    payload: ResyncRequiredPayloadSchema,
  })
  .strict();
export const RpcNotificationMethodSchema = z.enum([
  'auth.challenge',
  'event',
  'resync_required',
]);
export const RpcNotificationSchema = z
  .object({
    ...NotificationBaseShape,
    method: RpcNotificationMethodSchema,
    payload: z.unknown(),
  })
  .strict();

export const RpcCancelSchema = z
  .object({
    kind: z.literal('cancel'),
    protocolVersion: ProtocolVersionSchema,
    traceId: NonEmptyStringSchema,
    targetRequestId: NonEmptyStringSchema,
  })
  .strict();

export const RpcHeartbeatSchema = z
  .object({
    kind: z.literal('heartbeat'),
    protocolVersion: ProtocolVersionSchema,
    traceId: NonEmptyStringSchema,
    daemonEpoch: NonEmptyStringSchema,
    leaseEpoch: NonNegativeIntegerSchema,
  })
  .strict();

export const RpcEnvelopeSchema = z.union([
  RpcRequestEnvelopeSchema,
  RpcResponseSchema,
  RpcNotificationSchema,
  RpcCancelSchema,
  RpcHeartbeatSchema,
]);

export type RpcMethod = z.infer<typeof RpcMethodSchema>;
export type AuthRespondPayload = z.infer<typeof AuthRespondPayloadSchema>;
export type AppHealthPayload = z.infer<typeof AppHealthPayloadSchema>;
export type WorkspaceRegisterPayload = z.infer<typeof WorkspaceRegisterPayloadSchema>;
export type SessionCreatePayload = z.infer<typeof SessionCreatePayloadSchema>;
export type SessionListPayload = z.infer<typeof SessionListPayloadSchema>;
export type SessionGetSnapshotPayload = z.infer<typeof SessionGetSnapshotPayloadSchema>;
export type TurnEnqueuePayload = z.infer<typeof TurnEnqueuePayloadSchema>;
export type TurnCancelPayload = z.infer<typeof TurnCancelPayloadSchema>;
export type EventListAfterPayload = z.infer<typeof EventListAfterPayloadSchema>;
export type AuthRespondResult = z.infer<typeof AuthRespondResultSchema>;
export type AppHealthResult = z.infer<typeof AppHealthResultSchema>;
export type WorkspaceRegisterResult = z.infer<typeof WorkspaceRegisterResultSchema>;
export type SessionCreateResult = z.infer<typeof SessionCreateResultSchema>;
export type SessionListResult = z.infer<typeof SessionListResultSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionGetSnapshotResult = z.infer<typeof SessionGetSnapshotResultSchema>;
export type TurnEnqueueResult = z.infer<typeof TurnEnqueueResultSchema>;
export type TurnCancelResult = z.infer<typeof TurnCancelResultSchema>;
export type EventListAfterResult = z.infer<typeof EventListAfterResultSchema>;
export type RpcRequestEnvelope = z.infer<typeof RpcRequestEnvelopeSchema>;
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type RpcSuccessResponse = z.infer<typeof RpcSuccessResponseSchema>;
export type RpcErrorResponse = z.infer<typeof RpcErrorResponseSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
export type AuthChallengePayload = z.infer<typeof AuthChallengePayloadSchema>;
export type ResyncRequiredPayload = z.infer<typeof ResyncRequiredPayloadSchema>;
export type RpcNotificationMethod = z.infer<typeof RpcNotificationMethodSchema>;
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;
export type RpcCancel = z.infer<typeof RpcCancelSchema>;
export type RpcHeartbeat = z.infer<typeof RpcHeartbeatSchema>;
export type RpcEnvelope = z.infer<typeof RpcEnvelopeSchema>;
