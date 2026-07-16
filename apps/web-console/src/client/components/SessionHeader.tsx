import type { SessionRow } from '@agent-workbench/protocol';

type SessionHeaderProps = Readonly<{
  compactInspector: boolean;
  inspectorOpen: boolean;
  modelId: string;
  onToggleInspector(): void;
  session: SessionRow | null;
  workspaceName: string;
}>;

const statusLabel = (status: SessionRow['runtimeStatus']): string =>
  status.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());

export function SessionHeader({
  compactInspector,
  inspectorOpen,
  modelId,
  onToggleInspector,
  session,
  workspaceName,
}: SessionHeaderProps) {
  return (
    <header className="session-header">
      <div>
        <p>Workspace · {workspaceName}</p>
        <h1>{session?.title || 'New task'}</h1>
      </div>
      <div className="session-header-actions">
        <ul className="session-metadata" aria-label="Session configuration">
          <li className="model-pill" title={`Selected model: ${modelId}`}>
            <svg aria-hidden="true" viewBox="0 0 20 20" width="15" height="15">
              <path d="M10 2.75 16 6v8l-6 3.25L4 14V6z" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="m4.5 6.3 5.5 3 5.5-3M10 9.5v7" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <span>{modelId}</span>
          </li>
          <li>Craft</li>
          <li>Full Access</li>
          <li
            className="session-status-pill"
            data-status={session?.runtimeStatus ?? 'idle'}
          >
            <span aria-hidden="true" />
            {session === null ? 'Ready' : statusLabel(session.runtimeStatus)}
          </li>
        </ul>
        {compactInspector ? (
          <button
            type="button"
            className="inspector-toggle"
            aria-controls="timeline-inspector"
            aria-expanded={inspectorOpen}
            onClick={onToggleInspector}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17">
              <rect x="2.5" y="3" width="15" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M12.5 3v14" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
            <span>{inspectorOpen ? 'Hide inspector' : 'Open inspector'}</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}
