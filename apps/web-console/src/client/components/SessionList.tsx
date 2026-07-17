import type { SessionRuntimeStatus, SessionSummary } from '@agent-workbench/protocol';

type SessionListError = 'initial' | 'refresh' | null;

type SessionListProps = Readonly<{
  daemonUnavailable: boolean;
  error: SessionListError;
  onSelect(sessionId: string): void;
  selectedSessionId: string | null;
  sessions: readonly SessionSummary[] | null;
}>;

const activeStatusLabels = new Map<SessionRuntimeStatus, string>([
  ['idle', 'Ready'],
  ['queued', 'Queued'],
  ['running', 'Running'],
  ['waiting_for_user', 'Waiting for input'],
  ['canceling', 'Canceling'],
  ['recovering', 'Recovering'],
  ['error', 'Error'],
]);

export const sessionStatusLabel = (
  session: Pick<SessionSummary, 'queuedTurnCount' | 'runtimeStatus'>,
  daemonUnavailable = false,
): string => {
  if (daemonUnavailable) return 'Unavailable';
  if (session.runtimeStatus === 'running' && session.queuedTurnCount > 0) {
    return `Running · ${session.queuedTurnCount} queued`;
  }
  return activeStatusLabels.get(session.runtimeStatus) ?? 'Unavailable';
};

const statusCount = (count: number, label: string): string => `${count} ${label}`;

export const sessionSummaryLabel = (
  sessions: readonly Pick<SessionSummary, 'runtimeStatus'>[],
): string => {
  const running = sessions.filter(({ runtimeStatus }) => runtimeStatus === 'running').length;
  const queued = sessions.filter(({ runtimeStatus }) => runtimeStatus === 'queued').length;
  const counts = [
    running > 0 ? statusCount(running, 'running') : null,
    queued > 0 ? statusCount(queued, 'queued') : null,
  ].filter((value): value is string => value !== null);
  return counts.length > 0 ? counts.join(' · ') : 'No active Sessions';
};

export function SessionList({
  daemonUnavailable,
  error,
  onSelect,
  selectedSessionId,
  sessions,
}: SessionListProps) {
  return (
    <section className="session-list" aria-label="Sessions">
      <div className="session-list-heading">
        <p className="navigation-label">Sessions</p>
        {sessions === null ? null : (
          <small>{sessionSummaryLabel(sessions)}</small>
        )}
      </div>

      {sessions === null ? (
        <p className="session-list-state" role={error === 'initial' ? 'alert' : undefined}>
          {error === 'initial' ? 'Couldn’t load Sessions.' : 'Loading Sessions…'}
        </p>
      ) : (
        <>
          {error === 'refresh' ? (
            <p className="session-list-refresh" role="status">
              Couldn’t refresh Sessions.
            </p>
          ) : null}
          {sessions.length === 0 ? (
            <div className="session-list-state">
              <p>No Sessions yet.</p>
              <p>Start a task to create one.</p>
            </div>
          ) : (
            <ol>
              {sessions.map((session) => {
                const status = sessionStatusLabel(session, daemonUnavailable);
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      aria-current={selectedSessionId === session.id ? 'page' : undefined}
                      className="session-row"
                      data-status={daemonUnavailable ? 'unavailable' : session.runtimeStatus}
                      onClick={() => onSelect(session.id)}
                    >
                      <span>{session.title}</span>
                      <small>{status}</small>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
