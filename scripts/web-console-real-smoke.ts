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
  type WebConsoleServerHandle,
} from '../apps/web-console/src/server/index.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
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

type SmokeServerStartOptions = {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

export type WebConsoleRealSmokeDependencies = {
  readonly startServer: (
    options: SmokeServerStartOptions,
  ) => Promise<WebConsoleServerHandle>;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
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

const defaultDependencies = (): WebConsoleRealSmokeDependencies => ({
  startServer: async ({ cwd, environment }) =>
    await startWebConsoleServer({
      cwd,
      environment,
      dependencies: { writeReady: () => undefined },
    }),
  fetch: globalThis.fetch,
  now: () => Date.now(),
  sleep: async (milliseconds) =>
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, milliseconds);
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

const fetchResponse = async (
  fetchImplementation: typeof globalThis.fetch,
  input: string | URL,
  init?: RequestInit,
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetchImplementation(input, init);
  } catch {
    throw smokeError('SMOKE_HTTP_FAILED');
  }
  if (!response.ok) throw smokeError('SMOKE_HTTP_FAILED');
  return response;
};

type ParseSchema<Value> = {
  parse(value: unknown): Value;
};

const readJson = async <Value>(
  response: Response,
  schema: ParseSchema<Value>,
): Promise<Value> => {
  let body: unknown;
  try {
    body = await response.json();
    return schema.parse(body);
  } catch {
    throw smokeError('SMOKE_RESPONSE_INVALID');
  }
};

const readHtml = async (response: Response): Promise<string> => {
  try {
    return await response.text();
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

const hasEvent = (
  events: readonly RendererSessionEventEnvelope[],
  type: string,
): boolean => events.some((event) => event.type === type);

const assertRequiredLifecycle = (
  snapshot: SessionSnapshot,
  turnId: string,
): void => {
  const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
  if (turn?.status !== 'succeeded') throw smokeError('SMOKE_TURN_FAILED');

  const events = snapshot.events.filter((event) => event.turnId === turnId);
  if (
    !hasEvent(events, 'model.started') ||
    !hasEvent(events, 'model.completed') ||
    !hasEvent(events, 'turn.succeeded')
  ) {
    throw smokeError('SMOKE_REQUIREMENTS_NOT_MET');
  }

  const readToolRunIds = new Set(
    events
      .filter((event) => {
        const payload = payloadRecord(event);
        return event.type === 'tool.started' && payload?.toolId === 'fs.read_text';
      })
      .map((event) => event.toolRunId)
      .filter((toolRunId): toolRunId is string => toolRunId !== null),
  );
  const completedRead = events.some(
    (event) =>
      event.type === 'tool.succeeded' &&
      event.toolRunId !== null &&
      readToolRunIds.has(event.toolRunId),
  );
  if (readToolRunIds.size === 0 || !completedRead) {
    throw smokeError('SMOKE_REQUIREMENTS_NOT_MET');
  }

  const assistant = snapshot.messages.find(
    (message) =>
      message.id === turn.resultMessageId &&
      message.turnId === turnId &&
      message.role === 'assistant' &&
      message.status === 'completed' &&
      message.content.trim().length > 0,
  );
  if (assistant === undefined) throw smokeError('SMOKE_REQUIREMENTS_NOT_MET');
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
    readonly timeoutMs: number;
    readonly pollIntervalMs: number;
    readonly startedAt: number;
    readonly sensitiveValues: readonly string[];
  },
  dependencies: WebConsoleRealSmokeDependencies,
): Promise<WebConsoleRealSmokeSummary> => {
  let origin: string;
  try {
    origin = new URL(server.url).origin;
  } catch {
    throw smokeError('SMOKE_START_FAILED');
  }

  const html = await readHtml(
    await fetchResponse(dependencies.fetch, server.url),
  );
  const csrfToken = csrfTokenFrom(html);
  const runtime = await readJson(
    await fetchResponse(dependencies.fetch, `${origin}/api/runtime`),
    RuntimePublicInfoSchema,
  );
  const created = await readJson(
    await fetchResponse(dependencies.fetch, `${origin}/api/sessions`, {
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
    }),
    SessionCreatedHttpResponseSchema,
  );

  const deadline = dependencies.now() + options.timeoutMs;
  while (true) {
    const { snapshot } = await readJson(
      await fetchResponse(
        dependencies.fetch,
        `${origin}/api/sessions/${encodeURIComponent(created.sessionId)}/snapshot`,
      ),
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
        durationMs: Math.max(0, dependencies.now() - options.startedAt),
      });
    }

    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) throw smokeError('SMOKE_TIMEOUT');
    await dependencies.sleep(Math.min(options.pollIntervalMs, remainingMs));
  }
};

export const runWebConsoleRealSmoke = async (
  options: WebConsoleRealSmokeOptions = {},
): Promise<WebConsoleRealSmokeSummary> => {
  const environment = options.environment ?? process.env;
  requiredEnvironment(environment);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!isPositiveDuration(timeoutMs) || !isPositiveDuration(pollIntervalMs)) {
    throw smokeError('SMOKE_OPTIONS_INVALID');
  }

  const cwd = options.cwd ?? process.cwd();
  const prompt = options.prompt?.trim() || DEFAULT_PROMPT;
  const dependencies = { ...defaultDependencies(), ...options.dependencies };
  const startedAt = dependencies.now();
  let server: WebConsoleServerHandle | undefined;
  let result: WebConsoleRealSmokeSummary | undefined;
  let failure: WebConsoleRealSmokeError | undefined;

  try {
    try {
      server = await dependencies.startServer({ cwd, environment });
    } catch {
      throw smokeError('SMOKE_START_FAILED');
    }
    result = await executeStartedSmoke(
      server,
      {
        prompt,
        timeoutMs,
        pollIntervalMs,
        startedAt,
        sensitiveValues: collectSensitiveValues(environment, cwd),
      },
      dependencies,
    );
  } catch (error) {
    failure =
      error instanceof WebConsoleRealSmokeError
        ? error
        : new WebConsoleRealSmokeError('SMOKE_HTTP_FAILED', 'Web Console HTTP request failed');
  } finally {
    if (server !== undefined) {
      try {
        await server.stop();
      } catch {
        failure ??= smokeError('SMOKE_STOP_FAILED');
      }
    }
  }

  if (failure !== undefined) throw failure;
  if (result === undefined) throw smokeError('SMOKE_RESPONSE_INVALID');
  return result;
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
      error instanceof WebConsoleRealSmokeError
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
