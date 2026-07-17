import {
  createEventListAfterResultSchema,
  EventListAfterResultSchema,
  SessionSnapshotSchema,
  type EventListAfterPayload,
} from '@agent-workbench/protocol';
import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
export const PROMPT_MAX_LENGTH = 64 * 1024;
const SubmissionIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), {
    message: 'submissionId must use canonical lowercase UUID form',
  });

export const DaemonRuntimePublicInfoSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      protocolVersion: z.literal(1),
      pid: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      protocolVersion: z.null(),
      pid: z.null(),
    })
    .strict(),
]);

export const RuntimePublicInfoSchema = z
  .object({
    daemon: DaemonRuntimePublicInfoSchema,
    provider: z
      .object({
        baseHost: NonEmptyStringSchema,
        modelId: NonEmptyStringSchema,
      })
      .strict(),
    workspace: z.object({ name: NonEmptyStringSchema }).strict(),
  })
  .strict();

const SubmissionShape = {
  submissionId: SubmissionIdSchema,
  prompt: z.string().trim().min(1).max(PROMPT_MAX_LENGTH),
};

export const SessionSubmissionSchema = z.object(SubmissionShape).strict();
export const TurnSubmissionSchema = z.object(SubmissionShape).strict();

export const SessionCreatedHttpResponseSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
  })
  .strict();

export const TurnSubmittedHttpResponseSchema = z
  .object({ turnId: NonEmptyStringSchema })
  .strict();

export const SessionSnapshotHttpResponseSchema = z
  .object({ snapshot: SessionSnapshotSchema })
  .strict();

export const SessionEventsHttpResponseSchema = EventListAfterResultSchema;

export const createSessionEventsHttpResponseSchema = (
  request: EventListAfterPayload,
) => createEventListAfterResultSchema(request);

export const PublicErrorSchema = z
  .object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    retryable: z.boolean(),
    userAction: NonEmptyStringSchema.nullable(),
  })
  .strict();

export const PublicErrorResponseSchema = z
  .object({ error: PublicErrorSchema })
  .strict();

export type DaemonRuntimePublicInfo = z.infer<
  typeof DaemonRuntimePublicInfoSchema
>;
export type RuntimePublicInfo = z.infer<typeof RuntimePublicInfoSchema>;
export type SessionSubmission = z.infer<typeof SessionSubmissionSchema>;
export type TurnSubmission = z.infer<typeof TurnSubmissionSchema>;
export type SessionCreatedHttpResponse = z.infer<
  typeof SessionCreatedHttpResponseSchema
>;
export type TurnSubmittedHttpResponse = z.infer<
  typeof TurnSubmittedHttpResponseSchema
>;
export type SessionSnapshotHttpResponse = z.infer<
  typeof SessionSnapshotHttpResponseSchema
>;
export type SessionEventsHttpResponse = z.infer<
  typeof SessionEventsHttpResponseSchema
>;
export type PublicError = z.infer<typeof PublicErrorSchema>;
export type PublicErrorResponse = z.infer<typeof PublicErrorResponseSchema>;
