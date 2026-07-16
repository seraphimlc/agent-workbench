import type { TimelineItem } from '../view-model.js';

export type ToolPresentation = Readonly<{
  inputSummary: string | null;
  outputBytes: number | null;
  outputSummary: string | null;
  status: TimelineItem['status'];
  toolId: string;
  toolRunId: string | null;
}>;

type TimelineProps = Readonly<{
  items: readonly TimelineItem[];
  onSelect(item: TimelineItem): void;
  selectedItemId: string | null;
}>;

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

export const getToolPresentation = (
  item: TimelineItem,
  items: readonly TimelineItem[],
): ToolPresentation | null => {
  if (item.kind !== 'tool') return null;
  const runId = toolRunId(item);
  const related = items.filter(
    (candidate) => candidate.kind === 'tool' && toolRunId(candidate) === runId,
  );
  let toolId = 'Unknown tool';
  let inputSummary: string | null = null;
  let outputSummary: string | null = null;
  let outputBytes: number | null = null;

  for (const candidate of related) {
    const payload = eventPayload(candidate);
    toolId = stringValue(payload, 'toolId') ?? toolId;
    inputSummary = stringValue(payload, 'inputSummary') ?? inputSummary;
    outputSummary = stringValue(payload, 'outputSummary') ?? outputSummary;
    outputBytes = numberValue(payload, 'outputBytes') ?? outputBytes;
  }

  return {
    inputSummary,
    outputBytes,
    outputSummary,
    status: item.status,
    toolId,
    toolRunId: runId,
  };
};

const displayItems = (items: readonly TimelineItem[]): readonly TimelineItem[] => {
  const latestToolByRun = new Map<string, number>();
  items.forEach((item, index) => {
    const runId = toolRunId(item);
    if (runId !== null) latestToolByRun.set(runId, index);
  });
  return items.filter((item, index) => {
    const runId = toolRunId(item);
    return runId === null || latestToolByRun.get(runId) === index;
  });
};

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
  item,
  items,
  onSelect,
  selected,
}: Readonly<{
  item: TimelineItem;
  items: readonly TimelineItem[];
  onSelect(item: TimelineItem): void;
  selected: boolean;
}>) {
  const tool = getToolPresentation(item, items);
  const label =
    tool === null
      ? `${item.title} ${item.status}`
      : `Tool ${tool.toolId} ${tool.status}`;

  return (
    <button
      type="button"
      className="timeline-card"
      aria-label={label}
      aria-pressed={selected}
      data-kind={item.kind}
      data-status={item.status}
      onClick={() => onSelect(item)}
    >
      {item.kind === 'message' ? (
        <>
          <span className="timeline-card-heading">
            <TimelineIcon kind={item.kind} />
            <strong>{item.role === 'user' ? 'You' : 'Assistant'}</strong>
            <time dateTime={item.createdAt}>{item.createdAt}</time>
          </span>
          <span className="timeline-card-copy">{item.summary}</span>
        </>
      ) : null}

      {item.kind === 'model' ? (
        <>
          <span className="timeline-card-heading">
            <TimelineIcon kind={item.kind} />
            <strong>{modelText(item)}</strong>
            <span className="status-chip">{item.status}</span>
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
            <span className="status-chip">{tool.status}</span>
          </span>
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
            <strong>{item.title}</strong>
            <span className="status-chip">{item.status}</span>
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
  );
}

export function Timeline({ items, onSelect, selectedItemId }: TimelineProps) {
  const visibleItems = displayItems(items);

  return (
    <section
      className="timeline"
      aria-label="Session timeline"
      aria-atomic="false"
      aria-live="polite"
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
                item={item}
                items={items}
                onSelect={onSelect}
                selected={selectedItemId === item.id}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
