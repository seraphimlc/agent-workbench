import type { SessionRuntimeStatus, SessionSnapshot } from '@agent-workbench/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZodError } from 'zod';

import {
  ApiPublicError,
  type ApiClient,
  type MutationOperation,
} from './api.js';
import { Composer } from './components/Composer.js';
import { Inspector } from './components/Inspector.js';
import { NavigationRail } from './components/NavigationRail.js';
import { SessionHeader } from './components/SessionHeader.js';
import {
  Timeline,
  buildToolPresentationIndex,
  getToolPresentation,
} from './components/Timeline.js';
import {
  EventSequenceConflictError,
  EventSequenceGapError,
  applyEventPage,
  createEventPageState,
  projectTimeline,
  type EventPageState,
  type TimelineItem,
} from './view-model.js';

export const CURRENT_SESSION_STORAGE_KEY =
  'agent-workbench.currentSessionId';

export type PollIntervals = Readonly<{
  activeMs: number;
  idleMs: number;
}>;

type AppProps = Readonly<{
  api: ApiClient;
  pollIntervals?: PollIntervals;
  storage?: Storage;
}>;

type BootstrapState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly runtime: Awaited<ReturnType<ApiClient['getRuntime']>>;
    };

type SessionMutationContext = Readonly<{
  kind: 'session';
  operation: ReturnType<ApiClient['createSessionOperation']>;
  prompt: string;
}>;

type TurnMutationContext = Readonly<{
  kind: 'turn';
  operation: ReturnType<ApiClient['createTurnOperation']>;
  prompt: string;
  sessionId: string;
}>;

type MutationContext = SessionMutationContext | TurnMutationContext;

type MutationFailure = Readonly<{
  code: string | null;
  context: MutationContext;
  message: string;
  retryable: boolean;
}>;

const DEFAULT_POLL_INTERVALS: PollIntervals = {
  activeMs: 500,
  idleMs: 2_000,
};

const activeStatuses = new Set<SessionRuntimeStatus>([
  'queued',
  'running',
  'canceling',
  'recovering',
]);

const pollDelay = (
  status: SessionRuntimeStatus,
  intervals: PollIntervals,
): number => (activeStatuses.has(status) ? intervals.activeMs : intervals.idleMs);

const errorDetails = (
  error: unknown,
): Readonly<{ code: string | null; message: string; retryable: boolean }> => {
  if (error instanceof ApiPublicError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return { code: null, message: error.message, retryable: true };
  }
  return {
    code: null,
    message: 'The request could not be completed.',
    retryable: true,
  };
};

const isIncrementalResponseInvalid = (error: unknown): boolean =>
  error instanceof EventSequenceGapError ||
  error instanceof EventSequenceConflictError ||
  error instanceof SyntaxError ||
  error instanceof ZodError;

const readStoredSessionId = (storage: Storage): string | null => {
  try {
    const sessionId = storage.getItem(CURRENT_SESSION_STORAGE_KEY)?.trim();
    return sessionId && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
};

const storeSessionId = (storage: Storage, sessionId: string): void => {
  try {
    storage.setItem(CURRENT_SESSION_STORAGE_KEY, sessionId);
  } catch {
    return;
  }
};

const clearStoredSessionId = (storage: Storage): void => {
  try {
    storage.removeItem(CURRENT_SESSION_STORAGE_KEY);
  } catch {
    return;
  }
};

const isMissingSession = (error: unknown): boolean =>
  error instanceof ApiPublicError && error.status === 404;

export function App({
  api,
  pollIntervals = DEFAULT_POLL_INTERVALS,
  storage = window.localStorage,
}: AppProps) {
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrap, setBootstrap] = useState<BootstrapState>({
    status: 'loading',
  });
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [eventState, setEventState] = useState<EventPageState | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [mutationFailure, setMutationFailure] =
    useState<MutationFailure | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [composerResetSignal, setComposerResetSignal] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const inspectorTrigger = useRef<HTMLElement | null>(null);
  const mutationInFlight = useRef(false);
  const snapshotRef = useRef<SessionSnapshot | null>(null);
  const eventStateRef = useRef<EventPageState | null>(null);
  const stateGenerationRef = useRef(0);

  const adoptSnapshot = useCallback((nextSnapshot: SessionSnapshot): void => {
    const nextEventState = createEventPageState(nextSnapshot);
    stateGenerationRef.current += 1;
    snapshotRef.current = nextSnapshot;
    eventStateRef.current = nextEventState;
    setSnapshot(nextSnapshot);
    setEventState(nextEventState);
  }, []);

  const clearSession = useCallback((): void => {
    stateGenerationRef.current += 1;
    snapshotRef.current = null;
    eventStateRef.current = null;
    setSnapshot(null);
    setEventState(null);
    setSelectedItemId(null);
    setInspectorOpen(false);
    setPollError(null);
    setMutationFailure(null);
  }, []);

  useEffect(() => {
    const updateViewport = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    let canceled = false;
    setBootstrap({ status: 'loading' });
    setPollError(null);

    void (async () => {
      try {
        const runtime = await api.getRuntime();
        if (canceled) return;

        const storedSessionId = readStoredSessionId(storage);
        if (runtime.daemon.status === 'ready' && storedSessionId !== null) {
          try {
            const restoredSnapshot = await api.getSnapshot(storedSessionId);
            if (canceled) return;
            adoptSnapshot(restoredSnapshot);
          } catch (error) {
            if (!isMissingSession(error)) throw error;
            clearStoredSessionId(storage);
            clearSession();
          }
        } else {
          clearSession();
        }

        if (!canceled) setBootstrap({ status: 'ready', runtime });
      } catch {
        if (!canceled) {
          clearSession();
          setBootstrap({
            status: 'error',
            message: 'The local workbench could not connect.',
          });
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [adoptSnapshot, api, bootstrapAttempt, clearSession, storage]);

  const sessionId = snapshot?.session.id ?? null;

  useEffect(() => {
    if (
      bootstrap.status !== 'ready' ||
      bootstrap.runtime.daemon.status !== 'ready' ||
      sessionId === null
    ) {
      return;
    }

    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number): void => {
      if (canceled) return;
      timer = setTimeout(() => void poll(), delay);
    };

    const poll = async (): Promise<void> => {
      const currentSnapshot = snapshotRef.current;
      const currentEvents = eventStateRef.current;
      if (
        canceled ||
        currentSnapshot === null ||
        currentEvents === null ||
        currentSnapshot.session.id !== sessionId
      ) {
        return;
      }

      let nextDelay = pollDelay(
        currentSnapshot.session.runtimeStatus,
        pollIntervals,
      );
      const pollGeneration = stateGenerationRef.current;
      const generationChanged = (): boolean =>
        stateGenerationRef.current !== pollGeneration;
      const scheduleFromCurrentState = (): void => {
        const latestSnapshot = snapshotRef.current;
        if (latestSnapshot !== null && latestSnapshot.session.id === sessionId) {
          schedule(
            pollDelay(latestSnapshot.session.runtimeStatus, pollIntervals),
          );
        }
      };

      try {
        const request = {
          sessionId,
          afterSeq: currentEvents.cursor,
          limit: 100,
        } as const;
        let page: Awaited<ReturnType<ApiClient['getEvents']>>;
        let nextEvents: EventPageState;
        try {
          page = await api.getEvents(request);
          if (canceled) return;
          if (generationChanged()) {
            scheduleFromCurrentState();
            return;
          }
          nextEvents = applyEventPage(currentEvents, request, page);
        } catch (error) {
          if (generationChanged()) {
            scheduleFromCurrentState();
            return;
          }
          if (!isIncrementalResponseInvalid(error)) throw error;
          const resyncedSnapshot = await api.getSnapshot(sessionId);
          if (canceled) return;
          if (generationChanged()) {
            scheduleFromCurrentState();
            return;
          }
          adoptSnapshot(resyncedSnapshot);
          setPollError(null);
          nextDelay = pollDelay(
            resyncedSnapshot.session.runtimeStatus,
            pollIntervals,
          );
          schedule(nextDelay);
          return;
        }

        eventStateRef.current = nextEvents;
        setEventState(nextEvents);
        setPollError(null);

        if (page.events.length > 0) {
          const refreshedSnapshot = await api.getSnapshot(sessionId);
          if (canceled) return;
          if (generationChanged()) {
            scheduleFromCurrentState();
            return;
          }
          adoptSnapshot(refreshedSnapshot);
          nextDelay = pollDelay(
            refreshedSnapshot.session.runtimeStatus,
            pollIntervals,
          );
        }
      } catch (error) {
        if (generationChanged()) {
          scheduleFromCurrentState();
          return;
        }
        if (!canceled) setPollError(errorDetails(error).message);
        nextDelay = pollIntervals.idleMs;
      }

      schedule(nextDelay);
    };

    const currentSnapshot = snapshotRef.current;
    if (currentSnapshot !== null) {
      schedule(pollDelay(currentSnapshot.session.runtimeStatus, pollIntervals));
    }

    return () => {
      canceled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [adoptSnapshot, api, bootstrap, pollIntervals, sessionId]);

  const timeline = useMemo<readonly TimelineItem[]>(() => {
    if (snapshot === null || eventState === null) return [];
    return projectTimeline(snapshot, eventState.events);
  }, [eventState, snapshot]);

  const selectedItem = useMemo(
    () => timeline.find(({ id }) => id === selectedItemId) ?? null,
    [selectedItemId, timeline],
  );
  const toolPresentationIndex = useMemo(
    () => buildToolPresentationIndex(timeline),
    [timeline],
  );
  const selectedTool = useMemo(
    () =>
      selectedItem === null
        ? null
        : getToolPresentation(selectedItem, toolPresentationIndex),
    [selectedItem, toolPresentationIndex],
  );

  const completeMutation = useCallback(
    async (
      context: MutationContext,
      method: keyof MutationOperation<unknown>,
    ): Promise<boolean> => {
      if (mutationInFlight.current) return false;
      mutationInFlight.current = true;
      setMutationPending(true);
      setMutationFailure(null);

      try {
        if (context.kind === 'session') {
          const result = await context.operation[method]();
          storeSessionId(storage, result.sessionId);
          const nextSnapshot = await api.getSnapshot(result.sessionId);
          adoptSnapshot(nextSnapshot);
        } else {
          await context.operation[method]();
          const nextSnapshot = await api.getSnapshot(context.sessionId);
          adoptSnapshot(nextSnapshot);
        }
        setComposerResetSignal((value) => value + 1);
        setMutationFailure(null);
        return true;
      } catch (error) {
        const details = errorDetails(error);
        setMutationFailure({ ...details, context });
        return false;
      } finally {
        mutationInFlight.current = false;
        setMutationPending(false);
      }
    },
    [adoptSnapshot, api, storage],
  );

  const submitPrompt = useCallback(
    async (prompt: string): Promise<boolean> => {
      const currentSessionId = snapshotRef.current?.session.id;
      const context: MutationContext = currentSessionId
        ? {
            kind: 'turn',
            operation: api.createTurnOperation(currentSessionId, { prompt }),
            prompt,
            sessionId: currentSessionId,
          }
        : {
            kind: 'session',
            operation: api.createSessionOperation({ prompt }),
            prompt,
          };
      return completeMutation(context, 'execute');
    },
    [api, completeMutation],
  );

  const retryMutation = useCallback(async (): Promise<void> => {
    if (mutationFailure === null) return;
    await completeMutation(mutationFailure.context, 'retry');
  }, [completeMutation, mutationFailure]);

  const startNewTask = (): void => {
    if (mutationPending) return;
    clearStoredSessionId(storage);
    clearSession();
    setComposerResetSignal((value) => value + 1);
  };

  const selectTimelineItem = (item: TimelineItem): void => {
    inspectorTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSelectedItemId(item.id);
    setInspectorOpen(true);
  };

  const closeInspector = (): void => {
    setInspectorOpen(false);
    inspectorTrigger.current?.focus();
  };

  if (bootstrap.status === 'loading') {
    return (
      <main className="boot-state" aria-live="polite" aria-busy="true">
        <p>Connecting to local runtime…</p>
      </main>
    );
  }

  if (bootstrap.status === 'error') {
    return (
      <main className="boot-state">
        <section role="alert">
          <h1>Agent Workbench</h1>
          <p>{bootstrap.message}</p>
          <button
            type="button"
            onClick={() => setBootstrapAttempt((value) => value + 1)}
          >
            Retry connection
          </button>
        </section>
      </main>
    );
  }

  const daemonUnavailable = bootstrap.runtime.daemon.status !== 'ready';
  const runtimeUnavailable = daemonUnavailable || pollError !== null;
  const compactInspector = viewportWidth < 1_100;
  const inspectorPresentation =
    viewportWidth < 820
      ? 'drawer'
      : compactInspector
        ? 'overlay'
        : 'panel';

  return (
    <div className="workbench-shell">
      <a className="skip-link" href="#task-workspace">
        Skip to task workspace
      </a>
      <NavigationRail
        daemonStatus={bootstrap.runtime.daemon.status}
        newTaskDisabled={mutationPending}
        onNewTask={startNewTask}
        session={snapshot?.session ?? null}
        sessionStatusOverride={runtimeUnavailable ? 'disconnected' : null}
        workspaceName={bootstrap.runtime.workspace.name}
      />

      <main className="workspace-main" id="task-workspace" tabIndex={-1}>
        <SessionHeader
          compactInspector={compactInspector}
          inspectorOpen={inspectorOpen}
          modelId={bootstrap.runtime.provider.modelId}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
          session={snapshot?.session ?? null}
          statusOverride={runtimeUnavailable ? 'Unavailable' : null}
          workspaceName={bootstrap.runtime.workspace.name}
        />

        {runtimeUnavailable ? (
          <div
            className="runtime-status"
            role="status"
            aria-atomic="true"
            aria-live="polite"
          >
            <strong>
              {daemonUnavailable
                ? 'Runtime unavailable'
                : 'Live updates unavailable'}
            </strong>
            <span>
              {daemonUnavailable
                ? 'The local daemon is not ready.'
                : pollError}
            </span>
            {daemonUnavailable ? (
              <button
                type="button"
                onClick={() => setBootstrapAttempt((value) => value + 1)}
              >
                Retry connection
              </button>
            ) : null}
          </div>
        ) : null}

        <Timeline
          items={timeline}
          onSelect={selectTimelineItem}
          runtimeUnavailable={runtimeUnavailable}
          selectedItemId={selectedItemId}
          toolPresentationIndex={toolPresentationIndex}
        />

        <Composer
          disabled={runtimeUnavailable}
          error={mutationFailure}
          hasSession={snapshot !== null}
          onRetry={() => void retryMutation()}
          onSubmit={submitPrompt}
          pending={mutationPending}
          resetSignal={composerResetSignal}
        />
      </main>

      <Inspector
        item={selectedItem}
        onClose={closeInspector}
        open={!compactInspector || inspectorOpen}
        presentation={inspectorPresentation}
        tool={selectedTool}
      />
    </div>
  );
}
