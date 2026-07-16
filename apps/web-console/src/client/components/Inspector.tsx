import { useEffect, useRef } from 'react';

import type { TimelineItem } from '../view-model.js';
import type { ToolPresentation } from './Timeline.js';

type InspectorProps = Readonly<{
  item: TimelineItem | null;
  onClose(): void;
  open: boolean;
  presentation: 'drawer' | 'overlay' | 'panel';
  tool: ToolPresentation | null;
}>;

const payloadJson = (item: TimelineItem): string | null => {
  if (item.detail.source !== 'event' || item.detail.event.redacted) return null;
  return JSON.stringify(item.detail.event.payload, null, 2);
};

export function Inspector({
  item,
  onClose,
  open,
  presentation,
  tool,
}: InspectorProps) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open || presentation !== 'drawer') return;
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (firstFocusable ?? panelRef.current)?.focus();
  }, [open, presentation]);

  if (!open) return null;

  const payload = item === null ? null : payloadJson(item);
  const drawer = presentation === 'drawer';

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && presentation !== 'panel') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || presentation !== 'drawer') return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (
      event.shiftKey &&
      (activeElement === first || activeElement === panelRef.current)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (
      !event.shiftKey &&
      (activeElement === last || activeElement === panelRef.current)
    ) {
      event.preventDefault();
      first?.focus();
    } else if (
      activeElement instanceof Node &&
      !panelRef.current?.contains(activeElement)
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  };

  return (
    <>
      {drawer ? (
        <div
          className="inspector-backdrop"
          aria-hidden="true"
          onClick={onClose}
        />
      ) : null}
      <aside
        ref={panelRef}
        className="inspector"
        data-presentation={presentation}
        id="timeline-inspector"
        role={drawer ? 'dialog' : undefined}
        aria-modal={drawer ? true : undefined}
        aria-labelledby="inspector-title"
        aria-describedby="inspector-description"
        tabIndex={drawer ? -1 : undefined}
        onKeyDown={handleKeyDown}
      >
        <header>
          <div>
            <p>Timeline detail</p>
            <h2 id="inspector-title">Inspector</h2>
          </div>
          {presentation === 'panel' ? null : (
            <button type="button" aria-label="Close inspector" onClick={onClose}>
              <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
                <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </header>

        {item === null ? (
          <p id="inspector-description">
            Select a Timeline item to inspect its authoritative details.
          </p>
        ) : (
          <div className="inspector-content">
            <p id="inspector-description" className="inspector-summary">
              Authoritative metadata for the selected {item.kind.replace('-', ' ')} item.
            </p>
            <dl>
              <dt>Type</dt>
              <dd>{item.title}</dd>
              <dt>Status</dt>
              <dd>{item.status}</dd>
              <dt>Created</dt>
              <dd>
                <time dateTime={item.createdAt}>{item.createdAt}</time>
              </dd>
              <dt>Turn</dt>
              <dd>{item.turnId ?? 'Session'}</dd>
              <dt>Sequence</dt>
              <dd>{item.seq ?? 'Snapshot message'}</dd>
              {tool === null ? null : (
                <>
                  <dt>Tool</dt>
                  <dd>{tool.toolId}</dd>
                  <dt>Tool run</dt>
                  <dd>{tool.toolRunId ?? 'Not available'}</dd>
                  <dt>Input</dt>
                  <dd>{tool.inputSummary ?? 'Not available'}</dd>
                  <dt>Output</dt>
                  <dd>{tool.outputSummary ?? 'Not available'}</dd>
                </>
              )}
            </dl>
            {payload === null ? null : (
              <section aria-labelledby="payload-title">
                <h3 id="payload-title">Payload</h3>
                <pre tabIndex={0} aria-label="Event payload">{payload}</pre>
              </section>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
