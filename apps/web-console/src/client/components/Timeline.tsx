import { useMemo } from 'react';

import type { TimelineItem } from '../view-model.js';

export type ToolPresentation = Readonly<{
  inputSummary: string | null;
  outputBytes: number | null;
  outputSummary: string | null;
  status: TimelineItem['status'];
  toolId: string;
  toolRunId: string | null;
}>;

export type ToolPresentationIndex = Readonly<{
  latestItemIds: ReadonlyMap<string, string>;
  presentations: ReadonlyMap<string, ToolPresentation>;
}>;

type TimelineProps = Readonly<{
  cancelStates: ReadonlyMap<string, CancelMutationDisplayState>;
  items: readonly TimelineItem[];
  onCancel(turnId: string): void;
  onSelect(item: TimelineItem): void;
  queuedTurns: ReadonlyMap<string, { readonly ordinal: number }>;
  runtimeReady: boolean;
  runtimeUnavailable: boolean;
  selectedItemId: string | null;
  toolPresentationIndex: ToolPresentationIndex;
}>;

export type CancelMutationDisplayState = Readonly<{
  status: 'pending' | 'error' | 'conflict';
}>;

const activeItemStatuses = new Set<TimelineItem['status']>([
  'queued',
  'started',
  'streaming',
]);

const eventPayload = (
  item: TimelineItem,
): Readonly<Record<string, unknown>> => {
  if (item.detail.source !== 'event' || item.detail.event.redacted) return {};
  const payload = item.detail.event.payload;
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    return {};
  }
  return payload;
};

const stringValue = (
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
};

const numberValue = (
  payload: Readonly<Record<string, unknown>>,
  key: string,
): number | null => {
  const value = payload[key];
  return typeof value === 'number' ? value : null;
};

const toolRunId = (item: TimelineItem): string | null => {
  if (item.kind !== 'tool' || item.detail.source !== 'event') return null;
  return (
    item.detail.event.toolRunId ??
    stringValue(eventPayload(item), 'toolRunId')
  );
};

const toolIndexKey = (item: TimelineItem): string | null => {
  if (item.kind !== 'tool') return null;
  return toolRunId(item) ?? item.id;
};

export const buildToolPresentationIndex = (
  items: readonly TimelineItem[],
): ToolPresentationIndex => {
  const latestItemIds = new Map<string, string>();
  const presentations = new Map<string, ToolPresentation>();

  for (const item of items) {
    const key = toolIndexKey(item);
    if (key === null) continue;
    const payload = eventPayload(item);
    const previous = presentations.get(key);
    presentations.set(key, {
      inputSummary:
        stringValue(payload, 'inputSummary') ??
        previous?.inputSummary ??
        null,
      outputBytes:
        numberValue(payload, 'outputBytes') ?? previous?.outputBytes ?? null,
      outputSummary:
        stringValue(payload, 'outputSummary') ??
        previous?.outputSummary ??
        null,
      status: item.status,
      toolId: stringValue(payload, 'toolId') ?? previous?.toolId ?? 'Unknown tool',
      toolRunId: toolRunId(item),
    });
    latestItemIds.set(key, item.id);
  }

  return Object.freeze({ latestItemIds, presentations });
};

export const getToolPresentation = (
  item: TimelineItem,
  index: ToolPresentationIndex,
): ToolPresentation | null => {
  const key = toolIndexKey(item);
  return key === null ? null : (index.presentations.get(key) ?? null);
};

const displayItems = (
  items: readonly TimelineItem[],
  index: ToolPresentationIndex,
): readonly TimelineItem[] =>
  items.filter((item) => {
    const key = toolIndexKey(item);
    return key === null || index.latestItemIds.get(key) === item.id;
  });

const modelText = (item: TimelineItem): string => {
  if (item.status === 'started') return 'Model is working';
  if (item.status === 'completed') return 'Model completed';
  if (item.status === 'failed') return 'Model failed';
  return item.title;
};

function TimelineIcon({ kind }: Readonly<{ kind: TimelineItem['kind'] }>) {
  if (kind === 'message') {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17">
        <path d="M4 4.5h12v8H9l-3.5 3v-3H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'tool') {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17">
        <path d="M12.6 3.4a4 4 0 0 0-4.8 4.8L3.5 12.5a1.8 1.8 0 0 0 2.5 2.5l4.3-4.3a4 4 0 0 0 4.8-4.8l-2.5 2.5-2-2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'model') {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17">
        <rect x="4" y="5" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10 2.5V5M7.5 9h.01M12.5 9h.01M7 12h6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17">
      <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 6.5v4l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function TimelineCard({
  cancelStates,
  item,
  onCancel,
  onSelect,
  queuedTurns,
  runtimeReady,
  runtimeUnavailable,
  selected,
  toolPresentationIndex,
}: Readonly<{
  cancelStates: ReadonlyMap<string, CancelMutationDisplayState>;
  item: TimelineItem;
  onCancel(turnId: string): void;
  onSelect(item: TimelineItem): void;
  queuedTurns: ReadonlyMap<string, { readonly ordinal: number }>;
  runtimeReady: boolean;
  runtimeUnavailable: boolean;
  selected: boolean;
  toolPresentationIndex: ToolPresentationIndex;
}>) {
  const tool = getToolPresentation(item, toolPresentationIndex);
  const showLastKnownState =
    runtimeUnavailable && activeItemStatuses.has(item.status);
  const displayedStatus = showLastKnownState
    ? 'Connection unavailable'
    : item.status;
  const label =
    tool === null
      ? `${showLastKnownState ? 'Last known state' : item.title} ${displayedStatus}`
      : `Tool ${tool.toolId} ${displayedStatus}`;
  const queuedTurn = item.kind === 'turn' && item.turnId !== null
    ? queuedTurns.get(item.turnId) ?? null
    : null;
  const cancelState = item.turnId === null ? null : cancelStates.get(item.turnId) ?? null;

  return (
    <article
      className="timeline-card"
      data-kind={item.kind}
      data-status={showLastKnownState ? 'unavailable' : item.status}
    >
      <button
        type="button"
        className="timeline-inspect"
        data-turn-inspect-id={item.kind === 'turn' ? item.turnId ?? undefined : undefined}
        aria-label={label}
        aria-pressed={selected}
        onClick={() => onSelect(item)}
      >
      {item.kind === 'message' ? (
        <>
          <span className="timeline-card-heading">
            <TimelineIcon kind={item.kind} />
            <strong>
              {showLastKnownState
                ? 'Last known state'
                : item.role === 'user'
                  ? 'You'
                  : 'Assistant'}
            </strong>
            {showLastKnownState ? (
              <span className="status-chip">Connection unavailable</span>
            ) : (
              <time dateTime={item.createdAt}>{item.createdAt}</time>
            )}
          </span>
          <span className="timeline-card-copy">{item.summary}</span>
        </>
      ) : null}

      {item.kind === 'model' ? (
        <>
          <span className="timeline-card-heading">
            <TimelineIcon kind={item.kind} />
            <strong>{showLastKnownState ? 'Last known state' : modelText(item)}</strong>
            <span className="status-chip">{displayedStatus}</span>
          </span>
          {item.summary === null ? null : (
            <code className="timeline-card-code">{item.summary}</code>
          )}
        </>
      ) : null}

      {tool === null ? null : (
        <>
          <span className="timeline-card-heading">
            <TimelineIcon kind={item.kind} />
            <strong>{tool.toolId}</strong>
            <span className="status-chip">{displayedStatus}</span>
          </span>
          {showLastKnownState ? (
            <span className="timeline-card-copy">Last known state</span>
          ) : null}
          {tool.inputSummary === null ? null : (
            <span className="timeline-detail-row">
              <span>Input</span>
              <span>{tool.inputSummary}</span>
            </span>
          )}
          {tool.outputSummary === null ? null : (
            <span className="timeline-detail-row">
              <span>Output</span>
              <span>{tool.outputSummary}</span>
            </span>
          )}
          {tool.outputBytes === null ? null : (
            <small>{tool.outputBytes} bytes returned</small>
          )}
          {item.status === 'failed' && item.summary !== null ? (
            <code className="timeline-card-code">{item.summary}</code>
          ) : null}
        </>
      )}

      {item.kind === 'turn' ? (
        <>
          <span className="timeline-card-heading">
            <TimelineIcon kind={item.kind} />
            <strong>{showLastKnownState ? 'Last known state' : item.title}</strong>
            <span className="status-chip">{displayedStatus}</span>
          </span>
          {item.summary === null ? null :
            item.status === 'failed' ? (
              <code className="timeline-card-code">{item.summary}</code>
            ) : (
              <span className="timeline-card-copy">{item.summary}</span>
            )}
        </>
      ) : null}

      {item.kind === 'generic-event' ? (
        <>
          <span className="timeline-card-heading">
            <TimelineIcon kind={item.kind} />
            <strong>{item.title}</strong>
            <span className="status-chip">event</span>
          </span>
          {item.summary === null ? null : (
            <span className="timeline-card-copy">Actor: {item.summary}</span>
          )}
        </>
      ) : null}

      {item.kind === 'hidden' ? (
        <span className="timeline-card-heading">
          <TimelineIcon kind={item.kind} />
          <strong>{item.title}</strong>
          <span className="status-chip">redacted</span>
        </span>
      ) : null}
      </button>

      {queuedTurn !== null || cancelState?.status === 'conflict' ? (
        <div className="timeline-card-actions">
          {cancelState?.status === 'conflict' ? (
            <p role="status">This turn started before it could be canceled.</p>
          ) : queuedTurn === null ? null : cancelState?.status === 'error' ? (
            <>
              <p role="alert">Couldn’t cancel this queued turn.</p>
              <button type="button" onClick={() => onCancel(item.turnId as string)}>
                Try again
              </button>
            </>
          ) : (
            <>
              {runtimeReady ? null : (
                <p id={`cancel-turn-${queuedTurn.ordinal}-unavailable`}>
                  Reconnect to cancel this queued turn.
                </p>
              )}
              <button
                type="button"
                aria-describedby={
                  runtimeReady ? undefined : `cancel-turn-${queuedTurn.ordinal}-unavailable`
                }
                aria-label={`Cancel queued Turn ${queuedTurn.ordinal}`}
                disabled={!runtimeReady || cancelState?.status === 'pending'}
                onClick={() => onCancel(item.turnId as string)}
              >
                {cancelState?.status === 'pending' ? 'Canceling…' : 'Cancel queued turn'}
              </button>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function Timeline({
  cancelStates,
  items,
  onCancel,
  onSelect,
  queuedTurns,
  runtimeReady,
  runtimeUnavailable,
  selectedItemId,
  toolPresentationIndex,
}: TimelineProps) {
  const visibleItems = useMemo(
    () => displayItems(items, toolPresentationIndex),
    [items, toolPresentationIndex],
  );

  return (
    <section
      className="timeline"
      aria-label="Session timeline"
      aria-atomic="false"
      aria-live={runtimeUnavailable ? 'off' : 'polite'}
      aria-relevant="additions text"
    >
      {visibleItems.length === 0 ? (
        <div className="timeline-empty">
          <h2>Describe the task you want to run.</h2>
          <p>Real model and tool activity will appear here.</p>
        </div>
      ) : (
        <ol>
          {visibleItems.map((item) => (
            <li key={item.id}>
              <TimelineCard
                cancelStates={cancelStates}
                item={item}
                onCancel={onCancel}
                onSelect={onSelect}
                queuedTurns={queuedTurns}
                runtimeReady={runtimeReady}
                runtimeUnavailable={runtimeUnavailable}
                selected={selectedItemId === item.id}
                toolPresentationIndex={toolPresentationIndex}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
