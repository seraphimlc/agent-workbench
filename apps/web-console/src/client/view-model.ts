import type {
  EventListAfterPayload,
  MessageRow,
  RendererSessionEventEnvelope,
  SessionSnapshot,
  TurnRow,
} from '@agent-workbench/protocol';

export const EVENT_SEQUENCE_GAP = 'EVENT_SEQUENCE_GAP';

export class EventSequenceGapError extends Error {
  readonly code = EVENT_SEQUENCE_GAP;

  constructor() {
    super(EVENT_SEQUENCE_GAP);
    this.name = 'EventSequenceGapError';
  }
}

export type TimelineItemKind =
  | 'message'
  | 'turn'
  | 'model'
  | 'tool'
  | 'generic-event'
  | 'hidden';

export type TimelineItemStatus =
  | MessageRow['status']
  | 'queued'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'observed'
  | 'redacted';

export type TimelineItemDetail =
  | {
      readonly source: 'message';
      readonly message: MessageRow;
      readonly turn: TurnRow;
    }
  | {
      readonly source: 'event';
      readonly event: RendererSessionEventEnvelope;
    }
  | {
      readonly source: 'redacted';
      readonly event: RendererSessionEventEnvelope;
    };

export type TimelineItem = Readonly<{
  id: string;
  kind: TimelineItemKind;
  status: TimelineItemStatus;
  role: 'user' | 'assistant' | null;
  title: string;
  summary: string | null;
  createdAt: string;
  turnId: string | null;
  seq: number | null;
  detail: TimelineItemDetail;
}>;

export type EventPage = Readonly<{
  events: readonly RendererSessionEventEnvelope[];
  highWaterSeq: number;
}>;

export type EventPageState = Readonly<{
  sessionId: string;
  cursor: number;
  highWaterSeq: number;
  events: readonly RendererSessionEventEnvelope[];
}>;

const cloneAndFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreeze(item))) as Value;
  }
  const clone = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)]),
  );
  return Object.freeze(clone) as Value;
};

const payloadRecord = (
  event: RendererSessionEventEnvelope,
): Readonly<Record<string, unknown>> => {
  if (
    event.redacted ||
    event.payload === null ||
    Array.isArray(event.payload) ||
    typeof event.payload !== 'object'
  ) {
    return {};
  }
  return event.payload;
};

const stringField = (
  event: RendererSessionEventEnvelope,
  key: string,
): string | null => {
  const value = payloadRecord(event)[key];
  return typeof value === 'string' ? value : null;
};

const numberField = (
  event: RendererSessionEventEnvelope,
  key: string,
): number | null => {
  const value = payloadRecord(event)[key];
  return typeof value === 'number' ? value : null;
};

const joinedSummary = (...parts: readonly (string | null)[]): string | null => {
  const summary = parts.filter((part): part is string => part !== null).join(' · ');
  return summary.length > 0 ? summary : null;
};

const eventSummary = (event: RendererSessionEventEnvelope): string | null => {
  switch (event.type) {
    case 'turn.queued': {
      const ordinal = numberField(event, 'ordinal');
      return ordinal === null ? null : `Turn ${ordinal}`;
    }
    case 'turn.failed':
    case 'model.failed':
    case 'tool.failed':
      return stringField(event, 'errorCode');
    case 'turn.interrupted':
      return stringField(event, 'reason');
    case 'model.started':
    case 'model.completed':
      return stringField(event, 'modelCallId');
    case 'tool.started':
      return joinedSummary(
        stringField(event, 'toolId'),
        stringField(event, 'inputSummary'),
      );
    case 'tool.succeeded': {
      const outputBytes = numberField(event, 'outputBytes');
      return joinedSummary(
        stringField(event, 'outputSummary'),
        outputBytes === null ? null : `${outputBytes} bytes`,
      );
    }
    default:
      return null;
  }
};

const itemFromMessage = (message: MessageRow, turn: TurnRow): TimelineItem =>
  Object.freeze({
    id: `message:${message.id}`,
    kind: 'message',
    status: message.status,
    role: message.role === 'user' ? 'user' : 'assistant',
    title: message.role === 'user' ? 'You' : 'Assistant',
    summary: message.content,
    createdAt: message.createdAt,
    turnId: message.turnId,
    seq: null,
    detail: cloneAndFreeze({ source: 'message', message, turn } as const),
  });

const itemFromEvent = (
  event: RendererSessionEventEnvelope,
): TimelineItem => {
  if (event.redacted) {
    return Object.freeze({
      id: `event:${event.id}`,
      kind: 'hidden',
      status: 'redacted',
      role: null,
      title: 'Hidden execution detail',
      summary: null,
      createdAt: event.createdAt,
      turnId: event.turnId,
      seq: event.seq,
      detail: cloneAndFreeze({ source: 'redacted', event } as const),
    });
  }

  const display = {
    'turn.queued': ['turn', 'queued', 'Turn queued'],
    'turn.succeeded': ['turn', 'succeeded', 'Turn succeeded'],
    'turn.failed': ['turn', 'failed', 'Turn failed'],
    'turn.interrupted': ['turn', 'interrupted', 'Turn interrupted'],
    'model.started': ['model', 'started', 'Model started'],
    'model.completed': ['model', 'completed', 'Model completed'],
    'model.failed': ['model', 'failed', 'Model failed'],
    'tool.started': ['tool', 'started', 'Tool started'],
    'tool.succeeded': ['tool', 'succeeded', 'Tool succeeded'],
    'tool.failed': ['tool', 'failed', 'Tool failed'],
  } as const;
  const selected = display[event.type as keyof typeof display];
  if (!selected) {
    return Object.freeze({
      id: `event:${event.id}`,
      kind: 'generic-event',
      status: 'observed',
      role: null,
      title: event.type,
      summary: event.actor,
      createdAt: event.createdAt,
      turnId: event.turnId,
      seq: event.seq,
      detail: cloneAndFreeze({ source: 'event', event } as const),
    });
  }
  const [kind, status, title] = selected;

  return Object.freeze({
    id: `event:${event.id}`,
    kind,
    status,
    role: null,
    title,
    summary: eventSummary(event),
    createdAt: event.createdAt,
    turnId: event.turnId,
    seq: event.seq,
    detail: cloneAndFreeze({ source: 'event', event } as const),
  });
};

const terminalTurnEvents = new Set([
  'turn.succeeded',
  'turn.failed',
  'turn.interrupted',
]);

export const projectTimeline = (
  snapshot: SessionSnapshot,
  rendererEvents: readonly RendererSessionEventEnvelope[] = snapshot.events,
): readonly TimelineItem[] => {
  const turns = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
  const messages = new Map(
    snapshot.messages.map((message) => [message.id, message]),
  );
  const placedMessages = new Set<string>();
  const items: TimelineItem[] = [];

  const appendMessage = (messageId: string | null | undefined): void => {
    if (!messageId || placedMessages.has(messageId)) return;
    const message = messages.get(messageId);
    const turn = message ? turns.get(message.turnId) : undefined;
    if (
      !message ||
      !turn ||
      (message.role !== 'user' && message.role !== 'assistant')
    ) {
      return;
    }
    placedMessages.add(messageId);
    items.push(itemFromMessage(message, turn));
  };

  const orderedEvents = [...rendererEvents].sort(
    (left, right) => left.seq - right.seq || left.id.localeCompare(right.id),
  );
  for (const event of orderedEvents) {
    const turn = event.turnId ? turns.get(event.turnId) : undefined;
    if (event.type === 'turn.queued') appendMessage(turn?.inputMessageId);

    items.push(itemFromEvent(event));

    if (terminalTurnEvents.has(event.type)) {
      appendMessage(turn?.resultMessageId);
    }
  }

  for (const turn of [...snapshot.turns].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    appendMessage(turn.inputMessageId);
    appendMessage(turn.resultMessageId);
  }

  return Object.freeze(items);
};

const failSequenceCheck = (): never => {
  throw new EventSequenceGapError();
};

const checkState = (state: EventPageState): void => {
  if (
    !Number.isInteger(state.cursor) ||
    state.cursor < 0 ||
    !Number.isInteger(state.highWaterSeq) ||
    state.highWaterSeq < state.cursor ||
    state.events.length !== state.cursor
  ) {
    failSequenceCheck();
  }
  state.events.forEach((event, index) => {
    if (event.sessionId !== state.sessionId || event.seq !== index + 1) {
      failSequenceCheck();
    }
  });
};

export const createEventPageState = (
  snapshot: Pick<SessionSnapshot, 'session' | 'highWaterSeq' | 'events'>,
): EventPageState => {
  const state = cloneAndFreeze({
    sessionId: snapshot.session.id,
    cursor: snapshot.highWaterSeq,
    highWaterSeq: snapshot.highWaterSeq,
    events: snapshot.events,
  });
  checkState(state);
  return state;
};

export const checkEventPage = (
  state: EventPageState,
  request: EventListAfterPayload,
  page: EventPage,
): void => {
  checkState(state);
  if (
    request.sessionId !== state.sessionId ||
    !Number.isInteger(request.afterSeq) ||
    request.afterSeq !== state.cursor ||
    !Number.isInteger(request.limit) ||
    request.limit <= 0 ||
    !Number.isInteger(page.highWaterSeq) ||
    page.highWaterSeq < state.highWaterSeq ||
    page.highWaterSeq < state.cursor
  ) {
    failSequenceCheck();
  }

  const available = page.highWaterSeq - state.cursor;
  const expectedCount = Math.min(request.limit, available);
  if (page.events.length !== expectedCount) failSequenceCheck();

  page.events.forEach((event, index) => {
    if (
      event.sessionId !== state.sessionId ||
      event.seq !== state.cursor + index + 1
    ) {
      failSequenceCheck();
    }
  });
};

export const applyEventPage = (
  state: EventPageState,
  request: EventListAfterPayload,
  page: EventPage,
): EventPageState => {
  checkEventPage(state, request, page);
  const lastEvent = page.events.at(-1);
  return cloneAndFreeze({
    sessionId: state.sessionId,
    cursor: lastEvent?.seq ?? state.cursor,
    highWaterSeq: page.highWaterSeq,
    events: [...state.events, ...page.events],
  });
};
