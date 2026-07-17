import type {
  SessionRuntimeStatus,
  SessionSnapshot,
  SessionSummary,
  TurnRow,
} from '@agent-workbench/protocol';
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
  type CancelMutationDisplayState,
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
  runtimeMs?: number;
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

type SessionViewState = 'empty' | 'loading' | 'ready' | 'error';

type CancelMutationState = Readonly<{
  operation: ReturnType<ApiClient['createCancelTurnOperation']>;
  status: 'pending' | 'error' | 'conflict';
}>;

const DEFAULT_POLL_INTERVALS: PollIntervals = {
  activeMs: 500,
  idleMs: 2_000,
  runtimeMs: 1_000,
};

const activeStatuses = new Set<SessionRuntimeStatus>([
  'queued',
  'running',
  'canceling',
  'recovering',
]);

const runtimeInfoEqual = (
  left: Awaited<ReturnType<ApiClient['getRuntime']>>,
  right: Awaited<ReturnType<ApiClient['getRuntime']>>,
): boolean =>
  left.daemon.status === right.daemon.status &&
  left.daemon.protocolVersion === right.daemon.protocolVersion &&
  left.daemon.pid === right.daemon.pid &&
  left.provider.baseHost === right.provider.baseHost &&
  left.provider.modelId === right.provider.modelId &&
  left.workspace.name === right.workspace.name;

const pollDelay = (
  status: SessionRuntimeStatus,
  intervals: PollIntervals,
): number => (activeStatuses.has(status) ? intervals.activeMs : intervals.idleMs);

const sessionListPollDelay = (
  sessions: readonly SessionSummary[] | null,
  intervals: PollIntervals,
): number =>
  sessions?.some(({ runtimeStatus }) => activeStatuses.has(runtimeStatus))
    ? intervals.activeMs
    : intervals.idleMs;

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
  const [sessions, setSessions] = useState<readonly SessionSummary[] | null>(null);
  const [sessionListError, setSessionListError] = useState<
    'initial' | 'refresh' | null
  >(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionViewState, setSessionViewState] = useState<SessionViewState>('empty');
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [eventState, setEventState] = useState<EventPageState | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [mutationFailure, setMutationFailure] = useState<MutationFailure | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [cancelMutations, setCancelMutations] = useState<
    ReadonlyMap<string, CancelMutationState>
  >(new Map());
  const [composerResetSignal, setComposerResetSignal] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [inspectorOverlayOpen, setInspectorOverlayOpen] = useState(false);
  const [activeDrawer, setActiveDrawer] = useState<
    'sessions' | 'inspector' | null
  >(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const inspectorTrigger = useRef<HTMLElement | null>(null);
  const sessionTitleRef = useRef<HTMLHeadingElement>(null);
  const mutationInFlight = useRef(false);
  const snapshotRef = useRef<SessionSnapshot | null>(null);
  const eventStateRef = useRef<EventPageState | null>(null);
  const stateGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const selectedSessionIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<readonly SessionSummary[] | null>(null);
  const sessionListRequestRef = useRef(0);
  const sessionListSuccessRef = useRef(0);
  const runtimeLifecycleGenerationRef = useRef(0);
  const cancelOperationsRef = useRef(
    new Map<string, ReturnType<ApiClient['createCancelTurnOperation']>>(),
  );

  const adoptSnapshot = useCallback((nextSnapshot: SessionSnapshot): void => {
    const nextEventState = createEventPageState(nextSnapshot);
    stateGenerationRef.current += 1;
    snapshotRef.current = nextSnapshot;
    eventStateRef.current = nextEventState;
    setSnapshot(nextSnapshot);
    setEventState(nextEventState);
    setSessionViewState('ready');
  }, []);

  const clearAdoptedSession = useCallback((): void => {
    stateGenerationRef.current += 1;
    snapshotRef.current = null;
    eventStateRef.current = null;
    setSnapshot(null);
    setEventState(null);
    setSelectedItemId(null);
    setInspectorOverlayOpen(false);
    setPollError(null);
    setMutationFailure(null);
  }, []);

  const refreshSessions = useCallback(async (
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    const requestId = ++sessionListRequestRef.current;
    try {
      const result = await api.listSessions();
      if (!isCurrent() || requestId < sessionListSuccessRef.current) return;
      sessionListSuccessRef.current = requestId;
      sessionsRef.current = result.sessions;
      setSessions(result.sessions);
      setSessionListError(null);
    } catch {
      if (!isCurrent() || requestId < sessionListSuccessRef.current) return;
      setSessionListError(sessionsRef.current === null ? 'initial' : 'refresh');
    }
  }, [api]);

  const openSession = useCallback(
    async (
      sessionId: string,
      clearMissing = false,
      isCurrent: () => boolean = () => true,
    ): Promise<boolean> => {
      if (!isCurrent()) return true;
      const selectionGeneration = ++selectionGenerationRef.current;
      selectedSessionIdRef.current = sessionId;
      setSelectedSessionId(sessionId);
      storeSessionId(storage, sessionId);
      clearAdoptedSession();
      setSessionViewState('loading');

      try {
        const nextSnapshot = await api.getSnapshot(sessionId);
        if (
          !isCurrent() ||
          selectionGeneration !== selectionGenerationRef.current ||
          selectedSessionIdRef.current !== sessionId
        ) {
          return true;
        }
        adoptSnapshot(nextSnapshot);
        return true;
      } catch (error) {
        if (
          !isCurrent() ||
          selectionGeneration !== selectionGenerationRef.current ||
          selectedSessionIdRef.current !== sessionId
        ) {
          return true;
        }
        if (clearMissing && isMissingSession(error)) {
          selectedSessionIdRef.current = null;
          setSelectedSessionId(null);
          clearStoredSessionId(storage);
          clearAdoptedSession();
          setSessionViewState('empty');
          return true;
        }
        setSessionViewState('error');
        return false;
      }
    },
    [adoptSnapshot, api, clearAdoptedSession, storage],
  );

  useEffect(() => {
    const updateViewport = (): void => {
      setViewportWidth(window.innerWidth);
      if (window.innerWidth >= 820) setActiveDrawer(null);
    };
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const lifecycleGeneration = ++runtimeLifecycleGenerationRef.current;
    const isCurrent = (): boolean =>
      !controller.signal.aborted &&
      runtimeLifecycleGenerationRef.current === lifecycleGeneration;
    setBootstrap({ status: 'loading' });
    setSessionListError(null);
    sessionsRef.current = null;
    setSessions(null);

    void (async () => {
      try {
        const runtime = await api.getRuntime();
        if (!isCurrent()) return;
        if (runtime.daemon.status === 'ready') {
          void refreshSessions(isCurrent);
          const storedSessionId = readStoredSessionId(storage);
          if (storedSessionId !== null) {
            await openSession(storedSessionId, true, isCurrent);
          } else {
            if (!isCurrent()) return;
            clearAdoptedSession();
            setSessionViewState('empty');
          }
        } else {
          if (!isCurrent()) return;
          clearAdoptedSession();
          setSessionViewState('empty');
        }
        if (isCurrent()) setBootstrap({ status: 'ready', runtime });
      } catch {
        if (isCurrent()) {
          clearAdoptedSession();
          setSessionViewState('empty');
          setBootstrap({
            status: 'error',
            message: 'The local workbench could not connect.',
          });
        }
      }
    })();

    return () => {
      controller.abort();
      if (runtimeLifecycleGenerationRef.current === lifecycleGeneration) {
        runtimeLifecycleGenerationRef.current += 1;
      }
    };
  }, [api, bootstrapAttempt, clearAdoptedSession, openSession, refreshSessions, storage]);

  useEffect(() => {
    if (bootstrap.status !== 'ready') return;
    const controller = new AbortController();
    const lifecycleGeneration = runtimeLifecycleGenerationRef.current;
    const isCurrent = (): boolean =>
      !controller.signal.aborted &&
      runtimeLifecycleGenerationRef.current === lifecycleGeneration;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const runtimeDelay = Math.max(
      1,
      pollIntervals.runtimeMs ?? DEFAULT_POLL_INTERVALS.runtimeMs ?? 1_000,
    );

    const schedule = (): void => {
      if (isCurrent()) timer = setTimeout(() => void heartbeat(), runtimeDelay);
    };

    const heartbeat = async (): Promise<void> => {
      let nextRuntime: Awaited<ReturnType<ApiClient['getRuntime']>> | null = null;
      let recoveryFailed = false;
      try {
        nextRuntime = await api.getRuntime();
      } catch {
        nextRuntime = null;
      }
      if (!isCurrent()) return;
      if (nextRuntime?.daemon.status === 'ready' && snapshotRef.current === null) {
        const storedSessionId = readStoredSessionId(storage);
        if (storedSessionId !== null) {
          recoveryFailed = !(await openSession(storedSessionId, true, isCurrent));
        }
      }
      if (!isCurrent()) return;
      setBootstrap((current) => {
        if (current.status !== 'ready') return current;
        const runtime =
          recoveryFailed
            ? ({
                ...current.runtime,
                daemon: { status: 'unavailable', protocolVersion: null, pid: null },
              } as const)
            : nextRuntime ??
          ({
            ...current.runtime,
            daemon: { status: 'unavailable', protocolVersion: null, pid: null },
          } as const);
        return runtimeInfoEqual(current.runtime, runtime)
          ? current
          : { status: 'ready', runtime };
      });
      schedule();
    };

    schedule();
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [api, bootstrap.status, openSession, pollIntervals.runtimeMs, storage]);

  useEffect(() => {
    if (bootstrap.status !== 'ready' || bootstrap.runtime.daemon.status !== 'ready') {
      return;
    }
    const controller = new AbortController();
    const isCurrent = (): boolean => !controller.signal.aborted;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      await refreshSessions(isCurrent);
      if (isCurrent()) schedule();
    };
    const schedule = (): void => {
      if (!isCurrent()) return;
      timer = setTimeout(
        () => void poll(),
        sessionListPollDelay(sessionsRef.current, pollIntervals),
      );
    };
    schedule();
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [bootstrap, pollIntervals, refreshSessions]);

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
      if (!canceled) timer = setTimeout(() => void poll(), delay);
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
      let nextDelay = pollDelay(currentSnapshot.session.runtimeStatus, pollIntervals);
      const pollGeneration = stateGenerationRef.current;
      const generationChanged = (): boolean => stateGenerationRef.current !== pollGeneration;
      const scheduleFromCurrentState = (): void => {
        const latestSnapshot = snapshotRef.current;
        if (latestSnapshot?.session.id === sessionId) {
          schedule(pollDelay(latestSnapshot.session.runtimeStatus, pollIntervals));
        }
      };
      try {
        const request = { sessionId, afterSeq: currentEvents.cursor, limit: 100 } as const;
        let page: Awaited<ReturnType<ApiClient['getEvents']>>;
        let nextEvents: EventPageState;
        try {
          page = await api.getEvents(request);
          if (canceled || generationChanged()) {
            if (!canceled) scheduleFromCurrentState();
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
          if (canceled || generationChanged()) {
            if (!canceled) scheduleFromCurrentState();
            return;
          }
          adoptSnapshot(resyncedSnapshot);
          void refreshSessions();
          setPollError(null);
          schedule(pollDelay(resyncedSnapshot.session.runtimeStatus, pollIntervals));
          return;
        }
        eventStateRef.current = nextEvents;
        setEventState(nextEvents);
        setPollError(null);
        if (page.events.length > 0) {
          const refreshedSnapshot = await api.getSnapshot(sessionId);
          if (canceled || generationChanged()) {
            if (!canceled) scheduleFromCurrentState();
            return;
          }
          adoptSnapshot(refreshedSnapshot);
          void refreshSessions();
          nextDelay = pollDelay(refreshedSnapshot.session.runtimeStatus, pollIntervals);
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
    if (snapshotRef.current !== null) {
      schedule(pollDelay(snapshotRef.current.session.runtimeStatus, pollIntervals));
    }
    return () => {
      canceled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [adoptSnapshot, api, bootstrap, pollIntervals, refreshSessions, sessionId]);

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
  const queuedTurns = useMemo(
    () =>
      new Map<string, TurnRow>(
        (snapshot?.turns ?? [])
          .filter((turn) => turn.status === 'queued')
          .map((turn) => [turn.id, turn]),
      ),
    [snapshot],
  );
  const cancelDisplayStates = useMemo<ReadonlyMap<string, CancelMutationDisplayState>>(
    () =>
      new Map(
        [...cancelMutations.entries()].map(([turnId, state]) => [
          turnId,
          { status: state.status },
        ]),
      ),
    [cancelMutations],
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
          await openSession(result.sessionId);
        } else {
          await context.operation[method]();
          const selectionGeneration = selectionGenerationRef.current;
          const nextSnapshot = await api.getSnapshot(context.sessionId);
          if (
            selectionGeneration === selectionGenerationRef.current &&
            selectedSessionIdRef.current === context.sessionId
          ) {
            adoptSnapshot(nextSnapshot);
          }
        }
        await refreshSessions();
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
    [adoptSnapshot, api, openSession, refreshSessions],
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
    if (mutationFailure !== null) {
      await completeMutation(mutationFailure.context, 'retry');
    }
  }, [completeMutation, mutationFailure]);

  const cancelTurn = useCallback(
    async (turnId: string): Promise<void> => {
      const currentSnapshot = snapshotRef.current;
      if (
        currentSnapshot === null ||
        bootstrap.status !== 'ready' ||
        bootstrap.runtime.daemon.status !== 'ready' ||
        pollError !== null ||
        !queuedTurns.has(turnId)
      ) {
        return;
      }
      const sessionId = currentSnapshot.session.id;
      const existing = cancelMutations.get(turnId);
      const operation =
        existing?.operation ??
        cancelOperationsRef.current.get(turnId) ??
        api.createCancelTurnOperation(sessionId, turnId);
      cancelOperationsRef.current.set(turnId, operation);
      setCancelMutations((current) =>
        new Map(current).set(turnId, { operation, status: 'pending' }),
      );
      const selectionGeneration = selectionGenerationRef.current;
      try {
        await operation[existing?.status === 'error' ? 'retry' : 'execute']();
        const nextSnapshot = await api.getSnapshot(sessionId);
        if (
          selectionGeneration === selectionGenerationRef.current &&
          selectedSessionIdRef.current === sessionId
        ) {
          adoptSnapshot(nextSnapshot);
          setCancelMutations((current) => {
            const next = new Map(current);
            next.delete(turnId);
            return next;
          });
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLButtonElement>(
                `[data-turn-inspect-id="${turnId}"]`,
              )
              ?.focus(),
          );
        }
        await refreshSessions();
      } catch (error) {
        const details = errorDetails(error);
        const conflict = details.code === 'TURN_NOT_CANCELLABLE';
        setCancelMutations((current) =>
          new Map(current).set(turnId, {
            operation,
            status: conflict ? 'conflict' : 'error',
          }),
        );
        if (conflict) {
          try {
            const nextSnapshot = await api.getSnapshot(sessionId);
            if (
              selectionGeneration === selectionGenerationRef.current &&
              selectedSessionIdRef.current === sessionId
            ) {
              adoptSnapshot(nextSnapshot);
            }
          } catch {
            await refreshSessions();
            return;
          }
          await refreshSessions();
        }
      }
    },
    [
      adoptSnapshot,
      api,
      bootstrap,
      cancelMutations,
      pollError,
      queuedTurns,
      refreshSessions,
    ],
  );

  const startNewTask = (): void => {
    if (mutationPending) return;
    selectionGenerationRef.current += 1;
    selectedSessionIdRef.current = null;
    setSelectedSessionId(null);
    clearStoredSessionId(storage);
    clearAdoptedSession();
    setSessionViewState('empty');
    setActiveDrawer(null);
    setComposerResetSignal((value) => value + 1);
  };

  const selectSession = (nextSessionId: string): void => {
    void openSession(nextSessionId);
    if (viewportWidth < 820) {
      sessionTitleRef.current?.focus();
    }
  };

  const selectTimelineItem = (item: TimelineItem): void => {
    inspectorTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedItemId(item.id);
    if (viewportWidth < 820) setActiveDrawer('inspector');
    else setInspectorOverlayOpen(true);
  };

  const closeInspector = (): void => {
    if (viewportWidth < 820) setActiveDrawer(null);
    else setInspectorOverlayOpen(false);
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
          <button type="button" onClick={() => setBootstrapAttempt((value) => value + 1)}>
            Retry connection
          </button>
        </section>
      </main>
    );
  }

  const daemonUnavailable = bootstrap.runtime.daemon.status !== 'ready';
  const runtimeUnavailable = daemonUnavailable || pollError !== null;
  const narrowViewport = viewportWidth < 820;
  const compactInspector = viewportWidth < 1_100;
  const inspectorPresentation = narrowViewport
    ? 'drawer'
    : compactInspector
      ? 'overlay'
      : 'panel';
  const inspectorOpen = !compactInspector
    ? true
    : narrowViewport
      ? activeDrawer === 'inspector'
      : inspectorOverlayOpen;
  const selectedSummary = sessions?.find(({ id }) => id === selectedSessionId) ?? null;
  const sessionStatus = selectedSummary?.runtimeStatus ?? snapshot?.session.runtimeStatus ?? null;

  return (
    <div className="workbench-shell">
      <a className="skip-link" href="#task-workspace">Skip to task workspace</a>
      <NavigationRail
        currentSession={snapshot?.session ?? null}
        daemonStatus={bootstrap.runtime.daemon.status}
        newTaskDisabled={mutationPending}
        onCloseSessions={() => setActiveDrawer(null)}
        onNewTask={startNewTask}
        onOpenSessions={() =>
          setActiveDrawer((current) => current === 'sessions' ? null : 'sessions')
        }
        onSelectSession={selectSession}
        selectedSessionId={selectedSessionId}
        sessionDrawerOpen={narrowViewport && activeDrawer === 'sessions'}
        sessionListError={sessionListError}
        sessionStatusOverride={runtimeUnavailable ? 'disconnected' : null}
        sessions={sessions}
        workspaceName={bootstrap.runtime.workspace.name}
      />

      <main className="workspace-main" id="task-workspace" tabIndex={-1}>
        <SessionHeader
          compactInspector={compactInspector}
          inspectorOpen={inspectorOpen}
          loading={sessionViewState === 'loading'}
          modelId={bootstrap.runtime.provider.modelId}
          onToggleInspector={(trigger) => {
            inspectorTrigger.current = trigger;
            if (narrowViewport) {
              setActiveDrawer((current) => current === 'inspector' ? null : 'inspector');
            } else {
              setInspectorOverlayOpen((current) => !current);
            }
          }}
          session={snapshot?.session ?? null}
          sessionStatus={sessionStatus}
          statusOverride={runtimeUnavailable ? 'Unavailable' : null}
          titleRef={sessionTitleRef}
          workspaceName={bootstrap.runtime.workspace.name}
        />

        {runtimeUnavailable ? (
          <div className="runtime-status" role="status" aria-atomic="true" aria-live="polite">
            <strong>{daemonUnavailable ? 'Runtime unavailable' : 'Live updates unavailable'}</strong>
            <span>{daemonUnavailable ? 'The local daemon is not ready.' : pollError}</span>
            {daemonUnavailable ? (
              <button type="button" onClick={() => setBootstrapAttempt((value) => value + 1)}>
                Retry connection
              </button>
            ) : null}
          </div>
        ) : null}

        {sessionViewState === 'loading' ? (
          <section className="session-view-state" aria-live="polite" aria-busy="true">
            Loading Session…
          </section>
        ) : sessionViewState === 'error' ? (
          <section className="session-view-state" role="alert">
            <p>Couldn’t open this Session.</p>
            <button type="button" onClick={() => selectedSessionId && void openSession(selectedSessionId)}>
              Try again
            </button>
          </section>
        ) : null}

        {sessionViewState === 'loading' || sessionViewState === 'error' ? null : (
          <>
            <Timeline
              cancelStates={cancelDisplayStates}
              onCancel={cancelTurn}
              items={timeline}
              onSelect={selectTimelineItem}
              queuedTurns={queuedTurns}
              runtimeReady={!runtimeUnavailable}
              runtimeUnavailable={runtimeUnavailable}
              selectedItemId={selectedItemId}
              toolPresentationIndex={toolPresentationIndex}
            />
          </>
        )}
        <Composer
          disabled={
            runtimeUnavailable ||
            sessionViewState === 'loading' ||
            sessionViewState === 'error'
          }
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
        open={inspectorOpen}
        presentation={inspectorPresentation}
        tool={selectedTool}
      />
    </div>
  );
}
