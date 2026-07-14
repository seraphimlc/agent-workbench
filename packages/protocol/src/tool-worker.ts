import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const ToolWorkerInitSchema = z
  .object({
    kind: z.literal('INIT'),
    daemonEpoch: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
    toolRunId: NonEmptyStringSchema,
    executionFence: PositiveIntegerSchema,
    capability: NonEmptyStringSchema,
    dispatchNonce: NonEmptyStringSchema,
    requestedPath: NonEmptyStringSchema,
    canonicalPath: NonEmptyStringSchema,
    targetExistedBefore: z.boolean(),
    baselineSha256: Sha256Schema.nullable(),
    expectedSha256: Sha256Schema,
    expectedSize: NonNegativeIntegerSchema,
    content: z.string(),
    maxBytes: PositiveIntegerSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.targetExistedBefore !== (message.baselineSha256 !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'baselineSha256 must describe whether the target existed',
        path: ['baselineSha256'],
      });
    }
    if (message.expectedSize > message.maxBytes) {
      context.addIssue({
        code: 'custom',
        message: 'expectedSize cannot exceed maxBytes',
        path: ['expectedSize'],
      });
    }
  });

export const ToolWorkerReadySchema = z
  .object({
    kind: z.literal('READY'),
    dispatchNonce: NonEmptyStringSchema,
  })
  .strict();

export const ToolWorkerGoSchema = z
  .object({
    kind: z.literal('GO'),
    dispatchNonce: NonEmptyStringSchema,
  })
  .strict();

export const ToolWorkerAckSchema = z
  .object({
    kind: z.literal('ACK'),
    dispatchNonce: NonEmptyStringSchema,
  })
  .strict();

export const ToolWorkerResultStatusSchema = z.enum(['succeeded', 'failed']);

export const ToolWorkerResultSchema = z
  .object({
    kind: z.literal('RESULT'),
    status: ToolWorkerResultStatusSchema,
    baselineSha256: Sha256Schema.nullable(),
    finalSha256: Sha256Schema.nullable(),
    size: NonNegativeIntegerSchema.nullable(),
    errorCode: NonEmptyStringSchema.nullable(),
    errorMessage: NonEmptyStringSchema.nullable(),
    retryable: z.boolean().nullable(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.status === 'succeeded') {
      if (message.finalSha256 === null || message.size === null) {
        context.addIssue({
          code: 'custom',
          message: 'A successful worker result requires a final hash and size',
          path: ['finalSha256'],
        });
      }
      if (
        message.errorCode !== null ||
        message.errorMessage !== null ||
        message.retryable !== null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'A successful worker result cannot contain error metadata',
          path: ['errorCode'],
        });
      }
      return;
    }
    if (
      message.errorCode === null ||
      message.errorMessage === null ||
      message.retryable === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A failed worker result requires stable error metadata',
        path: ['errorCode'],
      });
    }
  });

export const ToolWorkerErrorSchema = z
  .object({
    kind: z.literal('ERROR'),
    errorCode: NonEmptyStringSchema,
    errorMessage: NonEmptyStringSchema,
    retryable: z.boolean(),
  })
  .strict();

export const ToolWorkerEnvelopeSchema = z.discriminatedUnion('kind', [
  ToolWorkerInitSchema,
  ToolWorkerReadySchema,
  ToolWorkerGoSchema,
  ToolWorkerAckSchema,
  ToolWorkerResultSchema,
  ToolWorkerErrorSchema,
]);

const createNonceBoundSchema = <T extends z.ZodTypeAny>(
  schema: T,
  expectedDispatchNonce: string,
) => {
  const dispatchNonce = NonEmptyStringSchema.parse(expectedDispatchNonce);
  return schema.superRefine((message, context) => {
    const candidate = message as { readonly dispatchNonce?: string };
    if (candidate.dispatchNonce !== dispatchNonce) {
      context.addIssue({
        code: 'custom',
        message: 'dispatchNonce does not match the initialized worker',
        path: ['dispatchNonce'],
      });
    }
  });
};

export const createToolWorkerReadySchema = (dispatchNonce: string) =>
  createNonceBoundSchema(ToolWorkerReadySchema, dispatchNonce);
export const createToolWorkerGoSchema = (dispatchNonce: string) =>
  createNonceBoundSchema(ToolWorkerGoSchema, dispatchNonce);
export const createToolWorkerAckSchema = (dispatchNonce: string) =>
  createNonceBoundSchema(ToolWorkerAckSchema, dispatchNonce);

export type ToolWorkerInit = z.infer<typeof ToolWorkerInitSchema>;
export type ToolWorkerReady = z.infer<typeof ToolWorkerReadySchema>;
export type ToolWorkerGo = z.infer<typeof ToolWorkerGoSchema>;
export type ToolWorkerAck = z.infer<typeof ToolWorkerAckSchema>;
export type ToolWorkerResult = z.infer<typeof ToolWorkerResultSchema>;
export type ToolWorkerError = z.infer<typeof ToolWorkerErrorSchema>;
export type ToolWorkerEnvelope = z.infer<typeof ToolWorkerEnvelopeSchema>;
