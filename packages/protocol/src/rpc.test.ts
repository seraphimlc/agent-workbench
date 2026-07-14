import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

type ParseSchema = {
  safeParse: (value: unknown) => { success: boolean };
};

type SchemaFactory = (request: Record<string, unknown>) => ParseSchema;

const getSchema = (name: string): ParseSchema => {
  const schema = Reflect.get(protocol, name) as ParseSchema | undefined;
  expect(schema, `${name} should be exported`).toBeDefined();
  return schema as ParseSchema;
};

const getSchemaFactory = (name: string): SchemaFactory => {
  const factory = Reflect.get(protocol, name) as SchemaFactory | undefined;
  expect(factory, `${name} should be exported`).toBeDefined();
  return factory as SchemaFactory;
};

const baseRequest = {
  kind: 'request',
  protocolVersion: 1,
  requestId: 'request-1',
  traceId: 'trace-1',
  sessionId: null,
  turnId: null,
};

const visibleEvent = {
  id: 'event-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolRunId: null,
  seq: 1,
  type: 'turn.queued',
  actor: 'daemon',
  audience: 'both',
  redacted: false,
  payload: { ordinal: 1 },
  blobId: null,
  createdAt: '2026-07-14T00:00:00.000Z',
};

const modelOnlyEvent = {
  ...visibleEvent,
  type: 'context.changed',
  audience: 'model',
  payload: { internalContext: 'not for Renderer' },
};

const redactedEvent = {
  ...modelOnlyEvent,
  type: 'redacted',
  redacted: true,
  payload: null,
  blobId: null,
};

const visibleEventAt = (seq: number, sessionId = 'session-1') => ({
  ...visibleEvent,
  id: `event-${sessionId}-${seq}`,
  sessionId,
  seq,
});

const redactedEventAt = (seq: number, sessionId = 'session-1') => ({
  ...redactedEvent,
  id: `event-${sessionId}-${seq}`,
  sessionId,
  seq,
});

const canonicalError = {
  code: 'MODEL_AUTH_FAILED',
  category: 'configuration',
  message: 'Model credentials are invalid',
  retryable: false,
  userAction: 'Update the model profile credentials',
  detailsRef: null,
  traceId: 'trace-1',
};

const sessionSnapshot = {
  session: {
    id: 'session-1',
    title: 'New session',
    workspaceId: 'workspace-1',
    lifecycleStatus: 'active',
    runtimeStatus: 'queued',
    queueBlockReason: null,
    recoveryEpisode: 0,
    recoverySourceTurnId: null,
    currentTurnId: null,
    mode: 'craft',
    accessMode: 'full_access',
    nextTurnOrdinal: 2,
    nextEventSeq: 2,
    revision: 1,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  },
  messages: [
    {
      id: 'message-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      role: 'user',
      status: 'completed',
      content: 'Start here',
      createdAt: '2026-07-14T00:00:00.000Z',
      completedAt: '2026-07-14T00:00:00.000Z',
    },
  ],
  turns: [
    {
      id: 'turn-1',
      sessionId: 'session-1',
      ordinal: 1,
      clientRequestId: 'client-1',
      queueKind: 'normal',
      status: 'queued',
      inputMessageId: 'message-1',
      modeSnapshot: 'craft',
      accessModeSnapshot: 'full_access',
      executionFence: 0,
      queuedAt: '2026-07-14T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      resultMessageId: null,
    },
  ],
  highWaterSeq: 1,
  events: [visibleEvent],
};

describe('protocol exports', () => {
  it('exports the versioned RPC envelope schemas', () => {
    expect(protocol).toHaveProperty('RpcEnvelopeSchema');
    expect(protocol).toHaveProperty('SessionEventEnvelopeSchema');
    expect(protocol).toHaveProperty('SessionSnapshotSchema');
  });
});

describe('request envelopes', () => {
  it.each([
    ['workspace.register', { path: '/tmp/workspace' }, null],
    [
      'session.create',
      { workspaceId: 'workspace-1', title: 'New session', prompt: 'Start here' },
      null,
    ],
    ['turn.enqueue', { sessionId: 'session-1', prompt: 'Continue' }, 'session-1'],
  ])('requires a non-empty clientRequestId for %s', (method, payload, sessionId) => {
    const schema = getSchema('RpcRequestSchema');
    const request = { ...baseRequest, sessionId, method, payload };

    expect(schema.safeParse({ ...request, clientRequestId: 'client-1' }).success).toBe(true);
    expect(schema.safeParse({ ...request, clientRequestId: '' }).success).toBe(false);
    expect(schema.safeParse({ ...request, clientRequestId: null }).success).toBe(false);
    expect(schema.safeParse(request).success).toBe(false);
  });

  it.each([
    ['auth.respond', { nonce: 'nonce-1', mac: 'mac-1' }, null],
    ['app.health', {}, null],
    ['session.getSnapshot', { sessionId: 'session-1' }, 'session-1'],
    ['event.listAfter', { sessionId: 'session-1', afterSeq: 0, limit: 100 }, 'session-1'],
  ])('requires null clientRequestId for %s', (method, payload, sessionId) => {
    const schema = getSchema('RpcRequestSchema');
    const request = { ...baseRequest, sessionId, method, payload };

    expect(schema.safeParse({ ...request, clientRequestId: null }).success).toBe(true);
    expect(schema.safeParse({ ...request, clientRequestId: 'client-1' }).success).toBe(false);
  });

  it.each([
    ['auth.respond', { nonce: 'nonce-1', mac: 'mac-1' }, null],
    ['app.health', {}, null],
    ['workspace.register', { path: '/tmp/workspace' }, 'client-1'],
    [
      'session.create',
      { workspaceId: 'workspace-1', title: 'New session', prompt: 'Start here' },
      'client-1',
    ],
  ])('requires null top-level Session and Turn scope for %s', (method, payload, clientRequestId) => {
    const schema = getSchema('RpcRequestSchema');
    const request = { ...baseRequest, method, payload, clientRequestId };
    const missingSessionId = { ...request };
    const missingTurnId = { ...request };
    Reflect.deleteProperty(missingSessionId, 'sessionId');
    Reflect.deleteProperty(missingTurnId, 'turnId');

    expect(schema.safeParse(request).success).toBe(true);
    expect(schema.safeParse({ ...request, sessionId: 'session-1' }).success).toBe(false);
    expect(schema.safeParse({ ...request, turnId: 'turn-1' }).success).toBe(false);
    expect(schema.safeParse(missingSessionId).success).toBe(false);
    expect(schema.safeParse(missingTurnId).success).toBe(false);
  });

  it.each([
    ['session.getSnapshot', { sessionId: 'session-1' }, null],
    ['turn.enqueue', { sessionId: 'session-1', prompt: 'Continue' }, 'client-1'],
    ['event.listAfter', { sessionId: 'session-1', afterSeq: 0, limit: 100 }, null],
  ])('binds top-level Session scope to the %s payload', (method, payload, clientRequestId) => {
    const schema = getSchema('RpcRequestSchema');
    const request = {
      ...baseRequest,
      sessionId: payload.sessionId,
      method,
      payload,
      clientRequestId,
    };
    const missingSessionId = { ...request };
    const missingTurnId = { ...request };
    Reflect.deleteProperty(missingSessionId, 'sessionId');
    Reflect.deleteProperty(missingTurnId, 'turnId');

    expect(schema.safeParse(request).success).toBe(true);
    expect(schema.safeParse({ ...request, sessionId: 'session-other' }).success).toBe(false);
    expect(schema.safeParse({ ...request, turnId: 'turn-1' }).success).toBe(false);
    expect(schema.safeParse(missingSessionId).success).toBe(false);
    expect(schema.safeParse(missingTurnId).success).toBe(false);
  });

  it('rejects an unknown method', () => {
    const transportSchema = getSchema('RpcEnvelopeSchema');
    const requestSchema = getSchema('RpcRequestSchema');
    const request = {
      ...baseRequest,
      method: 'system.runAnything',
      payload: {},
      clientRequestId: null,
    };

    expect(transportSchema.safeParse(request).success).toBe(false);
    expect(requestSchema.safeParse(request).success).toBe(false);
  });

  it('validates payloads against the selected method', () => {
    const schema = getSchema('RpcRequestSchema');

    expect(
      schema.safeParse({
        ...baseRequest,
        method: 'app.health',
        payload: { unexpected: true },
        clientRequestId: null,
      }).success,
    ).toBe(false);
  });

  it('defers payload and scope validation until a request is associated with its method', () => {
    const transportSchema = getSchema('RpcEnvelopeSchema');
    const requestSchema = getSchema('RpcRequestSchema');
    const request = {
      ...baseRequest,
      sessionId: 'session-other',
      method: 'session.getSnapshot',
      payload: { sessionId: 'session-1', transportOnly: true },
      clientRequestId: null,
    };

    expect(transportSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse(request).success).toBe(false);
  });
});

describe('response envelopes', () => {
  it('discriminates success from error responses', () => {
    const schema = getSchema('RpcEnvelopeSchema');
    const baseResponse = {
      kind: 'response',
      protocolVersion: 1,
      requestId: 'request-1',
      traceId: 'trace-1',
    };
    const result = { notYetAssociatedWithMethod: ['any', 'json', 'result'] };

    expect(schema.safeParse({ ...baseResponse, ok: true, result }).success).toBe(true);
    expect(schema.safeParse({ ...baseResponse, ok: false, error: canonicalError }).success).toBe(
      true,
    );
    expect(schema.safeParse({ ...baseResponse, ok: true, error: canonicalError }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...baseResponse, ok: false, result }).success).toBe(false);
  });

  it('validates the canonical cross-process ErrorEnvelope without inline details', () => {
    const schema = getSchema('ErrorEnvelopeSchema');

    expect(schema.safeParse(canonicalError).success).toBe(true);
    expect(schema.safeParse({ ...canonicalError, category: 'network' }).success).toBe(false);
    expect(schema.safeParse({ ...canonicalError, userAction: '' }).success).toBe(false);
    expect(schema.safeParse({ ...canonicalError, traceId: '' }).success).toBe(false);
    expect(schema.safeParse({ ...canonicalError, details: { secret: true } }).success).toBe(false);
  });

  it.each([
    ['AuthRespondResultSchema', { authenticated: true }, { authenticated: false }],
    [
      'AppHealthResultSchema',
      { status: 'ready', protocolVersion: 1, pid: 42 },
      { status: 'ready', protocolVersion: 1, pid: 0 },
    ],
    ['WorkspaceRegisterResultSchema', { workspaceId: 'workspace-1' }, { workspaceId: '' }],
    [
      'SessionCreateResultSchema',
      { sessionId: 'session-1', turnId: 'turn-1' },
      { sessionId: 'session-1' },
    ],
    [
      'SessionGetSnapshotResultSchema',
      sessionSnapshot,
      { ...sessionSnapshot, highWaterSeq: 0 },
    ],
    ['TurnEnqueueResultSchema', { turnId: 'turn-1' }, { turnId: '' }],
    [
      'EventListAfterResultSchema',
      { events: [visibleEvent], highWaterSeq: 1 },
      { events: 'not-an-array', highWaterSeq: 1 },
    ],
  ])('%s validates its method-specific result', (schemaName, valid, invalid) => {
    const schema = getSchema(schemaName);

    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse(invalid).success).toBe(false);
  });
});

describe('event.listAfter results', () => {
  it('requires one-session ascending consecutive events at or below highWaterSeq', () => {
    const schema = getSchema('EventListAfterResultSchema');
    const validResult = {
      events: [visibleEventAt(2), redactedEventAt(3)],
      highWaterSeq: 3,
    };

    expect(schema.safeParse(validResult).success).toBe(true);
    expect(
      schema.safeParse({
        ...validResult,
        events: [visibleEventAt(2), redactedEventAt(3, 'session-other')],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...validResult, events: [visibleEventAt(3), visibleEventAt(2)] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...validResult, events: [visibleEventAt(1), visibleEventAt(3)] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ events: [visibleEventAt(4)], highWaterSeq: 3 }).success,
    ).toBe(false);
  });

  it('validates exact continuity after associating the originating request', () => {
    const createSchema = getSchemaFactory('createEventListAfterResultSchema');
    const request = { sessionId: 'session-1', afterSeq: 1, limit: 2 };
    const schema = createSchema(request);
    const validResult = {
      events: [visibleEventAt(2), redactedEventAt(3)],
      highWaterSeq: 3,
    };

    expect(schema.safeParse(validResult).success).toBe(true);
    expect(schema.safeParse({ events: [], highWaterSeq: 0 }).success).toBe(false);
    expect(
      schema.safeParse({
        ...validResult,
        events: [visibleEventAt(2, 'session-other'), redactedEventAt(3, 'session-other')],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...validResult, events: [visibleEventAt(2)] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...validResult, events: [visibleEventAt(1), visibleEventAt(2)] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        events: [visibleEventAt(2), visibleEventAt(3), visibleEventAt(4)],
        highWaterSeq: 4,
      }).success,
    ).toBe(false);
  });
});

describe('notification envelopes', () => {
  it.each(['auth.challenge', 'event', 'resync_required'])(
    'accepts an unassociated JSON payload for generic %s notifications',
    (method) => {
      const schema = getSchema('RpcEnvelopeSchema');

      expect(
        schema.safeParse({
          kind: 'notification',
          protocolVersion: 1,
          traceId: 'trace-1',
          method,
          payload: { notYetAssociatedWithMethod: true },
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    ['AuthChallengeNotificationSchema', 'auth.challenge', { nonce: 'nonce-1' }],
    [
      'ResyncRequiredNotificationSchema',
      'resync_required',
      { sessionId: 'session-1', highWaterSeq: 1 },
    ],
  ])('%s retains method-specific payload validation', (schemaName, method, payload) => {
    const schema = getSchema(schemaName);
    const notification = {
      kind: 'notification',
      protocolVersion: 1,
      traceId: 'trace-1',
      method,
    };

    expect(schema.safeParse({ ...notification, payload }).success).toBe(true);
    expect(
      schema.safeParse({
        ...notification,
        payload: { notYetAssociatedWithMethod: true },
      }).success,
    ).toBe(false);
  });

  it('keeps model-only event content behind the Renderer notification boundary', () => {
    const schema = getSchema('EventNotificationSchema');
    const notification = {
      kind: 'notification',
      protocolVersion: 1,
      traceId: 'trace-1',
      method: 'event',
    };

    expect(schema.safeParse({ ...notification, payload: modelOnlyEvent }).success).toBe(false);
    expect(schema.safeParse({ ...notification, payload: redactedEvent }).success).toBe(true);
  });
});

describe('control envelopes', () => {
  it('requires a non-empty cancel target request id', () => {
    const schema = getSchema('RpcEnvelopeSchema');
    const cancel = {
      kind: 'cancel',
      protocolVersion: 1,
      traceId: 'trace-1',
    };

    expect(schema.safeParse({ ...cancel, targetRequestId: 'request-1' }).success).toBe(true);
    expect(schema.safeParse({ ...cancel, targetRequestId: '' }).success).toBe(false);
  });

  it('requires an opaque daemon epoch and a nonnegative integer lease epoch', () => {
    const schema = getSchema('RpcEnvelopeSchema');
    const heartbeat = {
      kind: 'heartbeat',
      protocolVersion: 1,
      traceId: 'trace-1',
    };

    expect(
      schema.safeParse({ ...heartbeat, daemonEpoch: 'daemon-epoch-1', leaseEpoch: 0 }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...heartbeat, daemonEpoch: '', leaseEpoch: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...heartbeat, daemonEpoch: 0, leaseEpoch: 0 }).success).toBe(false);
    expect(
      schema.safeParse({ ...heartbeat, daemonEpoch: 'daemon-epoch-1', leaseEpoch: -1 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...heartbeat, daemonEpoch: 'daemon-epoch-1', leaseEpoch: 1.5 }).success,
    ).toBe(false);
  });
});

describe('event envelopes', () => {
  it('accepts only an opaque redacted placeholder with no payload or blob', () => {
    const schema = getSchema('SessionEventEnvelopeSchema');

    expect(schema.safeParse(redactedEvent).success).toBe(true);
    expect(schema.safeParse({ ...redactedEvent, type: 'model.internal' }).success).toBe(false);
    expect(schema.safeParse({ ...redactedEvent, payload: { secret: true } }).success).toBe(false);
    expect(schema.safeParse({ ...redactedEvent, blobId: 'blob-secret' }).success).toBe(false);
    expect(schema.safeParse({ ...visibleEvent, type: 'redacted' }).success).toBe(false);
  });

  it('redacts complete model-only events at the Renderer boundary', () => {
    const internalSchema = getSchema('SessionEventEnvelopeSchema');
    const rendererSchema = getSchema('RendererSessionEventEnvelopeSchema');
    const redactedUiEvent = { ...redactedEvent, audience: 'ui' };
    const redactedBothEvent = { ...redactedEvent, audience: 'both' };

    expect(internalSchema.safeParse(modelOnlyEvent).success).toBe(true);
    expect(rendererSchema.safeParse(modelOnlyEvent).success).toBe(false);
    expect(rendererSchema.safeParse(redactedEvent).success).toBe(true);
    expect(internalSchema.safeParse(redactedUiEvent).success).toBe(true);
    expect(internalSchema.safeParse(redactedBothEvent).success).toBe(true);
    expect(rendererSchema.safeParse(redactedUiEvent).success).toBe(false);
    expect(rendererSchema.safeParse(redactedBothEvent).success).toBe(false);
  });
});

describe('session snapshots', () => {
  it('validates only the ordered Slice 1A runtime rows through the high-water mark', () => {
    const schema = getSchema('SessionSnapshotSchema');

    expect(schema.safeParse(sessionSnapshot).success).toBe(true);
    expect(
      schema.safeParse({
        ...sessionSnapshot,
        session: { ...sessionSnapshot.session, futureModelProfileId: 'model-1' },
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...sessionSnapshot, highWaterSeq: 0 }).success).toBe(false);
    expect(
      schema.safeParse({ ...sessionSnapshot, modelCalls: [] }).success,
    ).toBe(false);
  });

  it('requires a nonnegative integer execution fence on every Turn row', () => {
    const turnRowSchema = getSchema('TurnRowSchema');
    const turn = sessionSnapshot.turns[0];
    const missingFence: Record<string, unknown> = { ...turn };
    delete missingFence.executionFence;

    expect(turnRowSchema.safeParse(turn).success).toBe(true);
    expect(turnRowSchema.safeParse(missingFence).success).toBe(false);
    expect(
      turnRowSchema.safeParse({ ...turn, executionFence: -1 }).success,
    ).toBe(false);
    expect(
      turnRowSchema.safeParse({ ...turn, executionFence: 0.5 }).success,
    ).toBe(false);
  });

  it('keeps model-only event content behind the list Renderer boundary', () => {
    const eventListSchema = getSchema('EventListAfterResultSchema');

    expect(
      eventListSchema.safeParse({ events: [modelOnlyEvent], highWaterSeq: 1 }).success,
    ).toBe(false);
    expect(
      eventListSchema.safeParse({ events: [redactedEvent], highWaterSeq: 1 }).success,
    ).toBe(true);
  });

  it('keeps model-only event content behind the snapshot Renderer boundary', () => {
    const snapshotSchema = getSchema('SessionSnapshotSchema');

    expect(
      snapshotSchema.safeParse({ ...sessionSnapshot, events: [modelOnlyEvent] }).success,
    ).toBe(false);
    expect(
      snapshotSchema.safeParse({ ...sessionSnapshot, events: [redactedEvent] }).success,
    ).toBe(true);
  });

  it.each(['ask', 'plan'])('rejects %s mode in persisted Session rows', (mode) => {
    const productModeSchema = getSchema('SessionModeSchema');
    const sessionRowSchema = getSchema('SessionRowSchema');

    expect(productModeSchema.safeParse(mode).success).toBe(true);
    expect(sessionRowSchema.safeParse({ ...sessionSnapshot.session, mode }).success).toBe(false);
  });

  it.each(['ask', 'plan'])('rejects %s mode in persisted Turn rows', (modeSnapshot) => {
    const productModeSchema = getSchema('SessionModeSchema');
    const turnRowSchema = getSchema('TurnRowSchema');

    expect(productModeSchema.safeParse(modeSnapshot).success).toBe(true);
    expect(
      turnRowSchema.safeParse({ ...sessionSnapshot.turns[0], modeSnapshot }).success,
    ).toBe(false);
  });
});
