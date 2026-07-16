import { posix, win32 } from 'node:path';

import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';

import { ExecutionRepository } from '../db/execution-repository.js';
import { SessionEventWriter } from '../db/session-event-writer.js';
import type { Claim } from '../runtime/scheduler.js';
import { redactSecrets } from '../security/secret-redactor.js';

const TOOL_EVENT_SUMMARY_MAX_BYTES = 1_024;
const TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED';
const UNSAFE_PATH_SUMMARY = '[UNSAFE_PATH]';

export class ToolGatewayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolGatewayError';
    this.code = code;
  }
}

type ToolSourceRow = {
  readonly logicalCallId: string;
  readonly toolId: string;
  readonly argumentsJson: string;
  readonly normalizedInputHash: string;
  readonly modelAttemptId: string;
  readonly attempt: number;
  readonly attemptStatus: string;
  readonly modelCallId: string;
  readonly callStatus: string;
  readonly successfulAttemptId: string | null;
  readonly sessionId: string;
  readonly turnId: string;
};

const parseInput = (json: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new ToolGatewayError('MODEL_TOOL_INPUT_INVALID', 'Persisted Tool input is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ToolGatewayError('MODEL_TOOL_INPUT_INVALID', 'Persisted Tool input is invalid');
  }
  return parsed as Record<string, unknown>;
};

const truncateSummary = (value: string): string => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= TOOL_EVENT_SUMMARY_MAX_BYTES) return value;

  let end = TOOL_EVENT_SUMMARY_MAX_BYTES;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
};

const isSafeRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !value.includes('\0') &&
  !posix.isAbsolute(value) &&
  !win32.isAbsolute(value) &&
  !/^[a-z]:/i.test(value) &&
  !value.split(/[\\/]+/).includes('..');

const summarizeInput = (
  toolId: string,
  argumentsJson: string,
  secrets: readonly string[],
): string => {
  if (toolId !== 'fs.read_text') return UNSAFE_PATH_SUMMARY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    return UNSAFE_PATH_SUMMARY;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return UNSAFE_PATH_SUMMARY;
  }
  const path = (parsed as { readonly path?: unknown }).path;
  if (typeof path !== 'string' || !isSafeRelativePath(path)) return UNSAFE_PATH_SUMMARY;
  return truncateSummary(redactSecrets(path, secrets));
};

export class ToolGateway {
  private readonly repository: ExecutionRepository;
  private readonly events: SessionEventWriter;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly secrets: readonly string[];
  private readonly beforeTerminalEvent: (type: 'tool.succeeded' | 'tool.failed') => void;

  constructor(
    private readonly database: Database.Database,
    private readonly options: {
      readonly handlers: Readonly<
        Record<
          string,
          (input: {
            readonly toolRunId: string;
            readonly toolId: string;
            readonly input: unknown;
          }) => Promise<{ readonly content: string }>
        >
      >;
      readonly now?: () => Date;
      readonly createId?: () => string;
      readonly secrets?: readonly string[];
      readonly beforeTerminalEvent?: (type: 'tool.succeeded' | 'tool.failed') => void;
    },
  ) {
    this.repository = new ExecutionRepository(database);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? uuidv7;
    this.secrets = Object.freeze([...(options.secrets ?? [])]);
    this.beforeTerminalEvent = options.beforeTerminalEvent ?? (() => undefined);
    this.events = new SessionEventWriter(database, { createId: this.createId });
  }

  async execute(input: {
    readonly binding: Claim;
    readonly modelAttemptId: string;
    readonly logicalCallId: string;
  }): Promise<{ readonly toolRunId: string; readonly content: string }> {
    let source!: ToolSourceRow;
    let parsedInput!: Record<string, unknown>;
    let toolRunId = '';
    const startedAt = this.now().toISOString();
    try {
      this.database.transaction(() => {
        try {
          this.repository.readActiveTuple(input.binding, ['running']);
        } catch {
          throw new ToolGatewayError('RUNNER_BINDING_STALE', 'Runner Binding is stale');
        }
        const candidate = this.database
          .prepare(
            `SELECT model_tool_calls.logical_call_id AS logicalCallId,
                    model_tool_calls.tool_id AS toolId,
                    model_tool_calls.arguments_json AS argumentsJson,
                    model_tool_calls.normalized_input_hash AS normalizedInputHash,
                    model_attempts.id AS modelAttemptId,
                    model_attempts.attempt,
                    model_attempts.status AS attemptStatus,
                    model_calls.id AS modelCallId,
                    model_calls.status AS callStatus,
                    model_calls.successful_attempt_id AS successfulAttemptId,
                    model_calls.session_id AS sessionId,
                    model_calls.turn_id AS turnId
             FROM model_tool_calls
             JOIN model_attempts ON model_attempts.id = model_tool_calls.model_attempt_id
             JOIN model_calls ON model_calls.id = model_attempts.model_call_id
             WHERE model_tool_calls.model_attempt_id = ?
               AND model_tool_calls.logical_call_id = ?`,
          )
          .get(input.modelAttemptId, input.logicalCallId) as ToolSourceRow | undefined;
        if (!candidate) {
          const attempt = this.database
            .prepare(
              `SELECT model_calls.session_id AS sessionId, model_calls.turn_id AS turnId
               FROM model_attempts
               JOIN model_calls ON model_calls.id = model_attempts.model_call_id
               WHERE model_attempts.id = ?`,
            )
            .get(input.modelAttemptId) as
            | { readonly sessionId: string; readonly turnId: string }
            | undefined;
          if (
            attempt &&
            (attempt.sessionId !== input.binding.sessionId || attempt.turnId !== input.binding.turnId)
          ) {
            throw new ToolGatewayError('MODEL_TOOL_CALL_NOT_OWNED', 'Tool Call belongs to another Turn');
          }
          throw new ToolGatewayError('MODEL_TOOL_CALL_NOT_FOUND', 'Persisted Tool Call is missing');
        }
        if (
          candidate.sessionId !== input.binding.sessionId ||
          candidate.turnId !== input.binding.turnId
        ) {
          throw new ToolGatewayError('MODEL_TOOL_CALL_NOT_OWNED', 'Tool Call belongs to another Turn');
        }
        if (
          candidate.attemptStatus !== 'succeeded' ||
          candidate.callStatus !== 'succeeded' ||
          candidate.successfulAttemptId !== candidate.modelAttemptId
        ) {
          throw new ToolGatewayError('MODEL_TOOL_CALL_NOT_AUTHORIZED', 'Tool Call source is not successful');
        }
        const duplicate = this.database
          .prepare(
            `SELECT 1 FROM tool_runs
             WHERE source_model_attempt_id = ? AND logical_call_id = ?`,
          )
          .get(candidate.modelAttemptId, candidate.logicalCallId);
        if (duplicate) {
          throw new ToolGatewayError('TOOL_CALL_ALREADY_DISPATCHED', 'Tool Call was already dispatched');
        }
        if (candidate.toolId !== 'fs.read_text') {
          throw new ToolGatewayError('MODEL_TOOL_UNAUTHORIZED', 'Tool is not supported by this gateway');
        }
        if (!this.options.handlers[candidate.toolId]) {
          throw new ToolGatewayError('MODEL_TOOL_UNAUTHORIZED', 'No Tool handler is installed');
        }
        parsedInput = parseInput(candidate.argumentsJson);
        const ordinal = (
          this.database
            .prepare(
              'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM tool_runs WHERE turn_id = ?',
            )
            .get(input.binding.turnId) as { readonly ordinal: number }
        ).ordinal;
        source = candidate;
        toolRunId = this.createId();
        this.database
          .prepare(
            `INSERT INTO tool_runs (
              id, session_id, turn_id, ordinal, logical_call_id,
              source_model_call_id, source_model_attempt_id, attempt,
              operation_id, idempotency_key, source_handle, tool_id, tool_version,
              execution_mode, side_effect_class, status, dispatch_state,
              dispatch_nonce, normalized_input_hash, input_json, result_json,
              effect_state, pid, process_start_identity, error_code, error_message,
              queued_at, started_at, finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, '1',
              'read_inline', 'read', 'running', NULL, NULL, ?, ?, NULL,
              'not_applied', NULL, NULL, NULL, NULL, ?, ?, NULL)`,
          )
          .run(
            toolRunId,
            input.binding.sessionId,
            input.binding.turnId,
            ordinal,
            candidate.logicalCallId,
            candidate.modelCallId,
            candidate.modelAttemptId,
            candidate.attempt,
            this.createId(),
            candidate.toolId,
            candidate.normalizedInputHash,
            candidate.argumentsJson,
            startedAt,
            startedAt,
          );
        this.events.append({
          sessionId: input.binding.sessionId,
          now: startedAt,
          events: [
            {
              turnId: input.binding.turnId,
              toolRunId,
              type: 'tool.started',
              actor: 'tool',
              audience: 'both',
              payload: {
                toolRunId,
                toolId: candidate.toolId,
                inputSummary: summarizeInput(
                  candidate.toolId,
                  candidate.argumentsJson,
                  this.secrets,
                ),
              },
            },
          ],
        });
      }).immediate();
    } catch (error) {
      if (error instanceof ToolGatewayError) throw error;
      throw new ToolGatewayError('TOOL_EXECUTION_REJECTED', 'Tool execution was rejected');
    }

    const handler = this.options.handlers[source.toolId];
    if (!handler) throw new ToolGatewayError('MODEL_TOOL_UNAUTHORIZED', 'No Tool handler is installed');
    let result: { readonly content: string };
    try {
      result = await handler({
        toolRunId,
        toolId: source.toolId,
        input: parsedInput,
      });
    } catch (error) {
      const finishedAt = this.now().toISOString();
      this.database.transaction(() => {
        const completion = this.database
          .prepare(
            `UPDATE tool_runs
             SET status = 'failed', error_code = ?,
                 error_message = 'Tool execution failed', finished_at = ?
             WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
          )
          .run(TOOL_EXECUTION_FAILED, finishedAt, toolRunId);
        if (completion.changes !== 1) {
          throw new ToolGatewayError('TOOL_EXECUTION_REJECTED', 'Tool completion state changed');
        }
        this.beforeTerminalEvent('tool.failed');
        this.events.append({
          sessionId: input.binding.sessionId,
          now: finishedAt,
          events: [
            {
              turnId: input.binding.turnId,
              toolRunId,
              type: 'tool.failed',
              actor: 'tool',
              audience: 'both',
              payload: { toolRunId, errorCode: TOOL_EXECUTION_FAILED },
            },
          ],
        });
      }).immediate();
      throw error;
    }

    const content = redactSecrets(result.content, this.secrets);
    const finishedAt = this.now().toISOString();
    this.database.transaction(() => {
      const completion = this.database
        .prepare(
          `UPDATE tool_runs
           SET status = 'succeeded', result_json = ?, finished_at = ?
           WHERE id = ? AND status = 'running' AND finished_at IS NULL`,
        )
        .run(JSON.stringify({ content }), finishedAt, toolRunId);
      if (completion.changes !== 1) {
        throw new ToolGatewayError('TOOL_EXECUTION_REJECTED', 'Tool completion state changed');
      }
      this.beforeTerminalEvent('tool.succeeded');
      this.events.append({
        sessionId: input.binding.sessionId,
        now: finishedAt,
        events: [
          {
            turnId: input.binding.turnId,
            toolRunId,
            type: 'tool.succeeded',
            actor: 'tool',
            audience: 'both',
            payload: {
              toolRunId,
              outputBytes: Buffer.byteLength(content, 'utf8'),
              outputSummary: truncateSummary(content),
            },
          },
        ],
      });
    }).immediate();
    return { toolRunId, content };
  }
}
