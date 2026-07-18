import { createHash } from 'node:crypto';

import type { RunnerModelMessage } from '@agent-workbench/protocol';
import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';

import { ExecutionRepository } from '../db/execution-repository.js';
import { SessionEventWriter } from '../db/session-event-writer.js';
import type { Claim } from '../runtime/scheduler.js';
import { redactSecrets } from '../security/secret-redactor.js';

export type ModelMessage = RunnerModelMessage;

export type ProviderToolCall = {
  readonly logicalCallId: string;
  readonly toolId: string;
  readonly argumentsJson: string;
};

export type ProviderResult = {
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

export type ModelAdapter = {
  call(input: {
    readonly endpoint: string;
    readonly modelId: string;
    readonly apiKey: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly unknown[];
    readonly signal?: AbortSignal;
  }): Promise<ProviderResult>;
};

export class ModelGatewayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModelGatewayError';
    this.code = code;
  }
}

type ValidatedToolCall = ProviderToolCall & {
  readonly callIndex: number;
  readonly normalizedInputHash: string;
};

export const BUILTIN_TOOL_DEFINITIONS = Object.freeze({
  'fs.read_text': {
    toolId: 'fs.read_text',
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
  'fs.write_text': {
    toolId: 'fs.write_text',
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
} as const);

type BuiltinToolId = keyof typeof BUILTIN_TOOL_DEFINITIONS;

export const selectBuiltinToolDefinitions = (
  toolIds: readonly string[],
): readonly unknown[] =>
  toolIds.map((toolId) => {
    if (!Object.hasOwn(BUILTIN_TOOL_DEFINITIONS, toolId)) {
      throw new ModelGatewayError('MODEL_TOOL_UNAUTHORIZED', 'Tool id is not allowlisted');
    }
    return BUILTIN_TOOL_DEFINITIONS[toolId as BuiltinToolId];
  });

const DEFAULT_BUILTIN_TOOLS = Object.freeze(
  selectBuiltinToolDefinitions(Object.keys(BUILTIN_TOOL_DEFINITIONS)),
);

const toolDefinitionId = (definition: unknown): string | undefined => {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return undefined;
  }
  const toolId = (definition as Record<string, unknown>).toolId;
  return typeof toolId === 'string' && toolId.length > 0 ? toolId : undefined;
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined;

const parseObject = (json: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new ModelGatewayError('MODEL_TOOL_INPUT_INVALID', 'Tool arguments are not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ModelGatewayError('MODEL_TOOL_INPUT_INVALID', 'Tool arguments must be an object');
  }
  return parsed as Record<string, unknown>;
};

const redactJsonValue = (value: unknown, secrets: readonly string[]): unknown => {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, secrets));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactJsonValue(item, secrets)]),
  );
};

const redactArgumentsJson = (
  argumentsJson: string,
  secrets: readonly string[],
): string => JSON.stringify(redactJsonValue(parseObject(argumentsJson), secrets));

const redactProviderResult = (
  result: ProviderResult,
  secrets: readonly string[],
): ProviderResult => ({
  ...result,
  content: result.content === null ? null : redactSecrets(result.content, secrets),
  toolCalls: result.toolCalls.map((toolCall) => ({
    logicalCallId: redactSecrets(toolCall.logicalCallId, secrets),
    toolId: redactSecrets(toolCall.toolId, secrets),
    argumentsJson: redactArgumentsJson(toolCall.argumentsJson, secrets),
  })),
  providerRequestId:
    result.providerRequestId === null
      ? null
      : redactSecrets(result.providerRequestId, secrets),
});

const validateArguments = (toolId: string, argumentsJson: string): void => {
  const input = parseObject(argumentsJson);
  if (toolId === 'fs.read_text') {
    if (
      Object.keys(input).length !== 1 ||
      typeof input.path !== 'string' ||
      input.path.length === 0
    ) {
      throw new ModelGatewayError('MODEL_TOOL_INPUT_INVALID', 'fs.read_text input is invalid');
    }
    return;
  }
  if (toolId === 'fs.write_text') {
    if (
      Object.keys(input).length !== 2 ||
      typeof input.path !== 'string' ||
      input.path.length === 0 ||
      typeof input.content !== 'string'
    ) {
      throw new ModelGatewayError('MODEL_TOOL_INPUT_INVALID', 'fs.write_text input is invalid');
    }
    return;
  }
  throw new ModelGatewayError('MODEL_TOOL_UNAUTHORIZED', 'Tool id is not allowlisted');
};

const validateProviderResult = (
  result: ProviderResult,
  authorizedToolIds: ReadonlySet<string>,
): ValidatedToolCall[] => {
  if (result.finishReason === 'stop') {
    if (
      result.content === null ||
      result.content.trim().length === 0 ||
      result.toolCalls.length !== 0
    ) {
      throw new ModelGatewayError('MODEL_RESPONSE_INVALID', 'Final stop response is invalid');
    }
    return [];
  }
  if (result.toolCalls.length === 0) {
    throw new ModelGatewayError('MODEL_RESPONSE_INVALID', 'Tool response has no Tool Calls');
  }
  const logicalIds = new Set<string>();
  return result.toolCalls.map((toolCall, callIndex) => {
    if (
      toolCall.logicalCallId.length === 0 ||
      toolCall.toolId.length === 0 ||
      logicalIds.has(toolCall.logicalCallId)
    ) {
      throw new ModelGatewayError('MODEL_RESPONSE_INVALID', 'Tool Call identity is invalid');
    }
    if (!authorizedToolIds.has(toolCall.toolId)) {
      throw new ModelGatewayError('MODEL_TOOL_UNAUTHORIZED', 'Tool id was not advertised');
    }
    logicalIds.add(toolCall.logicalCallId);
    validateArguments(toolCall.toolId, toolCall.argumentsJson);
    return {
      ...toolCall,
      callIndex,
      normalizedInputHash: sha256(toolCall.argumentsJson),
    };
  });
};

export class ModelGateway {
  private readonly repository: ExecutionRepository;
  private readonly events: SessionEventWriter;
  private readonly adapter: ModelAdapter;
  private readonly provider: {
    readonly endpoint: string;
    readonly modelId: string;
    readonly apiKey: string;
  };
  private readonly tools: readonly unknown[];
  private readonly authorizedToolIds: ReadonlySet<string>;
  private readonly secrets: readonly string[];
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly database: Database.Database,
    options: {
      readonly adapter: ModelAdapter;
      readonly provider: {
        readonly endpoint: string;
        readonly modelId: string;
        readonly apiKey: string;
      };
      readonly tools?: readonly unknown[];
      readonly secrets?: readonly string[];
      readonly now?: () => Date;
      readonly createId?: () => string;
    },
  ) {
    this.adapter = options.adapter;
    this.provider = { ...options.provider };
    this.tools = Object.freeze([...(options.tools ?? DEFAULT_BUILTIN_TOOLS)]);
    this.authorizedToolIds = new Set(
      this.tools
        .map((tool) => toolDefinitionId(tool))
        .filter((toolId): toolId is string => toolId !== undefined),
    );
    this.secrets = Object.freeze([...(options.secrets ?? [])]);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? uuidv7;
    this.repository = new ExecutionRepository(database);
    this.events = new SessionEventWriter(database, { createId: this.createId });
  }

  async call(input: {
    readonly binding: Claim;
    readonly messages: readonly ModelMessage[];
    readonly signal?: AbortSignal;
    readonly abortDisposition?: 'failure' | 'external_interrupt';
  }): Promise<{
    readonly modelAttemptId: string;
    readonly finishReason: 'stop' | 'tool_calls';
    readonly content: string | null;
    readonly toolCalls: readonly ProviderToolCall[];
  }> {
    const startedAt = this.now().toISOString();
    const modelCallId = this.createId();
    const modelAttemptId = this.createId();
    const operationKey = `model.egress:${modelAttemptId}`;
    const requestHash = sha256(
      JSON.stringify({
        endpoint: this.provider.endpoint,
        modelId: this.provider.modelId,
        messages: input.messages,
        tools: this.tools,
      }),
    );

    try {
      this.database.transaction(() => {
        this.repository.readActiveTuple(input.binding, ['running']);
        const ordinal = (
          this.database
            .prepare(
              'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM model_calls WHERE turn_id = ?',
            )
            .get(input.binding.turnId) as { readonly ordinal: number }
        ).ordinal;
        this.database
          .prepare(
            `INSERT INTO model_calls (
              id, session_id, turn_id, ordinal, kind, status,
              profile_snapshot_json, input_json, result_json,
              successful_attempt_id, error_code, error_message,
              created_at, started_at, finished_at
            ) VALUES (?, ?, ?, ?, 'craft', 'running', ?, ?, NULL,
              NULL, NULL, NULL, ?, ?, NULL)`,
          )
          .run(
            modelCallId,
            input.binding.sessionId,
            input.binding.turnId,
            ordinal,
            JSON.stringify({
              endpoint: this.provider.endpoint,
              modelId: this.provider.modelId,
            }),
            JSON.stringify({ messages: input.messages }),
            startedAt,
            startedAt,
          );
        this.database
          .prepare(
            `INSERT INTO model_attempts (
              id, model_call_id, attempt, status, provider_request_id,
              partial_output_json, result_json, finish_reason,
              input_tokens, output_tokens, cached_tokens, latency_ms,
              error_code, error_message, retryable, started_at, finished_at
            ) VALUES (?, ?, 1, 'running', NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
          )
          .run(modelAttemptId, modelCallId, startedAt);
        this.events.append({
          sessionId: input.binding.sessionId,
          now: startedAt,
          events: [
            { turnId: input.binding.turnId, type: 'model.started', payload: { modelCallId } },
            {
              turnId: input.binding.turnId,
              type: 'model.attempt_started',
              payload: { modelCallId, modelAttemptId, attempt: 1 },
            },
          ],
        });
        this.database
          .prepare(
            `INSERT INTO audit_events (
              id, session_id, turn_id, operation_key, phase, action,
              payload_json, created_at
            ) VALUES (?, ?, ?, ?, 'intent', 'model.egress', ?, ?)`,
          )
          .run(
            this.createId(),
            input.binding.sessionId,
            input.binding.turnId,
            operationKey,
            JSON.stringify({
              endpoint: this.provider.endpoint,
              modelId: this.provider.modelId,
              requestHash,
            }),
            startedAt,
          );
      }).immediate();
    } catch {
      throw new ModelGatewayError('AUDIT_UNAVAILABLE', 'Model audit intent could not commit');
    }

    let providerResult: ProviderResult;
    try {
      providerResult = await this.adapter.call({
        endpoint: this.provider.endpoint,
        modelId: this.provider.modelId,
        apiKey: this.provider.apiKey,
        messages: input.messages,
        tools: this.tools,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      const code = errorCode(error) ?? 'MODEL_RESPONSE_INVALID';
      if (
        input.abortDisposition === 'external_interrupt' &&
        input.signal?.aborted &&
        code === 'MODEL_STREAM_INTERRUPTED'
      ) {
        throw new ModelGatewayError(code, error instanceof Error ? error.message : code);
      }
      this.commitFailure(input.binding, modelCallId, modelAttemptId, operationKey, code);
      throw new ModelGatewayError(code, error instanceof Error ? error.message : code);
    }

    let safeProviderResult: ProviderResult;
    let toolCalls: ValidatedToolCall[];
    try {
      safeProviderResult = redactProviderResult(providerResult, this.secrets);
      toolCalls = validateProviderResult(safeProviderResult, this.authorizedToolIds);
    } catch (error) {
      const code = errorCode(error) ?? 'MODEL_RESPONSE_INVALID';
      this.commitFailure(input.binding, modelCallId, modelAttemptId, operationKey, code);
      throw error;
    }

    const finishedAt = this.now().toISOString();
    const normalizedResult = {
      finishReason: safeProviderResult.finishReason,
      content: safeProviderResult.content,
      toolCalls: safeProviderResult.toolCalls,
    };
    try {
      this.database.transaction(() => {
        this.repository.readActiveTuple(input.binding, ['running']);
        for (const toolCall of toolCalls) {
          this.database
            .prepare(
              `INSERT INTO model_tool_calls (
                model_attempt_id, logical_call_id, call_index, tool_id,
                arguments_json, normalized_input_hash
              ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              modelAttemptId,
              toolCall.logicalCallId,
              toolCall.callIndex,
              toolCall.toolId,
              toolCall.argumentsJson,
              toolCall.normalizedInputHash,
            );
        }
        const usage = providerResult.usage;
        const attemptChange = this.database
          .prepare(
            `UPDATE model_attempts
             SET status = 'succeeded', provider_request_id = ?, result_json = ?,
                 finish_reason = ?, input_tokens = ?, output_tokens = ?,
                 cached_tokens = ?, retryable = 0, finished_at = ?
             WHERE id = ? AND model_call_id = ? AND status = 'running'
               AND finished_at IS NULL`,
          )
          .run(
            safeProviderResult.providerRequestId,
            JSON.stringify(normalizedResult),
            safeProviderResult.finishReason,
            usage?.inputTokens ?? null,
            usage?.outputTokens ?? null,
            usage?.cachedTokens ?? null,
            finishedAt,
            modelAttemptId,
            modelCallId,
          );
        if (attemptChange.changes !== 1) throw new Error('ModelAttempt success CAS failed');
        const callChange = this.database
          .prepare(
            `UPDATE model_calls
             SET status = 'succeeded', result_json = ?, successful_attempt_id = ?,
                 finished_at = ?
             WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
          )
          .run(JSON.stringify(normalizedResult), modelAttemptId, finishedAt, modelCallId);
        if (callChange.changes !== 1) throw new Error('ModelCall success CAS failed');
        this.events.append({
          sessionId: input.binding.sessionId,
          now: finishedAt,
          events: [
            {
              turnId: input.binding.turnId,
              type: 'model.completed',
              payload: { modelCallId, modelAttemptId },
            },
          ],
        });
        this.database
          .prepare(
            `INSERT INTO audit_events (
              id, session_id, turn_id, operation_key, phase, action,
              payload_json, created_at
            ) VALUES (?, ?, ?, ?, 'outcome', 'model.egress', ?, ?)`,
          )
          .run(
            this.createId(),
            input.binding.sessionId,
            input.binding.turnId,
            operationKey,
            JSON.stringify({
              status: 'succeeded',
              providerRequestId: safeProviderResult.providerRequestId,
            }),
            finishedAt,
          );
      }).immediate();
    } catch {
      throw new ModelGatewayError('AUDIT_UNAVAILABLE', 'Model audit outcome could not commit');
    }

    return {
      modelAttemptId,
      finishReason: safeProviderResult.finishReason,
      content: safeProviderResult.content,
      toolCalls: safeProviderResult.toolCalls,
    };
  }

  private commitFailure(
    binding: Claim,
    modelCallId: string,
    modelAttemptId: string,
    operationKey: string,
    code: string,
  ): void {
    const finishedAt = this.now().toISOString();
    try {
      this.database.transaction(() => {
        this.repository.readActiveTuple(binding, ['running']);
        this.database
          .prepare(
            `UPDATE model_attempts
             SET status = 'failed', error_code = ?, error_message = ?,
                 retryable = 0, finished_at = ?
             WHERE id = ? AND model_call_id = ? AND status = 'running'
               AND finished_at IS NULL`,
          )
          .run(code, code, finishedAt, modelAttemptId, modelCallId);
        this.database
          .prepare(
            `UPDATE model_calls
             SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
             WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
          )
          .run(code, code, finishedAt, modelCallId);
        this.events.append({
          sessionId: binding.sessionId,
          now: finishedAt,
          events: [
            {
              turnId: binding.turnId,
              type: 'model.failed',
              payload: { modelCallId, modelAttemptId, errorCode: code },
            },
          ],
        });
        this.database
          .prepare(
            `INSERT INTO audit_events (
              id, session_id, turn_id, operation_key, phase, action,
              payload_json, created_at
            ) VALUES (?, ?, ?, ?, 'outcome', 'model.egress', ?, ?)`,
          )
          .run(
            this.createId(),
            binding.sessionId,
            binding.turnId,
            operationKey,
            JSON.stringify({ status: 'failed', errorCode: code }),
            finishedAt,
          );
      }).immediate();
    } catch {
      throw new ModelGatewayError('AUDIT_UNAVAILABLE', 'Model failure audit could not commit');
    }
  }
}
