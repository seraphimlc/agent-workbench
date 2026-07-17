import { useEffect, useRef } from 'react';
import type { SessionRow } from '@agent-workbench/protocol';

import { SessionList } from './SessionList.js';

type NavigationRailProps = Readonly<{
  currentSession: SessionRow | null;
  daemonStatus: 'ready' | 'unavailable';
  newTaskDisabled: boolean;
  onCloseSessions(): void;
  onNewTask(): void;
  onOpenSessions(): void;
  onSelectSession(sessionId: string): void;
  selectedSessionId: string | null;
  sessionDrawerOpen: boolean;
  sessionListError: 'initial' | 'refresh' | null;
  sessions: Parameters<typeof SessionList>[0]['sessions'];
  sessionStatusOverride: 'disconnected' | null;
  workspaceName: string;
}>;

const focusableSelector =
  'button:not([disabled]), [href], textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function NavigationRail({
  currentSession,
  daemonStatus,
  newTaskDisabled,
  onCloseSessions,
  onNewTask,
  onOpenSessions,
  onSelectSession,
  selectedSessionId,
  sessionDrawerOpen,
  sessionListError,
  sessions,
  sessionStatusOverride,
  workspaceName,
}: NavigationRailProps) {
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const daemonUnavailable = daemonStatus !== 'ready';

  useEffect(() => {
    if (!sessionDrawerOpen) return;
    const firstFocusable = drawerRef.current?.querySelector<HTMLElement>(
      focusableSelector,
    );
    (firstFocusable ?? drawerRef.current)?.focus();
  }, [sessionDrawerOpen]);

  const closeSessions = (): void => {
    onCloseSessions();
    triggerRef.current?.focus();
  };

  const trapDrawerFocus = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSessions();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
      focusableSelector,
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <>
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

        <button
          ref={triggerRef}
          type="button"
          className="sessions-trigger"
          aria-controls="sessions-drawer"
          aria-expanded={sessionDrawerOpen}
          onClick={onOpenSessions}
        >
          Sessions
        </button>

        <div className="desktop-session-list">
          <SessionList
            daemonUnavailable={daemonUnavailable}
            error={sessionListError}
            onSelect={onSelectSession}
            selectedSessionId={selectedSessionId}
            sessions={sessions}
          />
        </div>

        <section className="current-task" aria-label="Current task">
          <p className="navigation-label">Current task</p>
          <p className="current-task-title">
            {currentSession === null ? 'No active session' : `Current: ${currentSession.title}`}
          </p>
          {currentSession === null ? null : (
            <small data-status={sessionStatusOverride ?? currentSession.runtimeStatus}>
              Status: {sessionStatusOverride ?? currentSession.runtimeStatus.replaceAll('_', ' ')}
            </small>
          )}
        </section>
      </nav>

      {sessionDrawerOpen ? (
        <>
          <div className="drawer-backdrop" aria-hidden="true" onClick={closeSessions} />
          <aside
            ref={drawerRef}
            className="session-drawer"
            id="sessions-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Sessions"
            tabIndex={-1}
            onKeyDown={trapDrawerFocus}
          >
            <header>
              <h2>Sessions</h2>
              <button type="button" aria-label="Close Sessions" onClick={closeSessions}>
                <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
                  <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
              </button>
            </header>
            <SessionList
              daemonUnavailable={daemonUnavailable}
              error={sessionListError}
              onSelect={(sessionId) => {
                onSelectSession(sessionId);
                onCloseSessions();
              }}
              selectedSessionId={selectedSessionId}
              sessions={sessions}
            />
          </aside>
        </>
      ) : null}
    </>
  );
}
