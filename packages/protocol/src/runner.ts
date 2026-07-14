import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive();
const ProtocolVersionSchema = z.literal(1);

export const RunnerBindingSchema = z
  .object({
    runnerInstanceId: NonEmptyStringSchema,
    capability: NonEmptyStringSchema,
    daemonEpoch: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
    leaseId: NonEmptyStringSchema,
    leaseEpoch: PositiveIntegerSchema,
    executionFence: PositiveIntegerSchema,
  })
  .strict();

export const RunnerMethodSchema = z.enum([
  'runner.ready',
  'runner.heartbeat',
  'turn.context.get',
  'model.call',
  'tool.execute',
  'turn.complete',
]);

export const RunnerSystemModelMessageSchema = z
  .object({
    role: z.literal('system'),
    content: z.string(),
  })
  .strict();

export const RunnerUserModelMessageSchema = z
  .object({
    role: z.literal('user'),
    content: z.string(),
  })
  .strict();

export const RunnerModelToolCallSchema = z
  .object({
    logicalCallId: NonEmptyStringSchema,
    toolId: NonEmptyStringSchema,
    argumentsJson: NonEmptyStringSchema,
  })
  .strict();

export const RunnerAssistantModelMessageSchema = z
  .object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    toolCalls: z.array(RunnerModelToolCallSchema),
  })
  .strict();

export const RunnerToolModelMessageSchema = z
  .object({
    role: z.literal('tool'),
    logicalCallId: NonEmptyStringSchema,
    content: z.string(),
  })
  .strict();

export const RunnerModelMessageSchema = z.discriminatedUnion('role', [
  RunnerSystemModelMessageSchema,
  RunnerUserModelMessageSchema,
  RunnerAssistantModelMessageSchema,
  RunnerToolModelMessageSchema,
]);

export const RunnerReadyPayloadSchema = z.object({}).strict();
export const RunnerHeartbeatPayloadSchema = z.object({}).strict();
export const TurnContextGetPayloadSchema = z.object({}).strict();
export const ModelCallPayloadSchema = z
  .object({
    messages: z.array(RunnerModelMessageSchema).min(1),
  })
  .strict();
export const ToolExecutePayloadSchema = z
  .object({
    modelAttemptId: NonEmptyStringSchema,
    logicalCallId: NonEmptyStringSchema,
  })
  .strict();
export const TurnCompletePayloadSchema = z
  .object({ modelAttemptId: NonEmptyStringSchema })
  .strict();

const RunnerRequestBaseShape = {
  kind: z.literal('request'),
  protocolVersion: ProtocolVersionSchema,
  requestId: NonEmptyStringSchema,
  traceId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  turnId: NonEmptyStringSchema,
  binding: RunnerBindingSchema,
};

export const RunnerRequestEnvelopeSchema = z
  .object({
    ...RunnerRequestBaseShape,
    method: RunnerMethodSchema,
    payload: z.unknown(),
  })
  .strict();

export const RunnerReadyRequestSchema = z
  .object({
    ...RunnerRequestBaseShape,
    method: z.literal('runner.ready'),
    payload: RunnerReadyPayloadSchema,
  })
  .strict();

export const RunnerHeartbeatRequestSchema = z
  .object({
    ...RunnerRequestBaseShape,
    method: z.literal('runner.heartbeat'),
    payload: RunnerHeartbeatPayloadSchema,
  })
  .strict();

export const TurnContextGetRequestSchema = z
  .object({
    ...RunnerRequestBaseShape,
    method: z.literal('turn.context.get'),
    payload: TurnContextGetPayloadSchema,
  })
  .strict();

export const ModelCallRequestSchema = z
  .object({
    ...RunnerRequestBaseShape,
    method: z.literal('model.call'),
    payload: ModelCallPayloadSchema,
  })
  .strict();

export const ToolExecuteRequestSchema = z
  .object({
    ...RunnerRequestBaseShape,
    method: z.literal('tool.execute'),
    payload: ToolExecutePayloadSchema,
  })
  .strict();

export const TurnCompleteRequestSchema = z
  .object({
    ...RunnerRequestBaseShape,
    method: z.literal('turn.complete'),
    payload: TurnCompletePayloadSchema,
  })
  .strict();

const addBindingScopeIssues = (
  value: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly binding: z.infer<typeof RunnerBindingSchema>;
  },
  context: z.RefinementCtx,
): void => {
  if (value.sessionId !== value.binding.sessionId) {
    context.addIssue({
      code: 'custom',
      message: 'Top-level sessionId must match the Runner Binding',
      path: ['sessionId'],
    });
  }
  if (value.turnId !== value.binding.turnId) {
    context.addIssue({
      code: 'custom',
      message: 'Top-level turnId must match the Runner Binding',
      path: ['turnId'],
    });
  }
};

export const RunnerRequestSchema = z
  .discriminatedUnion('method', [
    RunnerReadyRequestSchema,
    RunnerHeartbeatRequestSchema,
    TurnContextGetRequestSchema,
    ModelCallRequestSchema,
    ToolExecuteRequestSchema,
    TurnCompleteRequestSchema,
  ])
  .superRefine(addBindingScopeIssues);

export const RunnerBindNotificationSchema = z
  .object({
    kind: z.literal('notification'),
    protocolVersion: ProtocolVersionSchema,
    traceId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
    method: z.literal('runner.bind'),
    payload: RunnerBindingSchema,
  })
  .strict()
  .superRefine((notification, context) => {
    addBindingScopeIssues(
      {
        sessionId: notification.sessionId,
        turnId: notification.turnId,
        binding: notification.payload,
      },
      context,
    );
  });

/**
 * Checks protocol-level tuple equality only; it is not an authorization boundary.
 * Task 3 RunnerChannel must validate capability with timingSafeEqual first, then
 * apply this schema to the complete tuple.
 */
export const createRunnerRequestSchema = (expectedBinding: RunnerBinding) => {
  const binding = RunnerBindingSchema.parse(expectedBinding);
  return RunnerRequestSchema.superRefine((request, context) => {
    for (const key of [
      'runnerInstanceId',
      'capability',
      'daemonEpoch',
      'sessionId',
      'turnId',
      'leaseId',
      'leaseEpoch',
      'executionFence',
    ] as const) {
      if (request.binding[key] !== binding[key]) {
        context.addIssue({
          code: 'custom',
          message: `Runner Binding ${key} does not match the channel binding`,
          path: ['binding', key],
        });
      }
    }
  });
};

export const RunnerReadyResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const RunnerHeartbeatResultSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const TurnContextGetResultSchema = z
  .object({ messages: z.array(RunnerModelMessageSchema).min(1) })
  .strict();

export const ModelCallFinishReasonSchema = z.enum(['stop', 'tool_calls']);

export const ModelCallResultSchema = z
  .object({
    modelAttemptId: NonEmptyStringSchema,
    finishReason: ModelCallFinishReasonSchema,
    content: z.string().nullable(),
    toolCalls: z.array(RunnerModelToolCallSchema),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.finishReason === 'stop') {
      if (result.content === null || result.content.trim().length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'A stop result requires non-empty assistant content',
          path: ['content'],
        });
      }
      if (result.toolCalls.length !== 0) {
        context.addIssue({
          code: 'custom',
          message: 'A stop result cannot contain Tool Calls',
          path: ['toolCalls'],
        });
      }
      return;
    }
    if (result.toolCalls.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A tool_calls result requires at least one Tool Call',
        path: ['toolCalls'],
      });
    }
  });

export const ToolExecuteResultSchema = z
  .object({
    logicalCallId: NonEmptyStringSchema,
    content: z.string(),
  })
  .strict();

export const TurnCompleteResultSchema = z
  .object({
    terminalStatus: z.literal('succeeded'),
    resultMessageId: NonEmptyStringSchema,
  })
  .strict();

export const RunnerErrorSchema = z
  .object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    retryable: z.boolean(),
  })
  .strict();

const RunnerResponseBaseShape = {
  kind: z.literal('response'),
  protocolVersion: ProtocolVersionSchema,
  requestId: NonEmptyStringSchema,
  traceId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  turnId: NonEmptyStringSchema,
};

export const RunnerReadySuccessResponseSchema = z
  .object({
    ...RunnerResponseBaseShape,
    method: z.literal('runner.ready'),
    ok: z.literal(true),
    result: RunnerReadyResultSchema,
  })
  .strict();

export const RunnerHeartbeatSuccessResponseSchema = z
  .object({
    ...RunnerResponseBaseShape,
    method: z.literal('runner.heartbeat'),
    ok: z.literal(true),
    result: RunnerHeartbeatResultSchema,
  })
  .strict();

export const TurnContextGetSuccessResponseSchema = z
  .object({
    ...RunnerResponseBaseShape,
    method: z.literal('turn.context.get'),
    ok: z.literal(true),
    result: TurnContextGetResultSchema,
  })
  .strict();

export const ModelCallSuccessResponseSchema = z
  .object({
    ...RunnerResponseBaseShape,
    method: z.literal('model.call'),
    ok: z.literal(true),
    result: ModelCallResultSchema,
  })
  .strict();

export const ToolExecuteSuccessResponseSchema = z
  .object({
    ...RunnerResponseBaseShape,
    method: z.literal('tool.execute'),
    ok: z.literal(true),
    result: ToolExecuteResultSchema,
  })
  .strict();

export const TurnCompleteSuccessResponseSchema = z
  .object({
    ...RunnerResponseBaseShape,
    method: z.literal('turn.complete'),
    ok: z.literal(true),
    result: TurnCompleteResultSchema,
  })
  .strict();

export const RunnerSuccessResponseSchema = z.discriminatedUnion('method', [
  RunnerReadySuccessResponseSchema,
  RunnerHeartbeatSuccessResponseSchema,
  TurnContextGetSuccessResponseSchema,
  ModelCallSuccessResponseSchema,
  ToolExecuteSuccessResponseSchema,
  TurnCompleteSuccessResponseSchema,
]);

export const RunnerErrorResponseSchema = z
  .object({
    ...RunnerResponseBaseShape,
    method: RunnerMethodSchema,
    ok: z.literal(false),
    error: RunnerErrorSchema,
  })
  .strict();

export const RunnerResponseSchema = z.union([
  RunnerSuccessResponseSchema,
  RunnerErrorResponseSchema,
]);

export const RunnerResponseEnvelopeSchema = RunnerResponseSchema;

export const createRunnerResponseSchema = (expectedRequest: RunnerRequest) => {
  const request = RunnerRequestSchema.parse(expectedRequest);
  return RunnerResponseSchema.superRefine((response, context) => {
    for (const key of [
      'requestId',
      'traceId',
      'sessionId',
      'turnId',
      'method',
    ] as const) {
      if (response[key] !== request[key]) {
        context.addIssue({
          code: 'custom',
          message: `Runner response ${key} does not match the originating request`,
          path: [key],
        });
      }
    }
  });
};

export type RunnerBinding = z.infer<typeof RunnerBindingSchema>;
export type RunnerMethod = z.infer<typeof RunnerMethodSchema>;
export type RunnerModelToolCall = z.infer<typeof RunnerModelToolCallSchema>;
export type RunnerModelMessage = z.infer<typeof RunnerModelMessageSchema>;
export type RunnerReadyPayload = z.infer<typeof RunnerReadyPayloadSchema>;
export type RunnerHeartbeatPayload = z.infer<typeof RunnerHeartbeatPayloadSchema>;
export type TurnContextGetPayload = z.infer<typeof TurnContextGetPayloadSchema>;
export type ModelCallPayload = z.infer<typeof ModelCallPayloadSchema>;
export type ToolExecutePayload = z.infer<typeof ToolExecutePayloadSchema>;
export type TurnCompletePayload = z.infer<typeof TurnCompletePayloadSchema>;
export type RunnerRequestEnvelope = z.infer<typeof RunnerRequestEnvelopeSchema>;
export type RunnerRequest = z.infer<typeof RunnerRequestSchema>;
export type RunnerBindNotification = z.infer<typeof RunnerBindNotificationSchema>;
export type RunnerReadyResult = z.infer<typeof RunnerReadyResultSchema>;
export type RunnerHeartbeatResult = z.infer<typeof RunnerHeartbeatResultSchema>;
export type TurnContextGetResult = z.infer<typeof TurnContextGetResultSchema>;
export type ModelCallFinishReason = z.infer<typeof ModelCallFinishReasonSchema>;
export type ModelCallResult = z.infer<typeof ModelCallResultSchema>;
export type ToolExecuteResult = z.infer<typeof ToolExecuteResultSchema>;
export type TurnCompleteResult = z.infer<typeof TurnCompleteResultSchema>;
export type RunnerError = z.infer<typeof RunnerErrorSchema>;
export type RunnerResponseEnvelope = z.infer<typeof RunnerResponseEnvelopeSchema>;
export type RunnerReadySuccessResponse = z.infer<
  typeof RunnerReadySuccessResponseSchema
>;
export type RunnerHeartbeatSuccessResponse = z.infer<
  typeof RunnerHeartbeatSuccessResponseSchema
>;
export type TurnContextGetSuccessResponse = z.infer<
  typeof TurnContextGetSuccessResponseSchema
>;
export type ModelCallSuccessResponse = z.infer<
  typeof ModelCallSuccessResponseSchema
>;
export type ToolExecuteSuccessResponse = z.infer<
  typeof ToolExecuteSuccessResponseSchema
>;
export type TurnCompleteSuccessResponse = z.infer<
  typeof TurnCompleteSuccessResponseSchema
>;
export type RunnerSuccessResponse = z.infer<typeof RunnerSuccessResponseSchema>;
export type RunnerErrorResponse = z.infer<typeof RunnerErrorResponseSchema>;
export type RunnerResponse = z.infer<typeof RunnerResponseSchema>;
