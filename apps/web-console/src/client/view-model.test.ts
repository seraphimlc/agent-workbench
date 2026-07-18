import type {
  EventListAfterPayload,
  RendererSessionEventEnvelope,
  SessionSnapshot,
  TurnRow,
} from '@agent-workbench/protocol';
import { describe, expect, it } from 'vitest';

import {
  EVENT_SEQUENCE_CONFLICT,
  EVENT_SEQUENCE_GAP,
  applyEventPage,
  checkEventPage,
  createEventPageState,
  projectTimeline,
} from './view-model.js';

const timestamp = (second: number): string =>
  `2026-07-16T00:00:${String(second).padStart(2, '0')}.000Z`;

const visibleEvent = (
  seq: number,
  type: string,
  options: {
    readonly turnId?: string | null;
    readonly toolRunId?: string | null;
    readonly actor?: RendererSessionEventEnvelope['actor'];
    readonly payload?: unknown;
  } = {},
): RendererSessionEventEnvelope => ({
  id: `event-${seq}`,
  sessionId: 'session-1',
  turnId: options.turnId ?? null,
  toolRunId: options.toolRunId ?? null,
  seq,
  actor: options.actor ?? (options.toolRunId ? 'tool' : 'daemon'),
  audience: 'ui',
  createdAt: timestamp(seq),
  type,
  redacted: false,
  payload: (options.payload ?? {}) as never,
  blobId: null,
});

const redactedEvent = (seq: number): RendererSessionEventEnvelope => ({
  id: `event-${seq}`,
  sessionId: 'session-1',
  turnId: 'turn-3',
  toolRunId: null,
  seq,
  actor: 'model',
  audience: 'model',
  createdAt: timestamp(seq),
  type: 'redacted',
  redacted: true,
  payload: null,
  blobId: null,
});

const turn = (
  ordinal: number,
  status: TurnRow['status'],
  resultMessageId: string | null = null,
): TurnRow => ({
  id: `turn-${ordinal}`,
  sessionId: 'session-1',
  ordinal,
  clientRequestId: `request-${ordinal}`,
  queueKind: 'normal',
  status,
  inputMessageId: `message-user-${ordinal}`,
  modeSnapshot: 'craft',
  accessModeSnapshot: 'full_access',
  executionFence: 1,
  queuedAt: timestamp(ordinal),
  startedAt: status === 'queued' ? null : timestamp(ordinal + 1),
  finishedAt:
    status === 'succeeded' || status === 'failed' || status === 'interrupted'
      ? timestamp(ordinal + 10)
      : null,
  errorCode: status === 'failed' ? 'MODEL_FAILED' : null,
  errorMessage: status === 'failed' ? 'Model failed' : null,
  resultMessageId,
});

const events: RendererSessionEventEnvelope[] = [
  visibleEvent(1, 'session.created'),
  visibleEvent(2, 'turn.queued', {
    turnId: 'turn-1',
    payload: { ordinal: 1, queueKind: 'normal' },
  }),
  visibleEvent(3, 'model.started', {
    turnId: 'turn-1',
    payload: { modelCallId: 'model-call-1' },
  }),
  visibleEvent(4, 'model.completed', {
    turnId: 'turn-1',
    payload: { modelCallId: 'model-call-1', modelAttemptId: 'attempt-1' },
  }),
  visibleEvent(5, 'tool.started', {
    turnId: 'turn-1',
    toolRunId: 'tool-run-1',
    payload: {
      toolRunId: 'tool-run-1',
      toolId: 'fs.read_text',
      inputSummary: 'README.md',
    },
  }),
  visibleEvent(6, 'tool.succeeded', {
    turnId: 'turn-1',
    toolRunId: 'tool-run-1',
    payload: {
      toolRunId: 'tool-run-1',
      outputBytes: 42,
      outputSummary: 'Agent Workbench',
    },
  }),
  visibleEvent(7, 'tool.failed', {
    turnId: 'turn-1',
    toolRunId: 'tool-run-2',
    payload: { toolRunId: 'tool-run-2', errorCode: 'TOOL_EXECUTION_FAILED' },
  }),
  visibleEvent(8, 'turn.succeeded', {
    turnId: 'turn-1',
    payload: {
      modelAttemptId: 'attempt-1',
      assistantText: 'forged event answer',
    },
  }),
  visibleEvent(9, 'turn.queued', {
    turnId: 'turn-2',
    payload: { ordinal: 2, queueKind: 'normal' },
  }),
  visibleEvent(10, 'model.started', {
    turnId: 'turn-2',
    payload: { modelCallId: 'model-call-2' },
  }),
  visibleEvent(11, 'model.failed', {
    turnId: 'turn-2',
    payload: {
      modelCallId: 'model-call-2',
      modelAttemptId: 'attempt-2',
      errorCode: 'MODEL_RESPONSE_INVALID',
    },
  }),
  visibleEvent(12, 'turn.failed', {
    turnId: 'turn-2',
    payload: { errorCode: 'MODEL_RESPONSE_INVALID' },
  }),
  visibleEvent(13, 'turn.queued', {
    turnId: 'turn-3',
    payload: { ordinal: 3, queueKind: 'normal' },
  }),
  visibleEvent(14, 'turn.interrupted', {
    turnId: 'turn-3',
    payload: { reason: 'executor exited' },
  }),
  redactedEvent(15),
];

const snapshot: SessionSnapshot = {
  session: {
    id: 'session-1',
    title: 'Inspect repository',
    workspaceId: 'workspace-1',
    lifecycleStatus: 'active',
    runtimeStatus: 'idle',
    queueBlockReason: null,
    recoveryEpisode: 0,
    recoverySourceTurnId: null,
    currentTurnId: null,
    mode: 'craft',
    accessMode: 'full_access',
    nextTurnOrdinal: 4,
    nextEventSeq: 16,
    revision: 20,
    createdAt: timestamp(0),
    updatedAt: timestamp(15),
  },
  messages: [
    {
      id: 'message-user-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      role: 'user',
      status: 'completed',
      content: 'Read README.md',
      createdAt: timestamp(1),
      completedAt: timestamp(1),
    },
    {
      id: 'message-assistant-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      role: 'assistant',
      status: 'completed',
      content: 'Persisted assistant answer',
      createdAt: timestamp(8),
      completedAt: timestamp(8),
    },
    {
      id: 'message-user-2',
      sessionId: 'session-1',
      turnId: 'turn-2',
      role: 'user',
      status: 'completed',
      content: 'Try another model call',
      createdAt: timestamp(9),
      completedAt: timestamp(9),
    },
    {
      id: 'message-user-3',
      sessionId: 'session-1',
      turnId: 'turn-3',
      role: 'user',
      status: 'completed',
      content: 'Interrupt this turn',
      createdAt: timestamp(13),
      completedAt: timestamp(13),
    },
  ],
  turns: [
    turn(1, 'succeeded', 'message-assistant-1'),
    turn(2, 'failed'),
    turn(3, 'interrupted'),
  ],
  highWaterSeq: 15,
  events,
};

describe('authoritative timeline projection', () => {
  it('projects messages and every supported execution event in stable order', () => {
    const timeline = projectTimeline(snapshot, events);

    expect(timeline.map(({ id }) => id)).toEqual([
      'event:event-1',
      'message:message-user-1',
      'event:event-2',
      'event:event-3',
      'event:event-4',
      'event:event-5',
      'event:event-6',
      'event:event-7',
      'event:event-8',
      'message:message-assistant-1',
      'message:message-user-2',
      'event:event-9',
      'event:event-10',
      'event:event-11',
      'event:event-12',
      'message:message-user-3',
      'event:event-13',
      'event:event-14',
      'event:event-15',
    ]);
    expect(timeline.map(({ kind, status }) => `${kind}:${status}`)).toEqual([
      'generic-event:observed',
      'message:completed',
      'turn:queued',
      'model:started',
      'model:completed',
      'tool:started',
      'tool:succeeded',
      'tool:failed',
      'turn:succeeded',
      'message:completed',
      'message:completed',
      'turn:queued',
      'model:started',
      'model:failed',
      'turn:failed',
      'message:completed',
      'turn:queued',
      'turn:interrupted',
      'hidden:redacted',
    ]);
    expect(projectTimeline(snapshot, [...events].reverse())).toEqual(timeline);
  });

  it('takes final assistant content only from the persisted snapshot message', () => {
    const timeline = projectTimeline(snapshot, events);
    const assistant = timeline.find(
      (item) => item.kind === 'message' && item.role === 'assistant',
    );

    expect(assistant?.summary).toBe('Persisted assistant answer');
    expect(timeline.some(({ summary }) => summary === 'forged event answer')).toBe(
      false,
    );
  });

  it('keeps immutable inspector detail for visible and redacted items', () => {
    const timeline = projectTimeline(snapshot, events);
    const tool = timeline.find(({ id }) => id === 'event:event-5');
    const hidden = timeline.find(({ id }) => id === 'event:event-15');

    expect(tool?.detail).toMatchObject({
      source: 'event',
      event: {
        type: 'tool.started',
        payload: { toolId: 'fs.read_text', inputSummary: 'README.md' },
      },
    });
    expect(hidden).toMatchObject({
      kind: 'hidden',
      status: 'redacted',
      title: 'Hidden execution detail',
      detail: {
        source: 'redacted',
        event: { redacted: true, payload: null },
      },
    });
    expect(Object.isFrozen(timeline)).toBe(true);
    expect(timeline.every(Object.isFrozen)).toBe(true);
    expect(timeline.every(({ detail }) => Object.isFrozen(detail))).toBe(true);
  });

  it('projects every unmapped visible event as an immutable generic item', () => {
    const genericEvents = [
      visibleEvent(1, 'session.created', {
        payload: { workspaceId: 'workspace-1' },
      }),
      visibleEvent(2, 'turn.started', {
        turnId: 'turn-1',
        actor: 'runner',
        payload: { executionFence: 1 },
      }),
      visibleEvent(3, 'future.renderer_event', {
        turnId: 'turn-1',
        actor: 'user',
        payload: { summary: 'safe payload', nested: { count: 1 } },
      }),
    ];
    const timeline = projectTimeline(
      { ...snapshot, messages: [], turns: [], events: genericEvents, highWaterSeq: 3 },
      genericEvents,
    );

    expect(timeline.map(({ id, kind, status, title, summary }) => ({
      id,
      kind,
      status,
      title,
      summary,
    }))).toEqual([
      {
        id: 'event:event-1',
        kind: 'generic-event',
        status: 'observed',
        title: 'session.created',
        summary: 'daemon',
      },
      {
        id: 'event:event-2',
        kind: 'generic-event',
        status: 'observed',
        title: 'turn.started',
        summary: 'runner',
      },
      {
        id: 'event:event-3',
        kind: 'generic-event',
        status: 'observed',
        title: 'future.renderer_event',
        summary: 'user',
      },
    ]);
    expect(timeline[2]?.detail).toMatchObject({
      source: 'event',
      event: {
        type: 'future.renderer_event',
        actor: 'user',
        createdAt: timestamp(3),
        payload: { summary: 'safe payload', nested: { count: 1 } },
      },
    });
    expect(Object.isFrozen(timeline)).toBe(true);
    expect(timeline.every(Object.isFrozen)).toBe(true);
    const detail = timeline[2]?.detail;
    expect(Object.isFrozen(detail)).toBe(true);
    expect(detail?.source).toBe('event');
    if (!detail || detail.source !== 'event') throw new Error('Expected event detail');
    expect(Object.isFrozen(detail.event)).toBe(true);
    expect(Object.isFrozen(detail.event.payload)).toBe(true);
  });

  it('deduplicates exact event replays and preserves unique timeline item ids', () => {
    const replayedEvents = events.flatMap((event) => [
      event,
      structuredClone(event),
    ]);

    const timeline = projectTimeline(snapshot, replayedEvents);
    const baseline = projectTimeline(snapshot, events);
    const itemIds = timeline.map(({ id }) => id);

    expect(timeline).toEqual(baseline);
    expect(new Set(itemIds).size).toBe(itemIds.length);
  });

  it.each([
    [
      'the same seq has a different id',
      [
        visibleEvent(1, 'session.created'),
        { ...visibleEvent(1, 'session.created'), id: 'event-conflict' },
      ],
      EVENT_SEQUENCE_CONFLICT,
    ],
    [
      'the same id has different content',
      [
        visibleEvent(1, 'session.created', { payload: { revision: 1 } }),
        visibleEvent(1, 'session.created', { payload: { revision: 2 } }),
      ],
      EVENT_SEQUENCE_CONFLICT,
    ],
    [
      'the ordered event stream has a gap',
      [
        visibleEvent(1, 'session.created'),
        visibleEvent(3, 'turn.started'),
      ],
      EVENT_SEQUENCE_GAP,
    ],
  ])('fails closed when %s', (_name, projectionEvents, errorCode) => {
    expect(() =>
      projectTimeline(
        {
          ...snapshot,
          messages: [],
          turns: [],
        },
        projectionEvents,
      ),
    ).toThrow(errorCode);
  });
});

describe('incremental event pages', () => {
  const firstEvent = visibleEvent(1, 'session.created');
  const state = createEventPageState({
    ...snapshot,
    highWaterSeq: 1,
    events: [firstEvent],
  });
  const request: EventListAfterPayload = {
    sessionId: 'session-1',
    afterSeq: 1,
    limit: 2,
  };

  it('applies a continuous page immutably and advances across redacted events', () => {
    const page = {
      events: [redactedEvent(2), visibleEvent(3, 'turn.queued')],
      highWaterSeq: 3,
    };

    expect(() => checkEventPage(state, request, page)).not.toThrow();
    const next = applyEventPage(state, request, page);

    expect(next).toMatchObject({
      sessionId: 'session-1',
      cursor: 3,
      highWaterSeq: 3,
    });
    expect(next.events.map(({ seq, redacted }) => [seq, redacted])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect(state.cursor).toBe(1);
    expect(state.events).toHaveLength(1);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.events)).toBe(true);
  });

  it.each([
    [
      'wrong requested session',
      { ...request, sessionId: 'session-other' },
      { events: [visibleEvent(2, 'turn.queued')], highWaterSeq: 2 },
    ],
    [
      'stale request cursor',
      { ...request, afterSeq: 0 },
      { events: [visibleEvent(1, 'turn.queued')], highWaterSeq: 1 },
    ],
    [
      'invalid page limit',
      { ...request, limit: 0 },
      { events: [], highWaterSeq: 1 },
    ],
    [
      'high-water rollback',
      request,
      { events: [], highWaterSeq: 0 },
    ],
    [
      'duplicate sequence',
      request,
      { events: [visibleEvent(1, 'turn.queued')], highWaterSeq: 2 },
    ],
    [
      'sequence gap',
      request,
      { events: [visibleEvent(3, 'turn.queued')], highWaterSeq: 2 },
    ],
    [
      'wrong event session',
      request,
      {
        events: [
          { ...visibleEvent(2, 'turn.queued'), sessionId: 'session-other' },
        ],
        highWaterSeq: 2,
      },
    ],
    [
      'missing limited event',
      request,
      { events: [visibleEvent(2, 'turn.queued')], highWaterSeq: 3 },
    ],
  ])('throws the UI reset signal for %s', (_name, pageRequest, page) => {
    expect(() => checkEventPage(state, pageRequest, page)).toThrow(
      EVENT_SEQUENCE_GAP,
    );
    expect(() => applyEventPage(state, pageRequest, page)).toThrow(
      EVENT_SEQUENCE_GAP,
    );
  });
});
