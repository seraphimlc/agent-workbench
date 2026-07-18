import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openRuntimeDatabase } from '../../services/daemon/src/db/database.js';
import { Scheduler, type Claim } from '../../services/daemon/src/runtime/scheduler.js';
import { SessionService } from '../../services/daemon/src/runtime/session-service.js';
import {
  createTempRuntime,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import { startFakeOpenAiServer } from '../../packages/testkit/src/fake-openai-server.js';
import { OpenAiCompatibleAdapter } from '../../services/daemon/src/model/openai-compatible-adapter.js';

type ModelMessage = {
  readonly role: 'system' | 'user';
  readonly content: string;
};

type ProviderToolCall = {
  readonly logicalCallId: string;
  readonly toolId: string;
  readonly argumentsJson: string;
};

type ProviderResult = {
  readonly finishReason: 'stop' | 'tool_calls';
  readonly content: string | null;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly providerRequestId: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens: number;
  } | null;
};

type ModelAdapterRequest = {
  readonly endpoint: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly unknown[];
  readonly signal?: AbortSignal;
};

type ModelAdapter = {
  call(input: ModelAdapterRequest): Promise<ProviderResult>;
};

type ModelGateway = {
  call(input: {
    readonly binding: Claim;
    readonly messages: readonly ModelMessage[];
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly modelAttemptId: string;
    readonly finishReason: 'stop' | 'tool_calls';
    readonly content: string | null;
    readonly toolCalls: readonly ProviderToolCall[];
  }>;
};

type ModelGatewayModule = {
  ModelGateway: new (
    database: Database.Database,
    options: {
      readonly adapter: ModelAdapter;
      readonly provider: {
        readonly endpoint: string;
        readonly modelId: string;
        readonly apiKey: string;
      };
      readonly tools?: readonly unknown[];
      readonly secrets?: readonly string[];
      readonly now: () => Date;
      readonly createId: () => string;
    },
  ) => ModelGateway;
};

type ToolHandlerInput = {
  readonly toolRunId: string;
  readonly toolId: string;
  readonly input: unknown;
};

type ToolGateway = {
  execute(input: {
    readonly binding: Claim;
    readonly modelAttemptId: string;
    readonly logicalCallId: string;
    readonly toolId?: string;
    readonly argumentsJson?: string;
  }): Promise<{ readonly toolRunId: string; readonly content: string }>;
};

type ToolGatewayModule = {
  ToolGateway: new (
    database: Database.Database,
    options: {
      readonly handlers: Readonly<
        Record<string, (input: ToolHandlerInput) => Promise<{ readonly content: string }>>
      >;
      readonly now: () => Date;
      readonly createId: () => string;
      readonly secrets?: readonly string[];
      readonly beforeTerminalEvent?: (type: 'tool.succeeded' | 'tool.failed') => void;
    },
  ) => ToolGateway;
};

type RunnerExecutionDriver = {
  start(claim: Claim): Promise<{ readonly completion: Promise<void> }>;
  shutdown(): Promise<void>;
};

type RunnerSupervisorModule = {
  createRunnerExecutionDriver(options: {
    readonly dataDir: string;
    readonly runnerEntryPoint: string;
    readonly modelAdapter: ModelAdapter;
    readonly provider: {
      readonly endpoint: string;
      readonly modelId: string;
      readonly apiKey: string;
    };
    readonly toolHandlers: Readonly<
      Record<string, (input: ToolHandlerInput) => Promise<{ readonly content: string }>>
    >;
    readonly secrets?: readonly string[];
  }): RunnerExecutionDriver;
};

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

type AuthorizationFixture = {
  readonly database: Database.Database;
  readonly databasePath: string;
  readonly service: SessionService;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly claim: Claim;
};

const MODEL_GATEWAY_MODULE_PATH = '../../services/daemon/src/model/model-gateway.js';
const TOOL_GATEWAY_MODULE_PATH = '../../services/daemon/src/tools/tool-gateway.js';
const RUNNER_SUPERVISOR_MODULE_PATH =
  '../../services/daemon/src/runtime/runner-supervisor.js';
const runnerEntryPoint = fileURLToPath(
  new URL('../../runtimes/session-runner/src/index.ts', import.meta.url),
);
const DAEMON_EPOCH = '018f0000-0000-7000-8000-000000003000';
const START_TIME = '2026-07-15T03:00:00.000Z';
const FINISH_TIME = '2026-07-15T03:00:01.000Z';
const PROVIDER_ENDPOINT = 'https://provider.example.test/v1/chat/completions';
const PROVIDER_MODEL = 'craft-test-model';
const PROVIDER_API_KEY = 'provider-secret-key';
const SECRET_PROMPT = 'Read notes.md and keep prompt-secret out of audit';
const encoder = new TextEncoder();
const PROVIDER_READ_TOOL_NAME = 'fs_read_text';
const PROVIDER_WRITE_TOOL_NAME = 'fs_write_text';

const providerEvent = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const providerTools = [
  {
    type: 'function',
    function: {
      name: 'fs.read_text',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string', minLength: 1 } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs.write_text',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', minLength: 1 },
          content: { type: 'string' },
        },
      },
    },
  },
] as const;

const advertisedProviderTools = [
  {
    ...providerTools[0],
    function: { ...providerTools[0].function, name: PROVIDER_READ_TOOL_NAME },
  },
  {
    ...providerTools[1],
    function: { ...providerTools[1].function, name: PROVIDER_WRITE_TOOL_NAME },
  },
] as const;

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const createIdFactory = (prefix: string): (() => string) => {
  let ordinal = 0;
  return () => `${prefix}-${String(++ordinal)}`;
};

const codedError = (code: string): Error & { readonly code: string } =>
  Object.assign(new Error(code), { code });

const loadModelGateway = async (): Promise<ModelGatewayModule> =>
  (await import(MODEL_GATEWAY_MODULE_PATH)) as unknown as ModelGatewayModule;

const loadToolGateway = async (): Promise<ToolGatewayModule> =>
  (await import(TOOL_GATEWAY_MODULE_PATH)) as unknown as ToolGatewayModule;

const loadRunnerSupervisor = async (): Promise<RunnerSupervisorModule> =>
  (await import(RUNNER_SUPERVISOR_MODULE_PATH)) as unknown as RunnerSupervisorModule;

class ControlledAdapter implements ModelAdapter {
  readonly started = deferred<ModelAdapterRequest>();
  readonly result = deferred<ProviderResult>();
  readonly calls: ModelAdapterRequest[] = [];

  constructor(private readonly beforeCall: (input: ModelAdapterRequest) => void = () => {}) {}

  async call(input: ModelAdapterRequest): Promise<ProviderResult> {
    this.beforeCall(input);
    this.calls.push(input);
    this.started.resolve(input);
    return await this.result.promise;
  }
}

const createFixture = async (runtime: TempRuntime): Promise<AuthorizationFixture> => {
  const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
  const service = new SessionService(database);
  const workspacePath = join(runtime.rootDir, 'workspace');
  mkdirSync(workspacePath);
  const workspace = service.registerWorkspace(
    { path: workspacePath },
    'model-tool-auth-workspace',
  );
  const created = service.createSession(
    {
      workspaceId: workspace.workspaceId,
      title: 'Model Tool authorization',
      prompt: SECRET_PROMPT,
    },
    'model-tool-auth-session',
  );
  const claim = new Scheduler(database, {
    daemonEpoch: DAEMON_EPOCH,
    now: () => new Date(START_TIME),
    createId: createIdFactory('claim'),
  }).claimNext();
  if (!claim) {
    throw new Error('Expected the authorization fixture Turn to be claimed');
  }
  return {
    database,
    databasePath: join(runtime.dataDir, 'runtime.sqlite3'),
    service,
    workspaceId: workspace.workspaceId,
    sessionId: created.sessionId,
    turnId: created.turnId,
    claim,
  };
};

const modelMessages = (): readonly ModelMessage[] => [
  { role: 'system', content: 'Use only fixed builtin Tools.' },
  { role: 'user', content: SECRET_PROMPT },
];

const successfulToolResult = (
  overrides: Partial<ProviderToolCall> = {},
): ProviderResult => ({
  finishReason: 'tool_calls',
  content: null,
  toolCalls: [
    {
      logicalCallId: overrides.logicalCallId ?? 'call-read-notes',
      toolId: overrides.toolId ?? 'fs.read_text',
      argumentsJson: overrides.argumentsJson ?? '{"path":"notes.md"}',
    },
  ],
  providerRequestId: 'provider-request-1',
  usage: { inputTokens: 12, outputTokens: 4, cachedTokens: 2 },
});

const createModelGateway = async (
  fixture: AuthorizationFixture,
  adapter: ModelAdapter,
  provider: {
    readonly endpoint: string;
    readonly modelId: string;
    readonly apiKey: string;
  } = {
    endpoint: PROVIDER_ENDPOINT,
    modelId: PROVIDER_MODEL,
    apiKey: PROVIDER_API_KEY,
  },
): Promise<ModelGateway> => {
  const { ModelGateway } = await loadModelGateway();
  return new ModelGateway(fixture.database, {
    adapter,
    provider,
    now: () => new Date(FINISH_TIME),
    createId: createIdFactory('model-gateway'),
  });
};

const captureAuthorizationFacts = (database: Database.Database): string =>
  JSON.stringify({
    sessions: database.prepare('SELECT * FROM sessions ORDER BY id').all(),
    calls: database.prepare('SELECT * FROM model_calls ORDER BY id').all(),
    attempts: database.prepare('SELECT * FROM model_attempts ORDER BY id').all(),
    toolCalls: database
      .prepare('SELECT * FROM model_tool_calls ORDER BY model_attempt_id, call_index')
      .all(),
    toolRuns: database.prepare('SELECT * FROM tool_runs ORDER BY id').all(),
    events: database
      .prepare('SELECT * FROM session_events ORDER BY session_id, seq')
      .all(),
    audit: database.prepare('SELECT * FROM audit_events ORDER BY global_seq').all(),
  });

const authorizationCounts = (
  database: Database.Database,
): { readonly modelToolCalls: number; readonly toolRuns: number } => ({
  modelToolCalls: (
    database.prepare('SELECT COUNT(*) AS count FROM model_tool_calls').get() as {
      readonly count: number;
    }
  ).count,
  toolRuns: (
    database.prepare('SELECT COUNT(*) AS count FROM tool_runs').get() as {
      readonly count: number;
    }
  ).count,
});

const assertAuditRedacted = (
  payloadJson: string,
  expected: Readonly<Record<string, unknown>>,
): void => {
  expect(JSON.parse(payloadJson)).toMatchObject(expected);
  expect(payloadJson).not.toContain(SECRET_PROMPT);
  expect(payloadJson).not.toContain('notes.md');
  expect(payloadJson).not.toContain(PROVIDER_API_KEY);
  expect(payloadJson).not.toContain('messages');
  expect(payloadJson).not.toContain('argumentsJson');
  expect(payloadJson).not.toContain('credential');
};

const insertSucceededToolCall = (
  database: Database.Database,
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly suffix: string;
    readonly logicalCallId?: string;
    readonly argumentsJson?: string;
  },
): { readonly attemptId: string; readonly logicalCallId: string } => {
  const callId = `model-call-${input.suffix}`;
  const attemptId = `model-attempt-${input.suffix}`;
  const logicalCallId = input.logicalCallId ?? `logical-${input.suffix}`;
  const argumentsJson = input.argumentsJson ?? '{"path":"notes.md"}';
  const resultJson = JSON.stringify(successfulToolResult({ logicalCallId, argumentsJson }));
  const transaction = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO model_calls (
          id, session_id, turn_id, ordinal, kind, status,
          profile_snapshot_json, input_json, result_json,
          successful_attempt_id, error_code, error_message,
          created_at, started_at, finished_at
        ) VALUES (?, ?, ?, 1, 'craft', 'succeeded', '{}', '{}', ?, NULL,
          NULL, NULL, ?, ?, ?)`,
      )
      .run(
        callId,
        input.sessionId,
        input.turnId,
        resultJson,
        START_TIME,
        START_TIME,
        FINISH_TIME,
      );
    database
      .prepare(
        `INSERT INTO model_attempts (
          id, model_call_id, attempt, status, provider_request_id,
          partial_output_json, result_json, finish_reason,
          input_tokens, output_tokens, cached_tokens, latency_ms,
          error_code, error_message, retryable, started_at, finished_at
        ) VALUES (?, ?, 1, 'succeeded', 'provider-seeded', NULL, ?, 'tool_calls',
          1, 1, 0, 1, NULL, NULL, 0, ?, ?)`,
      )
      .run(attemptId, callId, resultJson, START_TIME, FINISH_TIME);
    database
      .prepare('UPDATE model_calls SET successful_attempt_id = ? WHERE id = ?')
      .run(attemptId, callId);
    database
      .prepare(
        `INSERT INTO model_tool_calls (
          model_attempt_id, logical_call_id, call_index, tool_id,
          arguments_json, normalized_input_hash
        ) VALUES (?, ?, 0, 'fs.read_text', ?, ?)`,
      )
      .run(attemptId, logicalCallId, argumentsJson, `hash-${input.suffix}`);
  });
  transaction.immediate();
  return { attemptId, logicalCallId };
};

const readToolEvents = (
  database: Database.Database,
  turnId: string,
): Array<{
  readonly seq: number;
  readonly type: string;
  readonly actor: string;
  readonly audience: string;
  readonly toolRunId: string | null;
  readonly payload: Record<string, unknown>;
}> =>
  (
    database
      .prepare(
        `SELECT seq, type, actor, audience, tool_run_id AS toolRunId,
                payload_json AS payloadJson
         FROM session_events
         WHERE turn_id = ? AND type LIKE 'tool.%'
         ORDER BY seq`,
      )
      .all(turnId) as Array<{
      readonly seq: number;
      readonly type: string;
      readonly actor: string;
      readonly audience: string;
      readonly toolRunId: string | null;
      readonly payloadJson: string;
    }>
  ).map(({ payloadJson, ...event }) => ({
    ...event,
    payload: JSON.parse(payloadJson) as Record<string, unknown>,
  }));

describe('ModelAttempt and ToolCall authorization', () => {
  let runtime: TempRuntime | undefined;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('advertises only Tool definitions backed by production Runner handlers', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const adapter = new ControlledAdapter();
    const { createRunnerExecutionDriver } = await loadRunnerSupervisor();
    const driver = createRunnerExecutionDriver({
      dataDir: runtime.dataDir,
      runnerEntryPoint,
      modelAdapter: adapter,
      provider: {
        endpoint: PROVIDER_ENDPOINT,
        modelId: PROVIDER_MODEL,
        apiKey: PROVIDER_API_KEY,
      },
      toolHandlers: {
        'fs.read_text': async () => ({ content: 'notes' }),
      },
    });

    try {
      const execution = await driver.start(fixture.claim);
      const request = await adapter.started.promise;
      adapter.result.resolve({
        finishReason: 'stop',
        content: 'Done',
        toolCalls: [],
        providerRequestId: 'provider-runner-tools',
        usage: null,
      });
      await execution.completion;

      expect(
        request.tools.map((tool) => (tool as { readonly toolId: string }).toolId),
      ).toEqual(['fs.read_text']);
    } finally {
      await driver.shutdown();
      fixture.database.close();
    }
  });

  it('fails closed when production Runner installs an unknown Tool handler', async () => {
    const { createRunnerExecutionDriver } = await loadRunnerSupervisor();

    expect(() =>
      createRunnerExecutionDriver({
        dataDir: '/unused',
        runnerEntryPoint,
        modelAdapter: new ControlledAdapter(),
        provider: {
          endpoint: PROVIDER_ENDPOINT,
          modelId: PROVIDER_MODEL,
          apiKey: PROVIDER_API_KEY,
        },
        toolHandlers: {
          'shell.exec': async () => ({ content: 'not allowed' }),
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'MODEL_TOOL_UNAUTHORIZED' }));
  });

  it('rejects an unadvertised builtin Tool Call before persistence', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const adapter = new ControlledAdapter();
    const { ModelGateway } = await loadModelGateway();
    const gateway = new ModelGateway(fixture.database, {
      adapter,
      provider: {
        endpoint: PROVIDER_ENDPOINT,
        modelId: PROVIDER_MODEL,
        apiKey: PROVIDER_API_KEY,
      },
      tools: [{ toolId: 'fs.read_text', ...providerTools[0] }],
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('unadvertised-tool'),
    });

    try {
      const call = gateway.call({ binding: fixture.claim, messages: modelMessages() });
      const request = await adapter.started.promise;
      expect(
        request.tools.map((tool) => (tool as { readonly toolId: string }).toolId),
      ).toEqual(['fs.read_text']);
      adapter.result.resolve(
        successfulToolResult({
          toolId: 'fs.write_text',
          argumentsJson: '{"path":"notes.md","content":"unauthorized"}',
        }),
      );

      await expect(call).rejects.toMatchObject({ code: 'MODEL_TOOL_UNAUTHORIZED' });
      expect(authorizationCounts(fixture.database)).toEqual({
        modelToolCalls: 0,
        toolRuns: 0,
      });
    } finally {
      fixture.database.close();
    }
  });

  it('commits running Model facts, start Events, and a redacted audit intent before adapter fetch', async () => {
    await loadModelGateway();
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const observer = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const adapter = new ControlledAdapter((request) => {
      expect(request).toMatchObject({
        endpoint: PROVIDER_ENDPOINT,
        modelId: PROVIDER_MODEL,
        apiKey: PROVIDER_API_KEY,
        messages: modelMessages(),
      });
      expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ toolId: 'fs.read_text' })]));
      expect(
        observer
          .prepare(
            `SELECT status FROM model_calls
             WHERE session_id = ? AND turn_id = ?`,
          )
          .get(fixture.sessionId, fixture.turnId),
      ).toEqual({ status: 'running' });
      expect(
        observer
          .prepare(
            `SELECT model_attempts.status
             FROM model_attempts
             JOIN model_calls ON model_calls.id = model_attempts.model_call_id
             WHERE model_calls.turn_id = ?`,
          )
          .get(fixture.turnId),
      ).toEqual({ status: 'running' });
      expect(
        observer
          .prepare(
            `SELECT type FROM session_events
             WHERE turn_id = ? AND type LIKE 'model.%'
             ORDER BY seq`,
          )
          .all(fixture.turnId),
      ).toEqual([{ type: 'model.started' }, { type: 'model.attempt_started' }]);
      const audit = observer
        .prepare(
          `SELECT phase, action, payload_json AS payloadJson
           FROM audit_events WHERE turn_id = ? ORDER BY global_seq`,
        )
        .all(fixture.turnId) as Array<{
        readonly phase: string;
        readonly action: string;
        readonly payloadJson: string;
      }>;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ phase: 'intent', action: 'model.egress' });
      assertAuditRedacted(audit[0]?.payloadJson ?? '', {
        endpoint: PROVIDER_ENDPOINT,
        modelId: PROVIDER_MODEL,
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });
    const gateway = await createModelGateway(fixture, adapter);

    try {
      const call = gateway.call({ binding: fixture.claim, messages: modelMessages() });
      await adapter.started.promise;
      expect(authorizationCounts(fixture.database)).toEqual({
        modelToolCalls: 0,
        toolRuns: 0,
      });
      adapter.result.resolve(successfulToolResult());

      await expect(call).resolves.toMatchObject({
        finishReason: 'tool_calls',
        content: null,
        toolCalls: successfulToolResult().toolCalls,
      });
      const attempt = fixture.database
        .prepare(
          `SELECT model_attempts.id, model_attempts.status,
                  model_attempts.provider_request_id AS providerRequestId,
                  model_attempts.finish_reason AS finishReason,
                  model_attempts.input_tokens AS inputTokens,
                  model_attempts.output_tokens AS outputTokens,
                  model_attempts.cached_tokens AS cachedTokens,
                  model_calls.status AS callStatus,
                  model_calls.successful_attempt_id AS successfulAttemptId
           FROM model_attempts
           JOIN model_calls ON model_calls.id = model_attempts.model_call_id
           WHERE model_calls.turn_id = ?`,
        )
        .get(fixture.turnId) as Record<string, unknown>;
      expect(attempt).toMatchObject({
        status: 'succeeded',
        providerRequestId: 'provider-request-1',
        finishReason: 'tool_calls',
        inputTokens: 12,
        outputTokens: 4,
        cachedTokens: 2,
        callStatus: 'succeeded',
        successfulAttemptId: attempt.id,
      });
      expect(
        fixture.database.prepare('SELECT * FROM model_tool_calls').all(),
      ).toEqual([
        {
          model_attempt_id: attempt.id,
          logical_call_id: 'call-read-notes',
          call_index: 0,
          tool_id: 'fs.read_text',
          arguments_json: '{"path":"notes.md"}',
          normalized_input_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]);
      expect(
        fixture.database
          .prepare(
            `SELECT type FROM session_events
             WHERE turn_id = ? AND type LIKE 'model.%'
             ORDER BY seq`,
          )
          .all(fixture.turnId),
      ).toEqual([
        { type: 'model.started' },
        { type: 'model.attempt_started' },
        { type: 'model.completed' },
      ]);
      const outcome = fixture.database
        .prepare(
          `SELECT phase, action, payload_json AS payloadJson
           FROM audit_events WHERE turn_id = ? AND phase = 'outcome'`,
        )
        .get(fixture.turnId) as {
        readonly phase: string;
        readonly action: string;
        readonly payloadJson: string;
      };
      expect(outcome).toMatchObject({ phase: 'outcome', action: 'model.egress' });
      assertAuditRedacted(outcome.payloadJson, {
        status: 'succeeded',
        providerRequestId: 'provider-request-1',
      });
      expect(authorizationCounts(fixture.database)).toEqual({
        modelToolCalls: 1,
        toolRuns: 0,
      });
    } finally {
      observer.close();
      fixture.database.close();
    }
  });

  it('redacts registered secrets from validated Provider output before persistence audit and return', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const registeredSecret = 'registered-model-secret';
    const providerRequestId = `request:${registeredSecret}`;
    const rawArguments = JSON.stringify({
      path: `notes-${registeredSecret}.md`,
      content: `write ${registeredSecret}`,
    });
    const redactedArguments = JSON.stringify({
      path: 'notes-[REDACTED].md',
      content: 'write [REDACTED]',
    });
    const result: ProviderResult = {
      finishReason: 'tool_calls',
      content: null,
      toolCalls: [
        {
          logicalCallId: `call:${registeredSecret}`,
          toolId: 'fs.write_text',
          argumentsJson: rawArguments,
        },
      ],
      providerRequestId,
      usage: null,
    };
    const adapter: ModelAdapter = { call: async () => result };
    const { ModelGateway } = await loadModelGateway();
    const gateway = new ModelGateway(fixture.database, {
      adapter,
      provider: {
        endpoint: PROVIDER_ENDPOINT,
        modelId: PROVIDER_MODEL,
        apiKey: PROVIDER_API_KEY,
      },
      secrets: [registeredSecret],
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('model-redaction'),
    });

    try {
      await expect(
        gateway.call({ binding: fixture.claim, messages: modelMessages() }),
      ).resolves.toMatchObject({
        finishReason: 'tool_calls',
        content: null,
        toolCalls: [
          {
            logicalCallId: 'call:[REDACTED]',
            toolId: 'fs.write_text',
            argumentsJson: redactedArguments,
          },
        ],
      });

      const persisted = JSON.stringify({
        calls: fixture.database.prepare('SELECT * FROM model_calls').all(),
        attempts: fixture.database.prepare('SELECT * FROM model_attempts').all(),
        toolCalls: fixture.database.prepare('SELECT * FROM model_tool_calls').all(),
        audit: fixture.database.prepare('SELECT * FROM audit_events').all(),
        events: fixture.database.prepare('SELECT * FROM session_events').all(),
      });
      expect(persisted).not.toContain(registeredSecret);
      expect(
        fixture.database
          .prepare(
            `SELECT provider_request_id AS providerRequestId
             FROM model_attempts WHERE status = 'succeeded'`,
          )
          .get(),
      ).toEqual({ providerRequestId: 'request:[REDACTED]' });
      expect(
        fixture.database
          .prepare(
            `SELECT logical_call_id AS logicalCallId,
                    arguments_json AS argumentsJson,
                    normalized_input_hash AS normalizedInputHash
             FROM model_tool_calls`,
          )
          .get(),
      ).toEqual({
        logicalCallId: 'call:[REDACTED]',
        argumentsJson: redactedArguments,
        normalizedInputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally {
      fixture.database.close();
    }
  });

  it('returns AUDIT_UNAVAILABLE and performs zero network calls when audit intent cannot commit', async () => {
    await loadModelGateway();
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    fixture.database.exec(`
      CREATE TRIGGER reject_model_audit_intent
      BEFORE INSERT ON audit_events
      WHEN NEW.phase = 'intent' AND NEW.action = 'model.egress'
      BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END;
    `);
    const before = captureAuthorizationFacts(fixture.database);
    const adapter = new ControlledAdapter();
    const gateway = await createModelGateway(fixture, adapter);

    try {
      await expect(
        gateway.call({ binding: fixture.claim, messages: modelMessages() }),
      ).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
      expect(adapter.calls).toHaveLength(0);
      expect(captureAuthorizationFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('does not partially commit success when the audit outcome write fails', async () => {
    await loadModelGateway();
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const adapter = new ControlledAdapter();
    const gateway = await createModelGateway(fixture, adapter);

    try {
      const call = gateway.call({ binding: fixture.claim, messages: modelMessages() });
      await adapter.started.promise;
      fixture.database.exec(`
        CREATE TRIGGER reject_model_audit_outcome
        BEFORE INSERT ON audit_events
        WHEN NEW.phase = 'outcome' AND NEW.action = 'model.egress'
        BEGIN SELECT RAISE(FAIL, 'audit outcome unavailable'); END;
      `);
      adapter.result.resolve(successfulToolResult());

      await expect(call).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
      expect(authorizationCounts(fixture.database)).toEqual({
        modelToolCalls: 0,
        toolRuns: 0,
      });
      expect(
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM session_events WHERE type = 'model.completed'")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE phase = 'outcome'")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM model_attempts WHERE status = 'succeeded'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    {
      name: 'malformed Provider response',
      expectedCode: 'MODEL_RESPONSE_INVALID',
      settle: (adapter: ControlledAdapter) =>
        adapter.result.reject(codedError('MODEL_RESPONSE_INVALID')),
    },
    {
      name: 'interrupted Provider stream',
      expectedCode: 'MODEL_STREAM_INTERRUPTED',
      settle: (adapter: ControlledAdapter) =>
        adapter.result.reject(codedError('MODEL_STREAM_INTERRUPTED')),
    },
    {
      name: 'unauthorized Tool id',
      expectedCode: 'MODEL_TOOL_UNAUTHORIZED',
      settle: (adapter: ControlledAdapter) =>
        adapter.result.resolve(successfulToolResult({ toolId: 'shell.exec' })),
    },
    {
      name: 'schema-invalid Tool arguments',
      expectedCode: 'MODEL_TOOL_INPUT_INVALID',
      settle: (adapter: ControlledAdapter) =>
        adapter.result.resolve(successfulToolResult({ argumentsJson: '{}' })),
    },
  ])(
    'persists zero ToolCall and ToolRun rows for $name',
    async ({ expectedCode, settle }) => {
      await loadModelGateway();
      runtime = createTempRuntime();
      const fixture = await createFixture(runtime);
      const adapter = new ControlledAdapter();
      const gateway = await createModelGateway(fixture, adapter);

      try {
        const call = gateway.call({ binding: fixture.claim, messages: modelMessages() });
        await adapter.started.promise;
        settle(adapter);

        await expect(call).rejects.toMatchObject({ code: expectedCode });
        expect(authorizationCounts(fixture.database)).toEqual({
          modelToolCalls: 0,
          toolRuns: 0,
        });
        expect(
          fixture.database
            .prepare(
              `SELECT model_attempts.status AS attemptStatus,
                      model_calls.status AS callStatus
               FROM model_attempts
               JOIN model_calls ON model_calls.id = model_attempts.model_call_id
               WHERE model_calls.turn_id = ?`,
            )
            .get(fixture.turnId),
        ).toEqual({ attemptStatus: 'failed', callStatus: 'failed' });
      } finally {
        fixture.database.close();
      }
    },
  );

  it('rejects post-DONE terminal data through the real adapter without committing success facts', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: `Bearer ${PROVIDER_API_KEY}`,
              'content-type': 'application/json',
            },
            jsonBody: {
              model: PROVIDER_MODEL,
              stream: true,
              messages: modelMessages(),
              tools: advertisedProviderTools,
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [
              encoder.encode(
                providerEvent({
                  id: 'provider-invalid-after-done',
                  choices: [{ index: 0, delta: { content: 'Complete' } }],
                }) +
                  'data: [DONE]\n\n' +
                  providerEvent({
                    id: 'provider-invalid-after-done',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  }),
              ),
            ],
          },
        },
      ],
    });
    const adapter = new OpenAiCompatibleAdapter({ timeoutMs: 5_000 });
    const gateway = await createModelGateway(fixture, adapter, {
      endpoint: new URL('/v1/chat/completions', server.baseUrl).toString(),
      modelId: PROVIDER_MODEL,
      apiKey: PROVIDER_API_KEY,
    });

    try {
      await expect(
        gateway.call({ binding: fixture.claim, messages: modelMessages() }),
      ).rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID' });
      await server.completed;
      expect(authorizationCounts(fixture.database)).toEqual({
        modelToolCalls: 0,
        toolRuns: 0,
      });
      expect(
        fixture.database
          .prepare(
            `SELECT model_attempts.status AS attemptStatus,
                    model_attempts.result_json AS attemptResult,
                    model_attempts.finish_reason AS finishReason,
                    model_calls.status AS callStatus,
                    model_calls.result_json AS callResult,
                    model_calls.successful_attempt_id AS successfulAttemptId
             FROM model_attempts
             JOIN model_calls ON model_calls.id = model_attempts.model_call_id
             WHERE model_calls.turn_id = ?`,
          )
          .get(fixture.turnId),
      ).toEqual({
        attemptStatus: 'failed',
        attemptResult: null,
        finishReason: null,
        callStatus: 'failed',
        callResult: null,
        successfulAttemptId: null,
      });
      expect(
        fixture.database
          .prepare(
            `SELECT type FROM session_events
             WHERE turn_id = ? AND type LIKE 'model.%'
             ORDER BY seq`,
          )
          .all(fixture.turnId),
      ).toEqual([
        { type: 'model.started' },
        { type: 'model.attempt_started' },
        { type: 'model.failed' },
      ]);
    } finally {
      await server.close();
      fixture.database.close();
    }
  });

  it('snapshots one audited Provider authority for the actual adapter egress', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const server = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: 'Bearer immutable-provider-key',
              'content-type': 'application/json',
            },
            jsonBody: {
              model: 'immutable-provider-model',
              stream: true,
              messages: modelMessages(),
              tools: advertisedProviderTools,
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [
              encoder.encode(
                providerEvent({
                  id: 'provider-immutable-authority',
                  choices: [{ index: 0, delta: { content: 'Complete' } }],
                }) +
                  providerEvent({
                    id: 'provider-immutable-authority',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  }) +
                  'data: [DONE]\n\n',
              ),
            ],
          },
        },
      ],
    });
    const provider = {
      endpoint: new URL('/v1/chat/completions', server.baseUrl).toString(),
      modelId: 'immutable-provider-model',
      apiKey: 'immutable-provider-key',
    };
    const auditedEndpoint = provider.endpoint;
    const adapter = new OpenAiCompatibleAdapter({ timeoutMs: 5_000 });
    const { ModelGateway } = await loadModelGateway();
    const gateway = new ModelGateway(fixture.database, {
      adapter,
      provider,
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('immutable-provider'),
    });
    provider.endpoint = 'http://127.0.0.1:1/wrong';
    provider.modelId = 'mutated-model';
    provider.apiKey = 'mutated-key';

    try {
      await expect(
        gateway.call({ binding: fixture.claim, messages: modelMessages() }),
      ).resolves.toMatchObject({ finishReason: 'stop', content: 'Complete' });
      await server.completed;
      const auditPayload = (
        fixture.database
          .prepare(
            `SELECT payload_json AS payloadJson
             FROM audit_events
             WHERE turn_id = ? AND phase = 'intent' AND action = 'model.egress'`,
          )
          .get(fixture.turnId) as { readonly payloadJson: string }
      ).payloadJson;
      expect(JSON.parse(auditPayload)).toMatchObject({
        endpoint: auditedEndpoint,
        modelId: 'immutable-provider-model',
      });
      expect(auditPayload).not.toContain('immutable-provider-key');
      expect(auditPayload).not.toContain('mutated-key');
    } finally {
      await server.close();
      fixture.database.close();
    }
  });

  it('loads persisted Tool id and arguments and ignores a Runner restatement', async () => {
    await loadToolGateway();
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const source = insertSucceededToolCall(fixture.database, {
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      suffix: 'authoritative',
    });
    const handled: ToolHandlerInput[] = [];
    const { ToolGateway } = await loadToolGateway();
    const gateway = new ToolGateway(fixture.database, {
      handlers: {
        'fs.read_text': async (input) => {
          handled.push(input);
          return { content: 'notes' };
        },
      },
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('tool-gateway'),
    });

    try {
      await expect(
        gateway.execute({
          binding: fixture.claim,
          modelAttemptId: source.attemptId,
          logicalCallId: source.logicalCallId,
          toolId: 'fs.write_text',
          argumentsJson: '{"path":"tampered.md","content":"evil"}',
        }),
      ).resolves.toMatchObject({ content: 'notes' });
      expect(handled).toEqual([
        {
          toolRunId: expect.any(String),
          toolId: 'fs.read_text',
          input: { path: 'notes.md' },
        },
      ]);
      expect(
        fixture.database
          .prepare(
            `SELECT logical_call_id, source_model_attempt_id, tool_id,
                    input_json, normalized_input_hash, execution_mode,
                    status, effect_state
             FROM tool_runs`,
          )
          .get(),
      ).toEqual({
        logical_call_id: source.logicalCallId,
        source_model_attempt_id: source.attemptId,
        tool_id: 'fs.read_text',
        input_json: '{"path":"notes.md"}',
        normalized_input_hash: 'hash-authoritative',
        execution_mode: 'read_inline',
        status: 'succeeded',
        effect_state: 'not_applied',
      });
    } finally {
      fixture.database.close();
    }
  });

  it('commits ordered Tool success Events and redacts handler content before persistence and return', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const source = insertSucceededToolCall(fixture.database, {
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      suffix: 'success-events',
    });
    const registeredSecret = 'registered-tool-secret';
    const handlerContent = `${registeredSecret}:${'😀'.repeat(512)}`;
    const redactedContent = `[REDACTED]:${'😀'.repeat(512)}`;
    let handlerObservedCommittedStart = false;
    const { ToolGateway } = await loadToolGateway();
    const gateway = new ToolGateway(fixture.database, {
      handlers: {
        'fs.read_text': async (input) => {
          const running = fixture.database
            .prepare('SELECT status FROM tool_runs WHERE id = ?')
            .get(input.toolRunId);
          const started = fixture.database
            .prepare(
              "SELECT type FROM session_events WHERE tool_run_id = ? AND type = 'tool.started'",
            )
            .get(input.toolRunId);
          handlerObservedCommittedStart =
            !fixture.database.inTransaction &&
            JSON.stringify(running) === JSON.stringify({ status: 'running' }) &&
            JSON.stringify(started) === JSON.stringify({ type: 'tool.started' });
          return { content: handlerContent };
        },
      },
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('success-event-tool'),
      secrets: [registeredSecret],
    });

    try {
      const result = await gateway.execute({
        binding: fixture.claim,
        modelAttemptId: source.attemptId,
        logicalCallId: source.logicalCallId,
      });

      expect(handlerObservedCommittedStart).toBe(true);
      expect(result.content).toBe(redactedContent);
      const toolRun = fixture.database
        .prepare(
          `SELECT id, status, result_json AS resultJson
           FROM tool_runs WHERE id = ?`,
        )
        .get(result.toolRunId) as {
        readonly id: string;
        readonly status: string;
        readonly resultJson: string;
      };
      expect(toolRun).toEqual({
        id: result.toolRunId,
        status: 'succeeded',
        resultJson: JSON.stringify({ content: redactedContent }),
      });
      const events = readToolEvents(fixture.database, fixture.turnId);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        seq: expect.any(Number),
        type: 'tool.started',
        actor: 'tool',
        audience: 'both',
        toolRunId: result.toolRunId,
        payload: {
          toolRunId: result.toolRunId,
          toolId: 'fs.read_text',
          inputSummary: 'notes.md',
        },
      });
      expect(events[1]).toEqual({
        seq: (events[0]?.seq ?? 0) + 1,
        type: 'tool.succeeded',
        actor: 'tool',
        audience: 'both',
        toolRunId: result.toolRunId,
        payload: {
          toolRunId: result.toolRunId,
          outputBytes: Buffer.byteLength(redactedContent, 'utf8'),
          outputSummary: `Result provided to model (${Buffer.byteLength(redactedContent, 'utf8')} bytes).`,
        },
      });
      expect(String(events[1]?.payload.outputSummary)).not.toContain('[REDACTED]');
      expect(String(events[1]?.payload.outputSummary)).not.toContain('😀');
      const sessionSequences = (
        fixture.database
          .prepare('SELECT seq FROM session_events WHERE session_id = ? ORDER BY seq')
          .all(fixture.sessionId) as Array<{ readonly seq: number }>
      ).map((event) => event.seq);
      expect(sessionSequences).toEqual(
        Array.from({ length: sessionSequences.length }, (_, index) => index + 1),
      );
      expect(JSON.stringify({ toolRun, events, result })).not.toContain(registeredSecret);
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    { name: 'POSIX absolute', path: '/outside/secret.txt' },
    { name: 'parent traversal', path: '../outside/secret.txt' },
    { name: 'Windows absolute', path: 'C:\\outside\\secret.txt' },
  ])('uses a stable placeholder for a $name fs.read_text path', async ({ name, path }) => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const source = insertSucceededToolCall(fixture.database, {
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      suffix: `unsafe-path-${name.replaceAll(' ', '-').toLowerCase()}`,
      argumentsJson: JSON.stringify({ path }),
    });
    const { ToolGateway } = await loadToolGateway();
    const gateway = new ToolGateway(fixture.database, {
      handlers: {
        'fs.read_text': async () => ({ content: 'hidden path content' }),
      },
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('unsafe-path-tool'),
    });

    try {
      const result = await gateway.execute({
        binding: fixture.claim,
        modelAttemptId: source.attemptId,
        logicalCallId: source.logicalCallId,
      });
      const started = readToolEvents(fixture.database, fixture.turnId)[0];

      expect(started).toMatchObject({
        type: 'tool.started',
        toolRunId: result.toolRunId,
        payload: {
          toolRunId: result.toolRunId,
          toolId: 'fs.read_text',
          inputSummary: '[UNSAFE_PATH]',
        },
      });
      expect(JSON.stringify(started?.payload)).not.toContain('outside');
      expect(JSON.stringify(started?.payload)).not.toContain('secret.txt');
    } finally {
      fixture.database.close();
    }
  });

  it('rolls back the running ToolRun when tool.started cannot commit', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const source = insertSucceededToolCall(fixture.database, {
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      suffix: 'started-rollback',
    });
    fixture.database.exec(`
      CREATE TRIGGER reject_tool_started
      BEFORE INSERT ON session_events
      WHEN NEW.type = 'tool.started'
      BEGIN SELECT RAISE(FAIL, 'tool.started unavailable'); END;
    `);
    const before = captureAuthorizationFacts(fixture.database);
    let handlerCalls = 0;
    const { ToolGateway } = await loadToolGateway();
    const gateway = new ToolGateway(fixture.database, {
      handlers: {
        'fs.read_text': async () => {
          handlerCalls += 1;
          return { content: 'must not run' };
        },
      },
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('started-rollback-tool'),
    });

    try {
      await expect(
        gateway.execute({
          binding: fixture.claim,
          modelAttemptId: source.attemptId,
          logicalCallId: source.logicalCallId,
        }),
      ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_REJECTED' });
      expect(handlerCalls).toBe(0);
      expect(captureAuthorizationFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('rejects invalid persisted Tool arguments before writing ToolRun or Event state', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const source = insertSucceededToolCall(fixture.database, {
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      suffix: 'invalid-persisted-arguments',
      argumentsJson: '{"path":',
    });
    const before = captureAuthorizationFacts(fixture.database);
    let handlerCalls = 0;
    const { ToolGateway } = await loadToolGateway();
    const gateway = new ToolGateway(fixture.database, {
      handlers: {
        'fs.read_text': async () => {
          handlerCalls += 1;
          return { content: 'must not run' };
        },
      },
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('invalid-persisted-arguments-tool'),
    });

    try {
      await expect(
        gateway.execute({
          binding: fixture.claim,
          modelAttemptId: source.attemptId,
          logicalCallId: source.logicalCallId,
        }),
      ).rejects.toMatchObject({ code: 'MODEL_TOOL_INPUT_INVALID' });
      expect(handlerCalls).toBe(0);
      expect(captureAuthorizationFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });

  it('commits failed Tool status and Event with one stable error code', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const source = insertSucceededToolCall(fixture.database, {
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      suffix: 'failed-event',
    });
    const registeredSecret = 'failed-handler-secret';
    const { ToolGateway } = await loadToolGateway();
    const gateway = new ToolGateway(fixture.database, {
      handlers: {
        'fs.read_text': async () => {
          throw new Error(`handler failed with ${registeredSecret}`);
        },
      },
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('failed-event-tool'),
      secrets: [registeredSecret],
    });

    try {
      await expect(
        gateway.execute({
          binding: fixture.claim,
          modelAttemptId: source.attemptId,
          logicalCallId: source.logicalCallId,
        }),
      ).rejects.toThrow();
      const toolRun = fixture.database
        .prepare(
          `SELECT id, status, result_json AS resultJson, error_code AS errorCode,
                  error_message AS errorMessage
           FROM tool_runs`,
        )
        .get() as Record<string, unknown>;
      expect(toolRun).toMatchObject({
        status: 'failed',
        resultJson: null,
        errorCode: 'TOOL_EXECUTION_FAILED',
        errorMessage: 'Tool execution failed',
      });
      expect(readToolEvents(fixture.database, fixture.turnId)).toEqual([
        {
          seq: expect.any(Number),
          type: 'tool.started',
          actor: 'tool',
          audience: 'both',
          toolRunId: toolRun.id,
          payload: {
            toolRunId: toolRun.id,
            toolId: 'fs.read_text',
            inputSummary: 'notes.md',
          },
        },
        {
          seq: expect.any(Number),
          type: 'tool.failed',
          actor: 'tool',
          audience: 'both',
          toolRunId: toolRun.id,
          payload: {
            toolRunId: toolRun.id,
            errorCode: 'TOOL_EXECUTION_FAILED',
          },
        },
      ]);
      expect(JSON.stringify({ toolRun, events: readToolEvents(fixture.database, fixture.turnId) }))
        .not.toContain(registeredSecret);
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    {
      name: 'succeeded',
      eventType: 'tool.succeeded',
      handler: async () => ({ content: 'terminal result' }),
    },
    {
      name: 'failed',
      eventType: 'tool.failed',
      handler: async () => {
        throw new Error('terminal failure');
      },
    },
  ] as const)(
    'rolls back the $name Tool terminal update when its Event insert fails',
    async ({ name, eventType, handler }) => {
      runtime = createTempRuntime();
      const fixture = await createFixture(runtime);
      const source = insertSucceededToolCall(fixture.database, {
        sessionId: fixture.sessionId,
        turnId: fixture.turnId,
        suffix: `terminal-rollback-${name}`,
      });
      fixture.database.exec(`
        CREATE TRIGGER reject_tool_terminal_event
        BEFORE INSERT ON session_events
        WHEN NEW.type = '${eventType}'
        BEGIN SELECT RAISE(FAIL, 'terminal Event unavailable'); END;
      `);
      const { ToolGateway } = await loadToolGateway();
      const gateway = new ToolGateway(fixture.database, {
        handlers: { 'fs.read_text': handler },
        now: () => new Date(FINISH_TIME),
        createId: createIdFactory('terminal-rollback-tool'),
      });

      try {
        await expect(
          gateway.execute({
            binding: fixture.claim,
            modelAttemptId: source.attemptId,
            logicalCallId: source.logicalCallId,
          }),
        ).rejects.toThrow();
        expect(
          fixture.database
            .prepare(
              `SELECT status, result_json AS resultJson, error_code AS errorCode,
                      error_message AS errorMessage, finished_at AS finishedAt
               FROM tool_runs`,
            )
            .get(),
        ).toEqual({
          status: 'running',
          resultJson: null,
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
        });
        expect(readToolEvents(fixture.database, fixture.turnId).map((event) => event.type)).toEqual([
          'tool.started',
        ]);
      } finally {
        fixture.database.close();
      }
    },
  );

  it('passes Provider and registered secrets from RunnerExecutionDriver into ModelGateway and ToolGateway', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const providerSecret = 'driver-provider-secret';
    const bootstrapSecret = Buffer.alloc(32, 0x7a);
    const bootstrapHex = bootstrapSecret.toString('hex');
    const bootstrapBase64 = bootstrapSecret.toString('base64');
    const returnedContent = `${providerSecret}:${bootstrapHex}:${bootstrapBase64}:visible`;
    const redactedContent = '[REDACTED]:[REDACTED]:[REDACTED]:visible';
    const finalContent = `${providerSecret}:${bootstrapHex}:${bootstrapBase64}:done`;
    const redactedFinalContent = '[REDACTED]:[REDACTED]:[REDACTED]:done';
    let callIndex = 0;
    let toolMessageContent: string | undefined;
    const adapter: ModelAdapter = {
      call: async (input) => {
        callIndex += 1;
        if (callIndex === 1) return successfulToolResult();
        toolMessageContent = (
          input.messages as unknown as Array<{ readonly role: string; readonly content: string }>
        ).find((message) => message.role === 'tool')?.content;
        return {
          finishReason: 'stop',
          content: finalContent,
          toolCalls: [],
          providerRequestId: 'provider-driver-stop',
          usage: null,
        };
      },
    };
    const { createRunnerExecutionDriver } = await loadRunnerSupervisor();
    const driver = createRunnerExecutionDriver({
      dataDir: runtime.dataDir,
      runnerEntryPoint,
      modelAdapter: adapter,
      provider: {
        endpoint: PROVIDER_ENDPOINT,
        modelId: PROVIDER_MODEL,
        apiKey: providerSecret,
      },
      secrets: [bootstrapHex, bootstrapBase64],
      toolHandlers: {
        'fs.read_text': async () => ({ content: returnedContent }),
      },
    });

    try {
      const execution = await driver.start(fixture.claim);
      await execution.completion;

      expect(callIndex).toBe(2);
      expect(toolMessageContent).toBe(redactedContent);
      const persisted = JSON.stringify({
        toolRuns: fixture.database.prepare('SELECT * FROM tool_runs').all(),
        events: fixture.database.prepare('SELECT * FROM session_events').all(),
        modelCalls: fixture.database.prepare('SELECT * FROM model_calls').all(),
        messages: fixture.database.prepare('SELECT * FROM messages').all(),
      });
      expect(persisted).not.toContain(providerSecret);
      expect(persisted).not.toContain(bootstrapHex);
      expect(persisted).not.toContain(bootstrapBase64);
      expect(
        fixture.database
          .prepare(
            `SELECT content FROM messages
             WHERE session_id = ? AND role = 'assistant'
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(fixture.sessionId),
      ).toEqual({ content: redactedFinalContent });
      expect(
        fixture.database.prepare('SELECT result_json AS resultJson FROM tool_runs').get(),
      ).toEqual({ resultJson: JSON.stringify({ content: redactedContent }) });
    } finally {
      await driver.shutdown();
      fixture.database.close();
      bootstrapSecret.fill(0);
    }
  });

  it('fails closed when Tool completion loses its running-state CAS', async () => {
    await loadToolGateway();
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const source = insertSucceededToolCall(fixture.database, {
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      suffix: 'completion-cas',
    });
    const { ToolGateway } = await loadToolGateway();
    const gateway = new ToolGateway(fixture.database, {
      handlers: {
        'fs.read_text': async (input) => {
          fixture.database
            .prepare(
              `UPDATE tool_runs
               SET status = 'failed', error_code = 'CONCURRENT_COMPLETION',
                   error_message = 'Concurrent completion won', finished_at = ?
               WHERE id = ? AND status = 'running'`,
            )
            .run(FINISH_TIME, input.toolRunId);
          return { content: 'must not escape' };
        },
      },
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('completion-cas-tool'),
    });

    try {
      await expect(
        gateway.execute({
          binding: fixture.claim,
          modelAttemptId: source.attemptId,
          logicalCallId: source.logicalCallId,
        }),
      ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_REJECTED' });
      expect(
        fixture.database
          .prepare(
            `SELECT status, result_json AS resultJson, error_code AS errorCode
             FROM tool_runs`,
          )
          .get(),
      ).toEqual({
        status: 'failed',
        resultJson: null,
        errorCode: 'CONCURRENT_COMPLETION',
      });
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    {
      name: 'stale Lease',
      expectedCode: 'RUNNER_BINDING_STALE',
      mutate: (
        fixture: AuthorizationFixture,
        source: { readonly attemptId: string; readonly logicalCallId: string },
      ) => {
        fixture.database
          .prepare("UPDATE runner_leases SET status = 'expired' WHERE id = ?")
          .run(fixture.claim.leaseId);
        return source;
      },
    },
    {
      name: 'cross-Turn Attempt',
      expectedCode: 'MODEL_TOOL_CALL_NOT_OWNED',
      mutate: (fixture: AuthorizationFixture) => {
        const foreign = fixture.service.createSession(
          {
            workspaceId: fixture.workspaceId,
            title: 'Foreign Tool source',
            prompt: 'Foreign prompt',
          },
          'foreign-tool-source',
        );
        return insertSucceededToolCall(fixture.database, {
          sessionId: foreign.sessionId,
          turnId: foreign.turnId,
          suffix: 'foreign',
        });
      },
    },
    {
      name: 'tampered logicalCallId',
      expectedCode: 'MODEL_TOOL_CALL_NOT_FOUND',
      mutate: (
        _fixture: AuthorizationFixture,
        source: { readonly attemptId: string; readonly logicalCallId: string },
      ) => ({ ...source, logicalCallId: `${source.logicalCallId}-tampered` }),
    },
  ])('rejects $name with a zero-write ToolRun snapshot', async ({ expectedCode, mutate }) => {
    await loadToolGateway();
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const source = insertSucceededToolCall(fixture.database, {
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      suffix: 'reference',
    });
    const attempted = mutate(fixture, source);
    const before = fixture.database.prepare('SELECT * FROM tool_runs ORDER BY id').all();
    const { ToolGateway } = await loadToolGateway();
    const gateway = new ToolGateway(fixture.database, {
      handlers: {
        'fs.read_text': async () => ({ content: 'must not run' }),
      },
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('rejected-tool'),
    });

    try {
      await expect(
        gateway.execute({
          binding: fixture.claim,
          modelAttemptId: attempted.attemptId,
          logicalCallId: attempted.logicalCallId,
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(fixture.database.prepare('SELECT * FROM tool_runs ORDER BY id').all()).toEqual(
        before,
      );
    } finally {
      fixture.database.close();
    }
  });

  it('rejects duplicate dispatch of the same persisted Tool Call', async () => {
    await loadToolGateway();
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    const source = insertSucceededToolCall(fixture.database, {
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      suffix: 'duplicate',
    });
    let handlerCalls = 0;
    const { ToolGateway } = await loadToolGateway();
    const gateway = new ToolGateway(fixture.database, {
      handlers: {
        'fs.read_text': async () => {
          handlerCalls += 1;
          return { content: 'notes' };
        },
      },
      now: () => new Date(FINISH_TIME),
      createId: createIdFactory('duplicate-tool'),
    });

    try {
      await gateway.execute({
        binding: fixture.claim,
        modelAttemptId: source.attemptId,
        logicalCallId: source.logicalCallId,
      });
      const before = fixture.database.prepare('SELECT * FROM tool_runs ORDER BY id').all();

      await expect(
        gateway.execute({
          binding: fixture.claim,
          modelAttemptId: source.attemptId,
          logicalCallId: source.logicalCallId,
        }),
      ).rejects.toMatchObject({ code: 'TOOL_CALL_ALREADY_DISPATCHED' });
      expect(fixture.database.prepare('SELECT * FROM tool_runs ORDER BY id').all()).toEqual(
        before,
      );
      expect(handlerCalls).toBe(1);
    } finally {
      fixture.database.close();
    }
  });
});
