import type { SessionRow } from '@agent-workbench/protocol';

type NavigationRailProps = Readonly<{
  daemonStatus: 'ready' | 'unavailable';
  newTaskDisabled: boolean;
  onNewTask(): void;
  session: SessionRow | null;
  sessionStatusOverride: 'disconnected' | null;
  workspaceName: string;
}>;

export function NavigationRail({
  daemonStatus,
  newTaskDisabled,
  onNewTask,
  session,
  sessionStatusOverride,
  workspaceName,
}: NavigationRailProps) {
  return (
    <nav className="navigation-rail" aria-label="Workspace navigation">
      <div className="brand-block">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24">
          <path
            d="M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z"
            fill="currentColor"
          />
          </svg>
        </span>
        <div>
          <strong>Agent Workbench</strong>
          <span>Local task workspace</span>
        </div>
      </div>

      <p className="daemon-state">
        <span aria-hidden="true" data-status={daemonStatus} />
        Daemon: {daemonStatus === 'ready' ? 'ready' : 'offline'}
      </p>

      <section aria-label="Workspace">
        <p className="navigation-label">Workspace</p>
        <p>{workspaceName}</p>
      </section>

      <button
        type="button"
        className="new-task-button"
        disabled={newTaskDisabled}
        onClick={onNewTask}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
          <path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span>New task</span>
      </button>

      <section className="current-task" aria-label="Current task">
        <p className="navigation-label">Current task</p>
        <p className="current-task-title">
          {session === null ? 'No active session' : `Current: ${session.title}`}
        </p>
        {session === null ? null : (
          <small data-status={sessionStatusOverride ?? session.runtimeStatus}>
            Status:{' '}
            {sessionStatusOverride ?? session.runtimeStatus.replaceAll('_', ' ')}
          </small>
        )}
      </section>
    </nav>
  );
}
