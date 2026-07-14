import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);

export const SessionEventActorSchema = z.enum(['user', 'daemon', 'runner', 'model', 'tool']);
export const SessionEventAudienceSchema = z.enum(['ui', 'model', 'both']);
export const RendererSessionEventAudienceSchema = z.enum(['ui', 'both']);
export const JsonValueSchema = z.json();

const SessionEventBaseShape = {
  id: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  turnId: NonEmptyStringSchema.nullable(),
  toolRunId: NonEmptyStringSchema.nullable(),
  seq: z.number().int().positive(),
  actor: SessionEventActorSchema,
  audience: SessionEventAudienceSchema,
  createdAt: NonEmptyStringSchema,
};

export const VisibleSessionEventEnvelopeSchema = z
  .object({
    ...SessionEventBaseShape,
    type: NonEmptyStringSchema.refine((type) => type !== 'redacted', {
      message: 'Visible events cannot use the redacted type',
    }),
    redacted: z.literal(false),
    payload: JsonValueSchema,
    blobId: NonEmptyStringSchema.nullable(),
  })
  .strict();

export const RedactedSessionEventEnvelopeSchema = z
  .object({
    ...SessionEventBaseShape,
    type: z.literal('redacted'),
    redacted: z.literal(true),
    payload: z.null(),
    blobId: z.null(),
  })
  .strict();

export const SessionEventEnvelopeSchema = z.discriminatedUnion('redacted', [
  VisibleSessionEventEnvelopeSchema,
  RedactedSessionEventEnvelopeSchema,
]);
export const RendererVisibleSessionEventEnvelopeSchema = VisibleSessionEventEnvelopeSchema.extend({
  audience: RendererSessionEventAudienceSchema,
});
export const RendererRedactedSessionEventEnvelopeSchema =
  RedactedSessionEventEnvelopeSchema.extend({
    audience: z.literal('model'),
  });
export const RendererSessionEventEnvelopeSchema = z.discriminatedUnion('redacted', [
  RendererVisibleSessionEventEnvelopeSchema,
  RendererRedactedSessionEventEnvelopeSchema,
]);

export type SessionEventActor = z.infer<typeof SessionEventActorSchema>;
export type SessionEventAudience = z.infer<typeof SessionEventAudienceSchema>;
export type RendererSessionEventAudience = z.infer<typeof RendererSessionEventAudienceSchema>;
export type JsonValue = z.infer<typeof JsonValueSchema>;
export type VisibleSessionEventEnvelope = z.infer<typeof VisibleSessionEventEnvelopeSchema>;
export type RedactedSessionEventEnvelope = z.infer<typeof RedactedSessionEventEnvelopeSchema>;
export type SessionEventEnvelope = z.infer<typeof SessionEventEnvelopeSchema>;
export type RendererVisibleSessionEventEnvelope = z.infer<
  typeof RendererVisibleSessionEventEnvelopeSchema
>;
export type RendererRedactedSessionEventEnvelope = z.infer<
  typeof RendererRedactedSessionEventEnvelopeSchema
>;
export type RendererSessionEventEnvelope = z.infer<typeof RendererSessionEventEnvelopeSchema>;
