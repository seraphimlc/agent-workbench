import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NullableIdSchema = NonEmptyStringSchema.nullable();
const NullableTimestampSchema = NonEmptyStringSchema.nullable();
const NullableErrorCodeSchema = NonEmptyStringSchema.nullable();
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const ModelCallStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'interrupted',
]);
export const ModelAttemptStatusSchema = ModelCallStatusSchema;
export const ToolExecutionModeSchema = z.enum([
  'read_inline',
  'worker',
  'transactional_intrinsic',
]);
export const ToolSideEffectClassSchema = z.enum(['read', 'local_write']);
export const ToolRunStatusSchema = z.enum([
  'queued',
  'running',
  'cancel_requested',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
]);
export const ToolDispatchStateSchema = z.enum([
  'prepared',
  'worker_ready',
  'go_sent',
  'acknowledged',
]);
export const ToolEffectStateSchema = z.enum([
  'not_applied',
  'applied',
  'unknown',
]);
export const ArtifactVisibilitySchema = z.enum([
  'final',
  'working',
  'evidence',
]);
export const ArtifactValidationStatusSchema = z.enum([
  'valid',
  'warning',
  'invalid',
  'unchecked',
]);

export const ModelCallSchema = z
  .object({
    id: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
    ordinal: PositiveIntegerSchema,
    kind: z.literal('craft'),
    status: ModelCallStatusSchema,
    successfulAttemptId: NullableIdSchema,
    errorCode: NullableErrorCodeSchema,
    createdAt: NonEmptyStringSchema,
    startedAt: NonEmptyStringSchema,
    finishedAt: NullableTimestampSchema,
  })
  .strict();

export const ModelAttemptSchema = z
  .object({
    id: NonEmptyStringSchema,
    modelCallId: NonEmptyStringSchema,
    attempt: PositiveIntegerSchema,
    status: ModelAttemptStatusSchema,
    providerRequestId: NullableIdSchema,
    finishReason: NonEmptyStringSchema.nullable(),
    inputTokens: NonNegativeIntegerSchema.nullable(),
    outputTokens: NonNegativeIntegerSchema.nullable(),
    cachedTokens: NonNegativeIntegerSchema.nullable(),
    latencyMs: NonNegativeIntegerSchema.nullable(),
    errorCode: NullableErrorCodeSchema,
    retryable: z.boolean().nullable(),
    startedAt: NonEmptyStringSchema,
    finishedAt: NullableTimestampSchema,
  })
  .strict();

export const ToolRunSchema = z
  .object({
    id: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
    ordinal: PositiveIntegerSchema,
    logicalCallId: NonEmptyStringSchema,
    sourceModelCallId: NonEmptyStringSchema,
    sourceModelAttemptId: NonEmptyStringSchema,
    attempt: PositiveIntegerSchema,
    operationId: NonEmptyStringSchema,
    idempotencyKey: NullableIdSchema,
    toolId: NonEmptyStringSchema,
    toolVersion: NonEmptyStringSchema,
    executionMode: ToolExecutionModeSchema,
    sideEffectClass: ToolSideEffectClassSchema,
    status: ToolRunStatusSchema,
    dispatchState: ToolDispatchStateSchema.nullable(),
    normalizedInputHash: Sha256Schema,
    effectState: ToolEffectStateSchema,
    errorCode: NullableErrorCodeSchema,
    queuedAt: NonEmptyStringSchema,
    startedAt: NullableTimestampSchema,
    finishedAt: NullableTimestampSchema,
  })
  .strict();

export const ArtifactSchema = z
  .object({
    id: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    logicalName: NonEmptyStringSchema,
    currentVersionId: NonEmptyStringSchema,
    createdAt: NonEmptyStringSchema,
    updatedAt: NonEmptyStringSchema,
  })
  .strict();

export const ArtifactVersionSchema = z
  .object({
    id: NonEmptyStringSchema,
    artifactId: NonEmptyStringSchema,
    version: PositiveIntegerSchema,
    sourceTurnId: NonEmptyStringSchema,
    sourceToolRunId: NonEmptyStringSchema,
    blobSha256: Sha256Schema,
    visibility: ArtifactVisibilitySchema,
    artifactType: z.literal('markdown'),
    mimeType: z.literal('text/markdown'),
    filename: NonEmptyStringSchema,
    size: NonNegativeIntegerSchema,
    validationStatus: ArtifactValidationStatusSchema,
    registrationKey: NonEmptyStringSchema,
    registrationInputHash: Sha256Schema,
    createdAt: NonEmptyStringSchema,
  })
  .strict();

export const ExecutionSummarySchema = z
  .object({
    total: NonNegativeIntegerSchema,
    succeeded: NonNegativeIntegerSchema,
    failed: NonNegativeIntegerSchema,
    interrupted: NonNegativeIntegerSchema,
  })
  .strict();

export const ChecklistSummarySchema = z
  .object({
    total: NonNegativeIntegerSchema,
    pending: NonNegativeIntegerSchema,
    inProgress: NonNegativeIntegerSchema,
    completed: NonNegativeIntegerSchema,
    skipped: NonNegativeIntegerSchema,
  })
  .strict();

export const UsageSummarySchema = z
  .object({
    inputTokens: NonNegativeIntegerSchema,
    outputTokens: NonNegativeIntegerSchema,
    cachedTokens: NonNegativeIntegerSchema,
    incomplete: z.boolean(),
  })
  .strict();

export const TurnOutcomeSchema = z
  .object({
    turnId: NonEmptyStringSchema,
    terminalStatus: z.enum([
      'succeeded',
      'failed',
      'canceled',
      'interrupted',
      'waiting_for_user',
    ]),
    errorCode: NullableErrorCodeSchema,
    resultMessageId: NullableIdSchema,
    finalArtifactVersionIds: z.array(NonEmptyStringSchema),
    workingArtifactVersionIds: z.array(NonEmptyStringSchema),
    evidenceArtifactVersionIds: z.array(NonEmptyStringSchema),
    modelCallSummary: ExecutionSummarySchema,
    toolRunSummary: ExecutionSummarySchema,
    skillRunSummary: ExecutionSummarySchema,
    checklistSummary: ChecklistSummarySchema,
    usageSummary: UsageSummarySchema,
    unresolvedEffectToolRunIds: z.array(NonEmptyStringSchema),
  })
  .strict();

export type ModelCallStatus = z.infer<typeof ModelCallStatusSchema>;
export type ModelAttemptStatus = z.infer<typeof ModelAttemptStatusSchema>;
export type ToolExecutionMode = z.infer<typeof ToolExecutionModeSchema>;
export type ToolSideEffectClass = z.infer<typeof ToolSideEffectClassSchema>;
export type ToolRunStatus = z.infer<typeof ToolRunStatusSchema>;
export type ToolDispatchState = z.infer<typeof ToolDispatchStateSchema>;
export type ToolEffectState = z.infer<typeof ToolEffectStateSchema>;
export type ModelCall = z.infer<typeof ModelCallSchema>;
export type ModelAttempt = z.infer<typeof ModelAttemptSchema>;
export type ToolRun = z.infer<typeof ToolRunSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
export type ExecutionSummary = z.infer<typeof ExecutionSummarySchema>;
export type ChecklistSummary = z.infer<typeof ChecklistSummarySchema>;
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;
