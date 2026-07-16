import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  RendererSessionEventEnvelope,
  SessionSnapshot,
  TurnStatus,
} from '@agent-workbench/protocol';

import {
  RuntimePublicInfoSchema,
  SessionCreatedHttpResponseSchema,
  SessionSnapshotHttpResponseSchema,
} from '../apps/web-console/src/shared/contracts.js';
import {
  startWebConsoleServer,
  type ShutdownSignalSource,
  type WebConsoleServerHandle,
} from '../apps/web-console/src/server/index.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_PROMPT =
  "Use fs.read_text to read package.json, then summarize the repository's current capabilities in 3 concise bullets. Do not answer before reading the file.";
const REDACTED = '[redacted]';

type SmokeErrorCode =
  | 'SMOKE_CONFIG_MISSING'
  | 'SMOKE_OPTIONS_INVALID'
  | 'SMOKE_START_FAILED'
  | 'SMOKE_HTTP_FAILED'
  | 'SMOKE_RESPONSE_INVALID'
  | 'SMOKE_CSRF_MISSING'
  | 'SMOKE_TIMEOUT'
  | 'SMOKE_TURN_FAILED'
  | 'SMOKE_REQUIREMENTS_NOT_MET'
  | 'SMOKE_STOP_FAILED';

export class WebConsoleRealSmokeError extends Error {
  constructor(readonly code: SmokeErrorCode, message: string) {
    super(message);
    this.name = 'WebConsoleRealSmokeError';
  }
}

export class WebConsoleRealSmokeAggregateError extends AggregateError {
  readonly code = 'SMOKE_MULTIPLE_FAILURES';

  constructor(errors: readonly WebConsoleRealSmokeError[]) {
    super(errors, 'Web Console smoke and cleanup both failed');
    this.name = 'WebConsoleRealSmokeAggregateError';
  }
}

type SmokeServerStartOptions = {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
};

export type WebConsoleRealSmokeDependencies = {
  readonly startServer: (
    options: SmokeServerStartOptions,
  ) => Promise<WebConsoleServerHandle>;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly createSubmissionId: () => string;
};

export type WebConsoleRealSmokeOptions = {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly prompt?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly dependencies?: Partial<WebConsoleRealSmokeDependencies>;
};

export type WebConsoleRealSmokeSummary = {
  readonly status: 'ok';
  readonly modelId: string;
  readonly eventTypeCounts: Readonly<Record<string, number>>;
  readonly turnStatus: 'succeeded';
  readonly durationMs: number;
};

type WebConsoleRealSmokeResult = Omit<WebConsoleRealSmokeSummary, 'durationMs'>;

type SmokeCliDependencies = {
  readonly runSmoke: (
    options?: WebConsoleRealSmokeOptions,
  ) => Promise<WebConsoleRealSmokeSummary>;
  readonly writeStdout: (line: string) => void;
  readonly writeStderr: (line: string) => void;
};

const smokeError = (code: SmokeErrorCode): WebConsoleRealSmokeError => {
  switch (code) {
    case 'SMOKE_CONFIG_MISSING':
      return new WebConsoleRealSmokeError(
        code,
        'Required Web Console smoke configuration is missing',
      );
    case 'SMOKE_OPTIONS_INVALID':
      return new WebConsoleRealSmokeError(code, 'Web Console smoke options are invalid');
    case 'SMOKE_START_FAILED':
      return new WebConsoleRealSmokeError(code, 'Web Console failed to start');
    case 'SMOKE_HTTP_FAILED':
      return new WebConsoleRealSmokeError(code, 'Web Console HTTP request failed');
    case 'SMOKE_RESPONSE_INVALID':
      return new WebConsoleRealSmokeError(code, 'Web Console returned an invalid response');
    case 'SMOKE_CSRF_MISSING':
      return new WebConsoleRealSmokeError(code, 'Web Console HTML did not contain CSRF metadata');
    case 'SMOKE_TIMEOUT':
      return new WebConsoleRealSmokeError(
        code,
        'Web Console smoke timed out before the turn became terminal',
      );
    case 'SMOKE_TURN_FAILED':
      return new WebConsoleRealSmokeError(code, 'Web Console turn did not succeed');
    case 'SMOKE_REQUIREMENTS_NOT_MET':
      return new WebConsoleRealSmokeError(
        code,
        'Web Console smoke lifecycle requirements were not met',
      );
    case 'SMOKE_STOP_FAILED':
      return new WebConsoleRealSmokeError(code, 'Web Console failed to stop cleanly');
  }
};

const createStartupSignalSource = (
  abortSignal: AbortSignal,
): ShutdownSignalSource => {
  const abortListeners = new Map<() => void, () => void>();
  return {
    once: (signal, listener) => {
      process.once(signal, listener);
      if (signal !== 'SIGTERM') return;
      const handleAbort = (): void => listener();
      abortListeners.set(listener, handleAbort);
      if (abortSignal.aborted) {
        queueMicrotask(handleAbort);
      } else {
        abortSignal.addEventListener('abort', handleAbort, { once: true });
      }
    },
    off: (signal, listener) => {
      process.off(signal, listener);
      if (signal !== 'SIGTERM') return;
      const handleAbort = abortListeners.get(listener);
      if (handleAbort === undefined) return;
      abortSignal.removeEventListener('abort', handleAbort);
      abortListeners.delete(listener);
    },
  };
};

const abortError = (): Error => new Error('Smoke operation was aborted');

const defaultDependencies = (): WebConsoleRealSmokeDependencies => ({
  startServer: async ({ cwd, environment, signal }) =>
    await startWebConsoleServer({
      cwd,
      environment,
      dependencies: { writeReady: () => undefined },
      signalSource: createStartupSignalSource(signal),
    }),
  fetch: globalThis.fetch,
  now: () => Date.now(),
  sleep: async (milliseconds, signal) =>
    await new Promise<void>((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(abortError());
        return;
      }
      const handleAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', handleAbort);
        rejectPromise(abortError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', handleAbort);
        resolvePromise();
      }, milliseconds);
      signal.addEventListener('abort', handleAbort, { once: true });
    }),
  createSubmissionId: randomUUID,
});

const isPositiveDuration = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const requiredEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  if (
    !environment.AGENT_WORKBENCH_PROVIDER_BASE_URL?.trim() ||
    !environment.AGENT_WORKBENCH_PROVIDER_API_KEY?.trim()
  ) {
    throw smokeError('SMOKE_CONFIG_MISSING');
  }
};

type ParseSchema<Value> = {
  parse(value: unknown): Value;
};

const remainingTime = (
  deadline: number,
  dependencies: Pick<WebConsoleRealSmokeDependencies, 'now'>,
): number => deadline - dependencies.now();

const disposeLate = <Value>(
  value: Value,
  dispose: ((lateValue: Value) => void | Promise<void>) | undefined,
): void => {
  if (dispose === undefined) return;
  void Promise.resolve(dispose(value)).catch(() => undefined);
};

const runBeforeDeadline = async <Value>(
  deadline: number,
  dependencies: Pick<WebConsoleRealSmokeDependencies, 'now'>,
  operation: (signal: AbortSignal) => Promise<Value>,
  dispose: ((lateValue: Value) => void | Promise<void>) | undefined = undefined,
): Promise<Value> => {
  const remainingMs = remainingTime(deadline, dependencies);
  if (remainingMs <= 0) throw smokeError('SMOKE_TIMEOUT');

  const controller = new AbortController();
  const operationPromise = Promise.resolve().then(
    async () => await operation(controller.signal),
  );

  return await new Promise<Value>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timeout = (): void =>
      finish(() => {
        controller.abort();
        rejectPromise(smokeError('SMOKE_TIMEOUT'));
      });
    const timer = setTimeout(timeout, Math.max(1, Math.ceil(remainingMs)));

    operationPromise.then(
      (value) => {
        if (settled) {
          disposeLate(value, dispose);
          return;
        }
        if (remainingTime(deadline, dependencies) < 0) {
          disposeLate(value, dispose);
          timeout();
          return;
        }
        finish(() => resolvePromise(value));
      },
      (error: unknown) => {
        if (settled) return;
        if (controller.signal.aborted || remainingTime(deadline, dependencies) < 0) {
          timeout();
          return;
        }
        finish(() => rejectPromise(error));
      },
    );
  });
};

const fetchBeforeDeadline = async (
  deadline: number,
  dependencies: Pick<WebConsoleRealSmokeDependencies, 'fetch' | 'now'>,
  input: string | URL,
  init: RequestInit | undefined,
  readBody: (response: Response) => Promise<unknown>,
): Promise<unknown> =>
  await runBeforeDeadline(deadline, dependencies, async (signal) => {
    let response: Response;
    try {
      response = await dependencies.fetch(input, { ...init, signal });
    } catch {
      throw smokeError('SMOKE_HTTP_FAILED');
    }
    if (!response.ok) throw smokeError('SMOKE_HTTP_FAILED');
    try {
      return await readBody(response);
    } catch {
      throw smokeError('SMOKE_RESPONSE_INVALID');
    }
  });

const requestText = async (
  deadline: number,
  dependencies: Pick<WebConsoleRealSmokeDependencies, 'fetch' | 'now'>,
  input: string | URL,
  init?: RequestInit,
): Promise<string> =>
  (await fetchBeforeDeadline(
    deadline,
    dependencies,
    input,
    init,
    async (response) => await response.text(),
  )) as string;

const requestJson = async <Value>(
  deadline: number,
  dependencies: Pick<WebConsoleRealSmokeDependencies, 'fetch' | 'now'>,
  input: string | URL,
  schema: ParseSchema<Value>,
  init?: RequestInit,
): Promise<Value> => {
  const body = await fetchBeforeDeadline(
    deadline,
    dependencies,
    input,
    init,
    async (response) => await response.json(),
  );
  try {
    return schema.parse(body);
  } catch {
    throw smokeError('SMOKE_RESPONSE_INVALID');
  }
};

const csrfTokenFrom = (html: string): string => {
  const match =
    /<meta\s+name=["']agent-workbench-csrf["']\s+content=["']([^"']+)["'][^>]*>/i.exec(
      html,
    );
  if (!match?.[1]) throw smokeError('SMOKE_CSRF_MISSING');
  return match[1];
};

const terminalStatuses = new Set<TurnStatus>([
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
]);

const isTerminal = (status: TurnStatus): boolean => terminalStatuses.has(status);

const payloadRecord = (
  event: RendererSessionEventEnvelope,
): Readonly<Record<string, unknown>> | null => {
  if (
    event.redacted ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return null;
  }
  return event.payload;
};

const countEventTypes = (
  events: readonly RendererSessionEventEnvelope[],
): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  return Object.freeze(
    Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  );
};

const payloadString = (
  event: RendererSessionEventEnvelope,
  key: string,
): string | null => {
  const value = payloadRecord(event)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const lifecycleFailure = (): never => {
  throw smokeError('SMOKE_REQUIREMENTS_NOT_MET');
};

const assertRequiredLifecycle = (
  snapshot: SessionSnapshot,
  turnId: string,
): void => {
  const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
  if (turn?.status !== 'succeeded') throw smokeError('SMOKE_TURN_FAILED');

  const events = snapshot.events.filter((event) => event.turnId === turnId);
  const modelStarted = events.filter((event) => event.type === 'model.started');
  const modelCompleted = events.filter((event) => event.type === 'model.completed');
  const firstModelStarted = modelStarted[0];
  const secondModelStarted = modelStarted[1];
  const firstModelCompleted = modelCompleted[0];
  const secondModelCompleted = modelCompleted[1];
  if (
    firstModelStarted === undefined ||
    secondModelStarted === undefined ||
    firstModelCompleted === undefined ||
    secondModelCompleted === undefined
  ) {
    lifecycleFailure();
  }

  const firstModelCallId = payloadString(firstModelStarted, 'modelCallId');
  const secondModelCallId = payloadString(secondModelStarted, 'modelCallId');
  const secondModelAttemptId = payloadString(
    secondModelCompleted,
    'modelAttemptId',
  );
  if (
    firstModelCallId === null ||
    secondModelCallId === null ||
    secondModelAttemptId === null ||
    firstModelCallId === secondModelCallId ||
    payloadString(firstModelCompleted, 'modelCallId') !== firstModelCallId ||
    payloadString(secondModelCompleted, 'modelCallId') !== secondModelCallId
  ) {
    lifecycleFailure();
  }

  const readStarted = events.find((event) => {
    const payload = payloadRecord(event);
    return (
      event.type === 'tool.started' &&
      event.toolRunId !== null &&
      payload?.toolRunId === event.toolRunId &&
      payload.toolId === 'fs.read_text' &&
      payload.inputSummary === 'package.json'
    );
  });
  const readToolRunId = readStarted?.toolRunId;
  if (readStarted === undefined || readToolRunId === null || readToolRunId === undefined) {
    lifecycleFailure();
  }
  const readSucceeded = events.find(
    (event) =>
      event.type === 'tool.succeeded' &&
      event.toolRunId === readToolRunId &&
      payloadRecord(event)?.toolRunId === readToolRunId,
  );
  const turnSucceeded = events.find((event) => event.type === 'turn.succeeded');
  if (
    readSucceeded === undefined ||
    turnSucceeded === undefined ||
    payloadString(turnSucceeded, 'modelAttemptId') !== secondModelAttemptId
  ) {
    lifecycleFailure();
  }

  const sequence = [
    firstModelStarted,
    firstModelCompleted,
    readStarted,
    readSucceeded,
    secondModelStarted,
    secondModelCompleted,
    turnSucceeded,
  ];
  const sequenceIsStrict = sequence.every(
    (event, index) => index === 0 || event.seq > sequence[index - 1]!.seq,
  );
  if (!sequenceIsStrict) lifecycleFailure();

  const assistant = snapshot.messages.find(
    (message) =>
      message.id === turn.resultMessageId &&
      message.turnId === turnId &&
      message.role === 'assistant' &&
      message.status === 'completed' &&
      message.content.trim().length > 0,
  );
  if (assistant === undefined) lifecycleFailure();
};

const collectSensitiveValues = (
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): readonly string[] => {
  const values = [environment.AGENT_WORKBENCH_PROVIDER_API_KEY?.trim(), cwd];
  const baseUrl = environment.AGENT_WORKBENCH_PROVIDER_BASE_URL?.trim();
  if (baseUrl) {
    values.push(baseUrl);
    const path = (() => {
      try {
        return new URL(baseUrl).pathname;
      } catch {
        return null;
      }
    })();
    if (path !== null && path !== '/') values.push(path);
  }
  const workspace = environment.AGENT_WORKBENCH_DEMO_WORKSPACE?.trim();
  if (workspace) values.push(workspace);
  return Object.freeze(values.filter((value): value is string => Boolean(value)));
};

const sanitizeModelId = (
  modelId: string,
  sensitiveValues: readonly string[],
): string => {
  const containsControlCharacter = [...modelId].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    modelId.length > 200 ||
    containsControlCharacter ||
    sensitiveValues.some((value) => modelId.includes(value))
  ) {
    return REDACTED;
  }
  return modelId;
};

const executeStartedSmoke = async (
  server: WebConsoleServerHandle,
  options: {
    readonly prompt: string;
    readonly pollIntervalMs: number;
    readonly deadline: number;
    readonly sensitiveValues: readonly string[];
  },
  dependencies: WebConsoleRealSmokeDependencies,
): Promise<WebConsoleRealSmokeResult> => {
  let origin: string;
  try {
    origin = new URL(server.url).origin;
  } catch {
    throw smokeError('SMOKE_START_FAILED');
  }

  const html = await requestText(options.deadline, dependencies, server.url);
  const csrfToken = csrfTokenFrom(html);
  const runtime = await requestJson(
    options.deadline,
    dependencies,
    `${origin}/api/runtime`,
    RuntimePublicInfoSchema,
  );
  const created = await requestJson(
    options.deadline,
    dependencies,
    `${origin}/api/sessions`,
    SessionCreatedHttpResponseSchema,
    {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-agent-workbench-csrf': csrfToken,
      },
      body: JSON.stringify({
        submissionId: dependencies.createSubmissionId(),
        prompt: options.prompt,
      }),
    },
  );

  while (true) {
    const { snapshot } = await requestJson(
      options.deadline,
      dependencies,
      `${origin}/api/sessions/${encodeURIComponent(created.sessionId)}/snapshot`,
      SessionSnapshotHttpResponseSchema,
    );
    const turn = snapshot.turns.find((candidate) => candidate.id === created.turnId);
    if (turn !== undefined && isTerminal(turn.status)) {
      assertRequiredLifecycle(snapshot, created.turnId);
      return Object.freeze({
        status: 'ok',
        modelId: sanitizeModelId(runtime.provider.modelId, options.sensitiveValues),
        eventTypeCounts: countEventTypes(snapshot.events),
        turnStatus: 'succeeded',
      });
    }

    const remainingMs = remainingTime(options.deadline, dependencies);
    if (remainingMs <= 0) throw smokeError('SMOKE_TIMEOUT');
    await runBeforeDeadline(
      options.deadline,
      dependencies,
      async (signal) =>
        await dependencies.sleep(
          Math.min(options.pollIntervalMs, remainingMs),
          signal,
        ),
    );
  }
};

const normalizeSmokeFailure = (
  error: unknown,
  fallbackCode: SmokeErrorCode,
): WebConsoleRealSmokeError =>
  error instanceof WebConsoleRealSmokeError ? error : smokeError(fallbackCode);

const cleanupDeadline = (
  deadline: number,
  timeoutMs: number,
  dependencies: Pick<WebConsoleRealSmokeDependencies, 'now'>,
): number => {
  const remainingMs = remainingTime(deadline, dependencies);
  if (remainingMs > 0) return deadline;
  return dependencies.now() + Math.min(timeoutMs, MAX_CLEANUP_TIMEOUT_MS);
};

export const runWebConsoleRealSmoke = async (
  options: WebConsoleRealSmokeOptions = {},
): Promise<WebConsoleRealSmokeSummary> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!isPositiveDuration(timeoutMs) || !isPositiveDuration(pollIntervalMs)) {
    throw smokeError('SMOKE_OPTIONS_INVALID');
  }

  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  const startedAt = dependencies.now();
  const deadline = startedAt + timeoutMs;
  const environment = options.environment ?? process.env;
  requiredEnvironment(environment);
  const cwd = options.cwd ?? process.cwd();
  const prompt = options.prompt?.trim() || DEFAULT_PROMPT;
  let server: WebConsoleServerHandle | undefined;
  let result: WebConsoleRealSmokeResult | undefined;
  let primaryFailure: WebConsoleRealSmokeError | undefined;
  let cleanupFailure: WebConsoleRealSmokeError | undefined;

  try {
    try {
      server = await runBeforeDeadline(
        deadline,
        dependencies,
        async (signal) =>
          await dependencies.startServer({ cwd, environment, signal }),
        (lateServer) => {
          void lateServer.stop().catch(() => undefined);
        },
      );
    } catch (error) {
      throw normalizeSmokeFailure(error, 'SMOKE_START_FAILED');
    }
    result = await executeStartedSmoke(
      server,
      {
        prompt,
        pollIntervalMs,
        deadline,
        sensitiveValues: collectSensitiveValues(environment, cwd),
      },
      dependencies,
    );
  } catch (error) {
    primaryFailure = normalizeSmokeFailure(error, 'SMOKE_HTTP_FAILED');
  } finally {
    if (server !== undefined) {
      try {
        await runBeforeDeadline(
          cleanupDeadline(deadline, timeoutMs, dependencies),
          dependencies,
          async () => await server.stop(),
        );
      } catch {
        cleanupFailure = smokeError('SMOKE_STOP_FAILED');
      }
    }
  }

  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new WebConsoleRealSmokeAggregateError([
      primaryFailure,
      cleanupFailure,
    ]);
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (result === undefined) throw smokeError('SMOKE_RESPONSE_INVALID');
  return Object.freeze({
    ...result,
    durationMs: Math.max(0, dependencies.now() - startedAt),
  });
};

const defaultCliDependencies = (): SmokeCliDependencies => ({
  runSmoke: runWebConsoleRealSmoke,
  writeStdout: (line) => process.stdout.write(line),
  writeStderr: (line) => process.stderr.write(line),
});

export const runWebConsoleRealSmokeCli = async (
  options: WebConsoleRealSmokeOptions = {},
  injectedDependencies: Partial<SmokeCliDependencies> = {},
): Promise<0 | 1> => {
  const dependencies = { ...defaultCliDependencies(), ...injectedDependencies };
  try {
    const summary = await dependencies.runSmoke(options);
    dependencies.writeStdout(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    const failure =
      error instanceof WebConsoleRealSmokeError ||
      error instanceof WebConsoleRealSmokeAggregateError
        ? { status: 'error' as const, code: error.code, message: error.message }
        : {
            status: 'error' as const,
            code: 'SMOKE_FAILED',
            message: 'Web Console real smoke failed',
          };
    dependencies.writeStderr(`${JSON.stringify(failure)}\n`);
    return 1;
  }
};

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  void runWebConsoleRealSmokeCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
