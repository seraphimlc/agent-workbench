// @vitest-environment jsdom

import {
  EventListAfterResultSchema,
  type MessageRow,
  type RendererSessionEventEnvelope,
  type SessionRuntimeStatus,
  type SessionSnapshot,
  type TurnRow,
  type TurnStatus,
} from '@agent-workbench/protocol';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiPublicError,
  type ApiClient,
  type MutationOperation,
} from './api.js';
import {
  App,
  CURRENT_SESSION_STORAGE_KEY,
  type PollIntervals,
} from './App.js';
import {
  buildToolPresentationIndex,
  getToolPresentation,
} from './components/Timeline.js';
import { projectTimeline } from './view-model.js';

const timestamp = (second: number): string =>
  `2026-07-16T00:00:${String(second).padStart(2, '0')}.000Z`;

const runtime = {
  daemon: { status: 'ready', protocolVersion: 1, pid: 4321 },
  provider: { baseHost: 'api.example.test', modelId: 'chat-model' },
  workspace: { name: 'agent-workbench' },
} as const;

const unavailableRuntime = {
  ...runtime,
  daemon: { status: 'unavailable', protocolVersion: null, pid: null },
} as const;

const event = (
  seq: number,
  type: string,
  options: {
    readonly actor?: RendererSessionEventEnvelope['actor'];
    readonly payload?: unknown;
    readonly toolRunId?: string | null;
    readonly turnId?: string | null;
  } = {},
): RendererSessionEventEnvelope => ({
  id: `event-${seq}`,
  sessionId: 'session-1',
  turnId: options.turnId ?? 'turn-1',
  toolRunId: options.toolRunId ?? null,
  seq,
  actor: options.actor ?? (options.toolRunId ? 'tool' : 'daemon'),
  audience: 'ui',
  createdAt: timestamp(seq),
  type,
  redacted: false,
  payload: (options.payload ?? {}) as never,
  blobId: null,
});

const turn = (
  status: TurnStatus,
  resultMessageId: string | null = null,
): TurnRow => ({
  id: 'turn-1',
  sessionId: 'session-1',
  ordinal: 1,
  clientRequestId: 'request-1',
  queueKind: 'normal',
  status,
  inputMessageId: 'message-user-1',
  modeSnapshot: 'craft',
  accessModeSnapshot: 'full_access',
  executionFence: 1,
  queuedAt: timestamp(1),
  startedAt: status === 'queued' ? null : timestamp(2),
  finishedAt:
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'interrupted'
      ? timestamp(8)
      : null,
  errorCode: status === 'failed' ? 'MODEL_RESPONSE_INVALID' : null,
  errorMessage: status === 'failed' ? 'Model response was invalid' : null,
  resultMessageId,
});

const message = (
  role: MessageRow['role'],
  content: string,
): MessageRow => ({
  id: role === 'assistant' ? 'message-assistant-1' : 'message-user-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  role,
  status: 'completed',
  content,
  createdAt: timestamp(role === 'assistant' ? 8 : 1),
  completedAt: timestamp(role === 'assistant' ? 8 : 1),
});

const snapshot = (
  options: {
    readonly events?: readonly RendererSessionEventEnvelope[];
    readonly messages?: readonly MessageRow[];
    readonly runtimeStatus?: SessionRuntimeStatus;
    readonly title?: string;
    readonly turns?: readonly TurnRow[];
  } = {},
): SessionSnapshot => {
  const events = options.events ?? [];
  return {
    session: {
      id: 'session-1',
      title: options.title ?? 'Inspect repository',
      workspaceId: 'workspace-1',
      lifecycleStatus: 'active',
      runtimeStatus: options.runtimeStatus ?? 'idle',
      queueBlockReason: null,
      recoveryEpisode: 0,
      recoverySourceTurnId: null,
      currentTurnId:
        options.runtimeStatus === 'queued' || options.runtimeStatus === 'running'
          ? 'turn-1'
          : null,
      mode: 'craft',
      accessMode: 'full_access',
      nextTurnOrdinal: 2,
      nextEventSeq: events.length + 1,
      revision: events.length,
      createdAt: timestamp(0),
      updatedAt: timestamp(events.length),
    },
    messages: [...(options.messages ?? [])],
    turns: [...(options.turns ?? [])],
    highWaterSeq: events.length,
    events: [...events],
  };
};

const unused = async (): Promise<never> => {
  throw new Error('Unexpected API call');
};

const unusedOperation = (): MutationOperation<never> => ({
  execute: unused,
  retry: unused,
});

const fakeApi = (overrides: Partial<ApiClient> = {}): ApiClient => ({
  getRuntime: async () => runtime,
  createSession: unused,
  createSessionOperation: unusedOperation,
  submitTurn: unused,
  createTurnOperation: unusedOperation,
  getSnapshot: unused,
  getEvents: unused,
  ...overrides,
});

const operation = <Result,>(
  execute: () => Promise<Result>,
  retry: () => Promise<Result> = execute,
): MutationOperation<Result> => ({ execute, retry });

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const fastPolling: PollIntervals = { activeMs: 1, idleMs: 60_000 };

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: memoryStorage(),
  });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1440,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('professional web workbench', () => {
  it('loads sanitized runtime metadata and renders the empty workbench', async () => {
    const api = fakeApi({
      getRuntime: async () =>
        ({ ...runtime, apiKey: 'must-not-render' }) as typeof runtime,
    });

    render(<App api={api} />);

    expect(screen.getByText('Connecting to local runtime…')).toBeTruthy();
    expect(await screen.findByText('chat-model')).toBeTruthy();
    expect(screen.getByText('agent-workbench')).toBeTruthy();
    expect(screen.getByText('Describe the task you want to run.')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Skip to task workspace' }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('region', { name: 'Session timeline' })
        .getAttribute('aria-live'),
    ).toBe('polite');
    expect(screen.queryByText('must-not-render')).toBeNull();
  });

  it('uses a Runtime heartbeat to degrade and recover the empty workbench', async () => {
    const degraded = deferred<Awaited<ReturnType<ApiClient['getRuntime']>>>();
    const recovered = deferred<Awaited<ReturnType<ApiClient['getRuntime']>>>();
    const getRuntime = vi
      .fn<ApiClient['getRuntime']>()
      .mockResolvedValueOnce(runtime)
      .mockImplementationOnce(() => degraded.promise)
      .mockImplementationOnce(() => recovered.promise)
      .mockImplementation(() => new Promise(() => undefined));

    render(
      <App
        api={fakeApi({ getRuntime })}
        pollIntervals={{ activeMs: 60_000, idleMs: 60_000, runtimeMs: 1 }}
      />,
    );

    expect(await screen.findByText('chat-model')).toBeTruthy();
    await waitFor(() => expect(getRuntime).toHaveBeenCalledTimes(2));
    await act(async () => {
      degraded.resolve(unavailableRuntime);
      await degraded.promise;
    });
    expect(await screen.findByText('Runtime unavailable')).toBeTruthy();
    expect(
      (screen.getByLabelText('Task prompt') as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);

    await waitFor(() => expect(getRuntime).toHaveBeenCalledTimes(3));
    await act(async () => {
      recovered.resolve(runtime);
      await recovered.promise;
    });
    await waitFor(() => expect(screen.queryByText('Runtime unavailable')).toBeNull());
    expect(
      (screen.getByLabelText('Task prompt') as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
  });

  it('restores a saved Session before marking a recovered Runtime ready', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const restored = deferred<SessionSnapshot>();
    const getRuntime = vi
      .fn<ApiClient['getRuntime']>()
      .mockResolvedValueOnce(unavailableRuntime)
      .mockResolvedValue(runtime);
    const getSnapshot = vi
      .fn<ApiClient['getSnapshot']>()
      .mockImplementation(() => restored.promise);

    render(
      <App
        api={fakeApi({ getRuntime, getSnapshot })}
        pollIntervals={{ activeMs: 60_000, idleMs: 60_000, runtimeMs: 1 }}
      />,
    );

    expect(await screen.findByText('Runtime unavailable')).toBeTruthy();
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledWith('session-1'));
    await act(async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    });
    expect(getRuntime).toHaveBeenCalledTimes(2);
    expect(
      (screen.getByLabelText('Task prompt') as HTMLTextAreaElement).disabled,
    ).toBe(true);

    await act(async () => {
      restored.resolve(snapshot({ title: 'Recovered saved task' }));
      await restored.promise;
    });

    expect(await screen.findByText('Recovered saved task')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Runtime unavailable')).toBeNull());
  });

  it('clears a missing saved Session and recovers to an empty ready workbench', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const getRuntime = vi
      .fn<ApiClient['getRuntime']>()
      .mockResolvedValueOnce(unavailableRuntime)
      .mockResolvedValueOnce(runtime)
      .mockImplementation(() => new Promise(() => undefined));
    const getSnapshot = vi.fn<ApiClient['getSnapshot']>().mockRejectedValue(
      new ApiPublicError(404, {
        code: 'SESSION_NOT_FOUND',
        message: 'Session was not found',
        retryable: false,
        userAction: null,
      }),
    );

    render(
      <App
        api={fakeApi({ getRuntime, getSnapshot })}
        pollIntervals={{ activeMs: 60_000, idleMs: 60_000, runtimeMs: 1 }}
      />,
    );

    expect(await screen.findByText('Runtime unavailable')).toBeTruthy();
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledWith('session-1'));
    await waitFor(() =>
      expect(window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY)).toBeNull(),
    );
    await waitFor(() => expect(screen.queryByText('Runtime unavailable')).toBeNull());
    expect(screen.getByText('Describe the task you want to run.')).toBeTruthy();
    expect(
      (screen.getByLabelText('Task prompt') as HTMLTextAreaElement).disabled,
    ).toBe(false);
  });

  it('keeps submission disabled and retries a non-missing saved Session recovery error', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const firstRecovery = deferred<SessionSnapshot>();
    const secondRecovery = deferred<SessionSnapshot>();
    const getRuntime = vi
      .fn<ApiClient['getRuntime']>()
      .mockResolvedValueOnce(unavailableRuntime)
      .mockResolvedValue(runtime);
    const getSnapshot = vi
      .fn<ApiClient['getSnapshot']>()
      .mockImplementationOnce(() => firstRecovery.promise)
      .mockImplementationOnce(() => secondRecovery.promise);

    render(
      <App
        api={fakeApi({ getRuntime, getSnapshot })}
        pollIntervals={{ activeMs: 60_000, idleMs: 60_000, runtimeMs: 1 }}
      />,
    );

    expect(await screen.findByText('Runtime unavailable')).toBeTruthy();
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1));
    await act(async () => {
      firstRecovery.reject(new Error('Snapshot recovery unavailable'));
      await firstRecovery.promise.catch(() => undefined);
    });
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Runtime unavailable')).toBeTruthy();
    expect(
      (screen.getByLabelText('Task prompt') as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY)).toBe('session-1');

    await act(async () => {
      secondRecovery.resolve(snapshot({ title: 'Recovered after retry' }));
      await secondRecovery.promise;
    });
    expect(await screen.findByText('Recovered after retry')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Runtime unavailable')).toBeNull());
  });

  it('does not adopt a saved Session recovery after a newer empty state wins', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const restored = deferred<SessionSnapshot>();
    const getRuntime = vi
      .fn<ApiClient['getRuntime']>()
      .mockResolvedValueOnce(unavailableRuntime)
      .mockResolvedValueOnce(runtime)
      .mockImplementation(() => new Promise(() => undefined));
    const getSnapshot = vi
      .fn<ApiClient['getSnapshot']>()
      .mockImplementation(() => restored.promise);
    const user = userEvent.setup();

    render(
      <App
        api={fakeApi({ getRuntime, getSnapshot })}
        pollIntervals={{ activeMs: 60_000, idleMs: 60_000, runtimeMs: 1 }}
      />,
    );

    await waitFor(() => expect(getSnapshot).toHaveBeenCalledWith('session-1'));
    await user.click(screen.getByRole('button', { name: 'New task' }));
    expect(window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY)).toBeNull();

    await act(async () => {
      restored.resolve(snapshot({ title: 'Stale recovered task' }));
      await restored.promise;
    });

    await waitFor(() => expect(screen.queryByText('Runtime unavailable')).toBeNull());
    expect(screen.queryByText('Stale recovered task')).toBeNull();
    expect(screen.getByText('Describe the task you want to run.')).toBeTruthy();
  });

  it('stops a pending saved Session recovery after unmount', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const restored = deferred<SessionSnapshot>();
    const getRuntime = vi
      .fn<ApiClient['getRuntime']>()
      .mockResolvedValueOnce(unavailableRuntime)
      .mockResolvedValue(runtime);
    const getSnapshot = vi
      .fn<ApiClient['getSnapshot']>()
      .mockImplementation(() => restored.promise);
    const rendered = render(
      <App
        api={fakeApi({ getRuntime, getSnapshot })}
        pollIntervals={{ activeMs: 60_000, idleMs: 60_000, runtimeMs: 1 }}
      />,
    );

    await waitFor(() => expect(getSnapshot).toHaveBeenCalledWith('session-1'));
    rendered.unmount();
    await act(async () => {
      restored.resolve(snapshot({ title: 'Unmounted stale task' }));
      await restored.promise;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    });

    expect(getRuntime).toHaveBeenCalledTimes(2);
  });

  it('recovers from a bootstrap error without reloading the page', async () => {
    const getRuntime = vi
      .fn<ApiClient['getRuntime']>()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(runtime);
    const user = userEvent.setup();

    render(<App api={fakeApi({ getRuntime })} />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The local workbench could not connect.',
    );
    await user.click(screen.getByRole('button', { name: 'Retry connection' }));

    expect(await screen.findByText('chat-model')).toBeTruthy();
    expect(getRuntime).toHaveBeenCalledTimes(2);
  });

  it('creates the first session and persists its id', async () => {
    const createdSnapshot = snapshot({
      events: [event(1, 'turn.queued', { payload: { ordinal: 1 } })],
      messages: [message('user', 'Read README.md')],
      runtimeStatus: 'queued',
      turns: [turn('queued')],
    });
    const execute = vi.fn(async () => ({
      sessionId: 'session-1',
      turnId: 'turn-1',
    }));
    const createSessionOperation = vi.fn<ApiClient['createSessionOperation']>(
      () => operation(execute),
    );
    const user = userEvent.setup();

    render(
      <App
        api={fakeApi({
          createSessionOperation,
          getSnapshot: async () => createdSnapshot,
        })}
        pollIntervals={fastPolling}
      />,
    );

    await user.type(await screen.findByLabelText('Task prompt'), 'Read README.md');
    await user.click(screen.getByRole('button', { name: 'Run task' }));

    expect(await screen.findByText('Inspect repository')).toBeTruthy();
    expect(createSessionOperation).toHaveBeenCalledWith({
      prompt: 'Read README.md',
    });
    expect(window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY)).toBe(
      'session-1',
    );
  });

  it('enqueues later turns while the current session is running', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const runningSnapshot = snapshot({
      events: [event(1, 'turn.queued', { payload: { ordinal: 1 } })],
      messages: [message('user', 'First task')],
      runtimeStatus: 'running',
      turns: [turn('running')],
    });
    const createTurnOperation = vi.fn<ApiClient['createTurnOperation']>(() =>
      operation(async () => ({ turnId: 'turn-2' })),
    );
    const user = userEvent.setup();

    render(
      <App
        api={fakeApi({
          createTurnOperation,
          getEvents: () => new Promise(() => undefined),
          getSnapshot: async () => runningSnapshot,
        })}
        pollIntervals={fastPolling}
      />,
    );

    await user.type(await screen.findByLabelText('Task prompt'), 'Check package scripts');
    await user.click(screen.getByRole('button', { name: 'Queue turn' }));

    expect(createTurnOperation).toHaveBeenCalledWith('session-1', {
      prompt: 'Check package scripts',
    });
  });

  it('polls model and tool events but waits for Snapshot before showing final assistant text', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const initialEvents = [
      event(1, 'turn.queued', { payload: { ordinal: 1 } }),
    ];
    const incrementalEvents = [
      event(2, 'model.started', {
        actor: 'model',
        payload: { modelCallId: 'model-call-1' },
      }),
      event(3, 'tool.started', {
        payload: {
          inputSummary: 'README.md',
          toolId: 'fs.read_text',
          toolRunId: 'tool-run-1',
        },
        toolRunId: 'tool-run-1',
      }),
      event(4, 'tool.succeeded', {
        payload: {
          outputBytes: 42,
          outputSummary: 'Agent Workbench',
          toolRunId: 'tool-run-1',
        },
        toolRunId: 'tool-run-1',
      }),
      event(5, 'turn.succeeded', {
        payload: {
          assistantText: 'forged event answer',
          modelAttemptId: 'attempt-1',
        },
      }),
    ];
    const initialSnapshot = snapshot({
      events: initialEvents,
      messages: [message('user', 'Read README.md')],
      runtimeStatus: 'running',
      turns: [turn('running')],
    });
    const authoritativeSnapshot = snapshot({
      events: [...initialEvents, ...incrementalEvents],
      messages: [
        message('user', 'Read README.md'),
        message('assistant', 'Persisted assistant answer'),
      ],
      runtimeStatus: 'idle',
      turns: [turn('succeeded', 'message-assistant-1')],
    });
    const refreshed = deferred<SessionSnapshot>();
    const getSnapshot = vi
      .fn<ApiClient['getSnapshot']>()
      .mockResolvedValueOnce(initialSnapshot)
      .mockImplementationOnce(() => refreshed.promise);
    const getEvents = vi.fn<ApiClient['getEvents']>(async () => ({
      events: incrementalEvents,
      highWaterSeq: 5,
    }));

    render(
      <App
        api={fakeApi({ getEvents, getSnapshot })}
        pollIntervals={fastPolling}
      />,
    );

    expect(await screen.findByText('Model is working')).toBeTruthy();
    expect(screen.getByText('fs.read_text')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
    expect(screen.getAllByText('Agent Workbench').length).toBeGreaterThan(1);
    expect(screen.queryByText('forged event answer')).toBeNull();
    expect(screen.queryByText('Persisted assistant answer')).toBeNull();

    await act(async () => {
      refreshed.resolve(authoritativeSnapshot);
      await refreshed.promise;
    });

    expect(await screen.findByText('Persisted assistant answer')).toBeTruthy();
    expect(screen.queryByText('forged event answer')).toBeNull();
  });

  it('selects a Tool card and shows structured Inspector details', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const toolSnapshot = snapshot({
      events: [
        event(1, 'turn.queued', { payload: { ordinal: 1 } }),
        event(2, 'tool.started', {
          payload: {
            inputSummary: 'README.md',
            toolId: 'fs.read_text',
            toolRunId: 'tool-run-1',
          },
          toolRunId: 'tool-run-1',
        }),
        event(3, 'tool.succeeded', {
          payload: {
            outputBytes: 42,
            outputSummary: 'Agent Workbench',
            toolRunId: 'tool-run-1',
          },
          toolRunId: 'tool-run-1',
        }),
      ],
      messages: [message('user', 'Read README.md')],
      turns: [turn('succeeded')],
    });
    const user = userEvent.setup();

    render(<App api={fakeApi({ getSnapshot: async () => toolSnapshot })} />);

    await user.click(
      await screen.findByRole('button', {
        name: 'Tool fs.read_text succeeded',
      }),
    );

    expect(screen.getByRole('heading', { name: 'Inspector' })).toBeTruthy();
    expect(screen.getAllByText('README.md').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Agent Workbench').length).toBeGreaterThan(1);
    expect(screen.getByText('tool-run-1')).toBeTruthy();
  });

  it('keeps stable failure codes visible in cards and Inspector payloads', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const failureSnapshot = snapshot({
      events: [
        event(1, 'turn.queued', { payload: { ordinal: 1 } }),
        event(2, 'model.failed', {
          actor: 'model',
          payload: {
            errorCode: 'MODEL_RESPONSE_INVALID',
            modelAttemptId: 'attempt-1',
            modelCallId: 'model-call-1',
          },
        }),
        event(3, 'turn.failed', {
          payload: { errorCode: 'MODEL_RESPONSE_INVALID' },
        }),
      ],
      messages: [message('user', 'Use the model')],
      runtimeStatus: 'error',
      turns: [turn('failed')],
    });

    render(<App api={fakeApi({ getSnapshot: async () => failureSnapshot })} />);

    expect((await screen.findAllByText('MODEL_RESPONSE_INVALID')).length).toBe(
      2,
    );
  });

  it('indexes multiple ToolRuns without mixing their input and output summaries', () => {
    const toolEvents = [
      event(1, 'turn.queued', { payload: { ordinal: 1 } }),
      event(2, 'tool.started', {
        payload: {
          inputSummary: 'README.md',
          toolId: 'fs.read_text',
          toolRunId: 'tool-run-1',
        },
        toolRunId: 'tool-run-1',
      }),
      event(3, 'tool.succeeded', {
        payload: {
          outputBytes: 10,
          outputSummary: 'First output',
          toolRunId: 'tool-run-1',
        },
        toolRunId: 'tool-run-1',
      }),
      event(4, 'tool.started', {
        payload: {
          inputSummary: 'package.json',
          toolId: 'fs.read_text',
          toolRunId: 'tool-run-2',
        },
        toolRunId: 'tool-run-2',
      }),
      event(5, 'tool.succeeded', {
        payload: {
          outputBytes: 20,
          outputSummary: 'Second output',
          toolRunId: 'tool-run-2',
        },
        toolRunId: 'tool-run-2',
      }),
    ];
    const timeline = projectTimeline(
      snapshot({
        events: toolEvents,
        messages: [message('user', 'Read two files')],
        turns: [turn('succeeded')],
      }),
    );
    const index = buildToolPresentationIndex(timeline);
    const firstRun = timeline.find((item) => item.seq === 3);
    const secondRun = timeline.find((item) => item.seq === 5);

    expect(index.presentations.size).toBe(2);
    expect(firstRun && getToolPresentation(firstRun, index)).toMatchObject({
      inputSummary: 'README.md',
      outputBytes: 10,
      outputSummary: 'First output',
      toolId: 'fs.read_text',
      toolRunId: 'tool-run-1',
    });
    expect(secondRun && getToolPresentation(secondRun, index)).toMatchObject({
      inputSummary: 'package.json',
      outputBytes: 20,
      outputSummary: 'Second output',
      toolId: 'fs.read_text',
      toolRunId: 'tool-run-2',
    });
  });

  it('restores the saved session from localStorage', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const getSnapshot = vi.fn(async () =>
      snapshot({ title: 'Restored repository task' }),
    );

    render(<App api={fakeApi({ getSnapshot })} />);

    expect(await screen.findByText('Restored repository task')).toBeTruthy();
    expect(getSnapshot).toHaveBeenCalledWith('session-1');
  });

  it('discards incremental state and resyncs Snapshot after an event gap', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const firstSnapshot = snapshot({
      events: [event(1, 'turn.queued', { payload: { ordinal: 1 } })],
      messages: [message('user', 'Read README.md')],
      runtimeStatus: 'running',
      turns: [turn('running')],
    });
    const resyncedSnapshot = snapshot({
      events: [
        event(1, 'turn.queued', { payload: { ordinal: 1 } }),
        event(2, 'model.started', {
          actor: 'model',
          payload: { modelCallId: 'model-call-1' },
        }),
        event(3, 'model.completed', {
          actor: 'model',
          payload: { modelCallId: 'model-call-1' },
        }),
      ],
      messages: [message('user', 'Read README.md')],
      turns: [turn('running')],
    });
    const getSnapshot = vi
      .fn<ApiClient['getSnapshot']>()
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(resyncedSnapshot);
    const getEvents = vi.fn<ApiClient['getEvents']>(async () => ({
      events: [
        event(3, 'model.completed', {
          actor: 'model',
          payload: { modelCallId: 'model-call-1' },
        }),
      ],
      highWaterSeq: 3,
    }));

    render(
      <App
        api={fakeApi({ getEvents, getSnapshot })}
        pollIntervals={fastPolling}
      />,
    );

    expect(await screen.findByText('Model completed')).toBeTruthy();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('resyncs malformed event responses and continues polling from the authoritative Snapshot', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const firstSnapshot = snapshot({
      events: [event(1, 'turn.queued', { payload: { ordinal: 1 } })],
      messages: [message('user', 'Read README.md')],
      runtimeStatus: 'running',
      turns: [turn('running')],
    });
    const resyncedSnapshot = snapshot({
      events: [
        event(1, 'turn.queued', { payload: { ordinal: 1 } }),
        event(2, 'model.started', {
          actor: 'model',
          payload: { modelCallId: 'model-call-1' },
        }),
      ],
      messages: [message('user', 'Read README.md')],
      runtimeStatus: 'running',
      turns: [turn('running')],
    });
    const getSnapshot = vi
      .fn<ApiClient['getSnapshot']>()
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(resyncedSnapshot);
    const getEvents = vi
      .fn<ApiClient['getEvents']>()
      .mockImplementationOnce(async () =>
        EventListAfterResultSchema.parse({
          events: 'not-an-event-list',
          highWaterSeq: 1,
        }),
      )
      .mockImplementationOnce(() => new Promise(() => undefined));

    render(
      <App
        api={fakeApi({ getEvents, getSnapshot })}
        pollIntervals={fastPolling}
      />,
    );

    expect(await screen.findByText('Model is working')).toBeTruthy();
    await waitFor(() => expect(getEvents).toHaveBeenCalledTimes(2));
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Live updates unavailable')).toBeNull();
  });

  it('overrides a stale running Snapshot while RPC is disconnected and restores it after recovery', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const runningSnapshot = snapshot({
      events: [
        event(1, 'turn.queued', { payload: { ordinal: 1 } }),
        event(2, 'model.started', {
          actor: 'model',
          payload: { modelCallId: 'model-call-1' },
        }),
      ],
      messages: [message('user', 'Read README.md')],
      runtimeStatus: 'running',
      turns: [turn('running')],
    });
    const recoveredPage = deferred<
      Awaited<ReturnType<ApiClient['getEvents']>>
    >();
    const getEvents = vi
      .fn<ApiClient['getEvents']>()
      .mockRejectedValueOnce(new TypeError('RPC disconnected'))
      .mockImplementationOnce(() => recoveredPage.promise)
      .mockImplementationOnce(() => new Promise(() => undefined));

    render(
      <App
        api={fakeApi({
          getEvents,
          getSnapshot: async () => runningSnapshot,
        })}
        pollIntervals={{ activeMs: 1, idleMs: 1 }}
      />,
    );

    expect(await screen.findByText('Live updates unavailable')).toBeTruthy();
    const configuration = screen.getByRole('list', {
      name: 'Session configuration',
    });
    expect(within(configuration).getByText('Unavailable')).toBeTruthy();
    expect(within(configuration).queryByText('Running')).toBeNull();
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByText('Model is working')).toBeNull();
    expect(screen.queryByText('Turn queued')).toBeNull();
    expect(screen.getAllByText('Last known state').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Connection unavailable').length).toBeGreaterThan(
      0,
    );
    expect(
      screen
        .getByRole('region', { name: 'Session timeline' })
        .getAttribute('aria-live'),
    ).toBe('off');
    expect(
      within(screen.getByRole('region', { name: 'Current task' })).getByText(
        'Status: disconnected',
      ),
    ).toBeTruthy();

    await waitFor(() => expect(getEvents).toHaveBeenCalledTimes(2));
    await act(async () => {
      recoveredPage.resolve({ events: [], highWaterSeq: 2 });
      await recoveredPage.promise;
    });

    await waitFor(() =>
      expect(within(configuration).getByText('Running')).toBeTruthy(),
    );
    expect(screen.getByText('Model is working')).toBeTruthy();
    expect(screen.getByText('Turn queued')).toBeTruthy();
    expect(
      screen
        .getByRole('region', { name: 'Session timeline' })
        .getAttribute('aria-live'),
    ).toBe('polite');
    expect(
      within(screen.getByRole('region', { name: 'Current task' })).getByText(
        'Status: running',
      ),
    ).toBeTruthy();
  });

  it('fences an in-flight Event poll when the Runtime heartbeat degrades and restarts it after recovery', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const runningSnapshot = snapshot({ runtimeStatus: 'running' });
    const degraded = deferred<Awaited<ReturnType<ApiClient['getRuntime']>>>();
    const recovered = deferred<Awaited<ReturnType<ApiClient['getRuntime']>>>();
    const staleEvents = deferred<Awaited<ReturnType<ApiClient['getEvents']>>>();
    const getRuntime = vi
      .fn<ApiClient['getRuntime']>()
      .mockResolvedValueOnce(runtime)
      .mockImplementationOnce(() => degraded.promise)
      .mockImplementationOnce(() => recovered.promise)
      .mockImplementation(() => new Promise(() => undefined));
    const getSnapshot = vi
      .fn<ApiClient['getSnapshot']>()
      .mockResolvedValue(runningSnapshot);
    const getEvents = vi
      .fn<ApiClient['getEvents']>()
      .mockImplementationOnce(() => staleEvents.promise)
      .mockImplementation(() => new Promise(() => undefined));

    render(
      <App
        api={fakeApi({ getEvents, getRuntime, getSnapshot })}
        pollIntervals={{ activeMs: 1, idleMs: 60_000, runtimeMs: 1 }}
      />,
    );

    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getEvents).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getRuntime).toHaveBeenCalledTimes(2));
    await act(async () => {
      degraded.resolve(unavailableRuntime);
      await degraded.promise;
    });
    expect(await screen.findByText('Runtime unavailable')).toBeTruthy();

    await act(async () => {
      staleEvents.resolve({
        events: [event(1, 'model.completed', { actor: 'model' })],
        highWaterSeq: 1,
      });
      await staleEvents.promise;
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(getRuntime).toHaveBeenCalledTimes(3));
    await act(async () => {
      recovered.resolve(runtime);
      await recovered.promise;
    });
    await waitFor(() => expect(screen.queryByText('Runtime unavailable')).toBeNull());
    await waitFor(() => expect(getEvents).toHaveBeenCalledTimes(2));
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('shows an unavailable top status and disables submission', async () => {
    render(
      <App api={fakeApi({ getRuntime: async () => unavailableRuntime })} />,
    );

    expect((await screen.findByRole('status')).textContent).toContain(
      'Runtime unavailable',
    );
    expect(
      (screen.getByRole('button', { name: 'Run task' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('opens selected Inspector content as a narrow-screen drawer', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 700,
      writable: true,
    });
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const narrowSnapshot = snapshot({
      events: [
        event(1, 'turn.queued', { payload: { ordinal: 1 } }),
        event(2, 'tool.started', {
          payload: {
            inputSummary: 'README.md',
            toolId: 'fs.read_text',
            toolRunId: 'tool-run-1',
          },
          toolRunId: 'tool-run-1',
        }),
      ],
      messages: [message('user', 'Read README.md')],
      runtimeStatus: 'running',
      turns: [turn('running')],
    });
    const user = userEvent.setup();

    render(
      <App
        api={fakeApi({
          getEvents: () => new Promise(() => undefined),
          getSnapshot: async () => narrowSnapshot,
        })}
        pollIntervals={fastPolling}
      />,
    );

    const toolCard = await screen.findByRole('button', {
      name: 'Tool fs.read_text started',
    });
    await user.click(toolCard);

    const dialog = screen.getByRole('dialog', { name: 'Inspector' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const closeButton = screen.getByRole('button', { name: 'Close inspector' });
    const payload = screen.getByLabelText('Event payload');
    await waitFor(() => expect(document.activeElement).toBe(closeButton));

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(payload);
    await user.tab();
    expect(document.activeElement).toBe(closeButton);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Inspector' })).toBeNull();
    expect(document.activeElement).toBe(toolCard);

    await user.click(toolCard);
    const backdrop = document.querySelector<HTMLElement>('.inspector-backdrop');
    expect(backdrop?.tagName).toBe('DIV');
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop?.tabIndex).toBe(-1);
    fireEvent.click(backdrop as HTMLElement);
    expect(screen.queryByRole('dialog', { name: 'Inspector' })).toBeNull();
    expect(document.activeElement).toBe(toolCard);
  });

  it('allows Tab to leave the desktop Inspector panel', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const desktopSnapshot = snapshot({
      events: [
        event(1, 'turn.queued', { payload: { ordinal: 1 } }),
        event(2, 'tool.started', {
          payload: {
            inputSummary: 'README.md',
            toolId: 'fs.read_text',
            toolRunId: 'tool-run-1',
          },
          toolRunId: 'tool-run-1',
        }),
      ],
      messages: [message('user', 'Read README.md')],
      runtimeStatus: 'idle',
      turns: [turn('succeeded')],
    });
    const user = userEvent.setup();

    render(<App api={fakeApi({ getSnapshot: async () => desktopSnapshot })} />);

    await user.click(
      await screen.findByRole('button', {
        name: 'Tool fs.read_text started',
      }),
    );
    const panel = screen.getByRole('complementary', { name: 'Inspector' });
    const payload = within(panel).getByLabelText('Event payload');
    payload.focus();

    await user.tab();

    expect(document.activeElement).not.toBe(payload);
  });

  it('retries the same failed mutation operation instead of creating a new id', async () => {
    const execute = vi.fn(async () => {
      throw new TypeError('network unavailable');
    });
    const retry = vi.fn(async () => ({
      sessionId: 'session-1',
      turnId: 'turn-1',
    }));
    const createSessionOperation = vi.fn<ApiClient['createSessionOperation']>(
      () => operation(execute, retry),
    );
    const user = userEvent.setup();

    render(
      <App
        api={fakeApi({
          createSessionOperation,
          getSnapshot: async () => snapshot(),
        })}
      />,
    );

    await user.type(await screen.findByLabelText('Task prompt'), 'Retry this task');
    await user.click(screen.getByRole('button', { name: 'Run task' }));
    expect(await screen.findByText('network unavailable')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry submission' }));

    await waitFor(() => {
      expect(window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY)).toBe(
        'session-1',
      );
    });
    expect(createSessionOperation).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('drops a stale deferred poll after a mutation adopts a newer Snapshot', async () => {
    window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, 'session-1');
    const initialSnapshot = snapshot({
      runtimeStatus: 'running',
      title: 'Initial running task',
    });
    const mutationSnapshot = snapshot({
      runtimeStatus: 'idle',
      title: 'Mutation authoritative task',
    });
    const stalePollSnapshot = snapshot({
      runtimeStatus: 'idle',
      title: 'Stale poll task',
    });
    const pendingPoll = deferred<Awaited<ReturnType<ApiClient['getEvents']>>>();
    const getEvents = vi
      .fn<ApiClient['getEvents']>()
      .mockImplementationOnce(() => pendingPoll.promise)
      .mockImplementationOnce(() => new Promise(() => undefined));
    const getSnapshot = vi
      .fn<ApiClient['getSnapshot']>()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(mutationSnapshot)
      .mockResolvedValueOnce(stalePollSnapshot);
    const createTurnOperation = vi.fn<ApiClient['createTurnOperation']>(() =>
      operation(async () => ({ turnId: 'turn-2' })),
    );
    const user = userEvent.setup();

    render(
      <App
        api={fakeApi({
          createTurnOperation,
          getEvents,
          getSnapshot,
        })}
        pollIntervals={fastPolling}
      />,
    );

    await waitFor(() => expect(getEvents).toHaveBeenCalledTimes(1));
    await user.type(await screen.findByLabelText('Task prompt'), 'New turn');
    await user.click(screen.getByRole('button', { name: 'Queue turn' }));
    expect(await screen.findByText('Mutation authoritative task')).toBeTruthy();

    await act(async () => {
      pendingPoll.resolve({
        events: [event(1, 'session.created', { turnId: null })],
        highWaterSeq: 1,
      });
      await pendingPoll.promise;
    });

    expect(screen.getByText('Mutation authoritative task')).toBeTruthy();
    expect(screen.queryByText('Stale poll task')).toBeNull();
    expect(screen.queryByText('session.created')).toBeNull();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('defines the desktop grid, visible focus, and reduced-motion fallback', () => {
    const styles = readFileSync(
      resolve(process.cwd(), 'apps/web-console/src/client/styles.css'),
      'utf8',
    );

    expect(styles).toMatch(
      /grid-template-columns:\s*240px\s+minmax\(480px,\s*1fr\)\s+320px/,
    );
    expect(styles).toMatch(
      /grid-template-areas:\s*"header"\s*"status"\s*"timeline"\s*"composer"/,
    );
    expect(styles).toMatch(
      /grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto/,
    );
    expect(styles).toMatch(/\.session-header\s*\{[^}]*grid-area:\s*header/s);
    expect(styles).toMatch(/\.runtime-status\s*\{[^}]*grid-area:\s*status/s);
    expect(styles).toMatch(/\.timeline\s*\{[^}]*grid-area:\s*timeline/s);
    expect(styles).toMatch(/\.composer\s*\{[^}]*grid-area:\s*composer/s);
    expect(styles).toMatch(/:focus-visible/);
    expect(styles).toMatch(/@media\s*\(max-width:\s*1099px\)/);
    expect(styles).toMatch(/@media\s*\(max-width:\s*819px\)/);
    expect(styles).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)/,
    );
  });
});
