import { z } from 'zod';

import { RendererSessionEventEnvelopeSchema } from './events.js';

const NonEmptyStringSchema = z.string().min(1);
const NullableIdSchema = NonEmptyStringSchema.nullable();
const NullableTimestampSchema = NonEmptyStringSchema.nullable();

export const SessionModeSchema = z.enum(['ask', 'plan', 'craft']);
export const CraftModeSchema = z.literal('craft');
export const AccessModeSchema = z.literal('full_access');
export const SessionLifecycleStatusSchema = z.enum(['active', 'archived']);
export const SessionRuntimeStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'waiting_for_user',
  'canceling',
  'recovering',
  'error',
]);
export const QueueBlockReasonSchema = z.literal('recovery_review').nullable();
export const MessageRoleSchema = z.enum(['user', 'assistant', 'system_summary']);
export const MessageStatusSchema = z.enum(['streaming', 'completed', 'interrupted']);
export const TurnQueueKindSchema = z.enum(['normal', 'input_response', 'recovery']);
export const TurnStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_for_user',
  'cancel_requested',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
]);

export const SessionRowSchema = z
  .object({
    id: NonEmptyStringSchema,
    title: z.string(),
    workspaceId: NonEmptyStringSchema,
    lifecycleStatus: SessionLifecycleStatusSchema,
    runtimeStatus: SessionRuntimeStatusSchema,
    queueBlockReason: QueueBlockReasonSchema,
    recoveryEpisode: z.number().int().nonnegative(),
    recoverySourceTurnId: NullableIdSchema,
    currentTurnId: NullableIdSchema,
    mode: CraftModeSchema,
    accessMode: AccessModeSchema,
    nextTurnOrdinal: z.number().int().positive(),
    nextEventSeq: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    createdAt: NonEmptyStringSchema,
    updatedAt: NonEmptyStringSchema,
  })
  .strict();

export const MessageRowSchema = z
  .object({
    id: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
    role: MessageRoleSchema,
    status: MessageStatusSchema,
    content: z.string(),
    createdAt: NonEmptyStringSchema,
    completedAt: NullableTimestampSchema,
  })
  .strict();

export const TurnRowSchema = z
  .object({
    id: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
    ordinal: z.number().int().positive(),
    clientRequestId: NonEmptyStringSchema,
    queueKind: TurnQueueKindSchema,
    status: TurnStatusSchema,
    inputMessageId: NonEmptyStringSchema,
    modeSnapshot: CraftModeSchema,
    accessModeSnapshot: AccessModeSchema,
    queuedAt: NonEmptyStringSchema,
    startedAt: NullableTimestampSchema,
    finishedAt: NullableTimestampSchema,
    errorCode: z.string().min(1).nullable(),
    errorMessage: z.string().min(1).nullable(),
    resultMessageId: NullableIdSchema,
  })
  .strict();

export const SessionSnapshotSchema = z
  .object({
    session: SessionRowSchema,
    messages: z.array(MessageRowSchema),
    turns: z.array(TurnRowSchema),
    highWaterSeq: z.number().int().nonnegative(),
    events: z.array(RendererSessionEventEnvelopeSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    snapshot.messages.forEach((message, index) => {
      if (message.sessionId !== snapshot.session.id) {
        context.addIssue({
          code: 'custom',
          message: 'Message belongs to a different session',
          path: ['messages', index, 'sessionId'],
        });
      }
    });

    snapshot.turns.forEach((turn, index) => {
      if (turn.sessionId !== snapshot.session.id) {
        context.addIssue({
          code: 'custom',
          message: 'Turn belongs to a different session',
          path: ['turns', index, 'sessionId'],
        });
      }

      const previousTurn = snapshot.turns[index - 1];
      if (previousTurn && previousTurn.ordinal >= turn.ordinal) {
        context.addIssue({
          code: 'custom',
          message: 'Turns must be ordered by ordinal',
          path: ['turns', index, 'ordinal'],
        });
      }
    });

    if (snapshot.events.length !== snapshot.highWaterSeq) {
      context.addIssue({
        code: 'custom',
        message: 'Snapshot events must cover every sequence through highWaterSeq',
        path: ['events'],
      });
    }

    snapshot.events.forEach((event, index) => {
      if (event.sessionId !== snapshot.session.id) {
        context.addIssue({
          code: 'custom',
          message: 'Event belongs to a different session',
          path: ['events', index, 'sessionId'],
        });
      }

      if (event.seq !== index + 1) {
        context.addIssue({
          code: 'custom',
          message: 'Snapshot events must be ordered without sequence gaps',
          path: ['events', index, 'seq'],
        });
      }
    });
  });

export type SessionMode = z.infer<typeof SessionModeSchema>;
export type CraftMode = z.infer<typeof CraftModeSchema>;
export type AccessMode = z.infer<typeof AccessModeSchema>;
export type SessionLifecycleStatus = z.infer<typeof SessionLifecycleStatusSchema>;
export type SessionRuntimeStatus = z.infer<typeof SessionRuntimeStatusSchema>;
export type QueueBlockReason = z.infer<typeof QueueBlockReasonSchema>;
export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type MessageStatus = z.infer<typeof MessageStatusSchema>;
export type TurnQueueKind = z.infer<typeof TurnQueueKindSchema>;
export type TurnStatus = z.infer<typeof TurnStatusSchema>;
export type SessionRow = z.infer<typeof SessionRowSchema>;
export type MessageRow = z.infer<typeof MessageRowSchema>;
export type TurnRow = z.infer<typeof TurnRowSchema>;
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
