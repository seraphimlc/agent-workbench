import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, writeSync } from 'node:fs';

import {
  createRunnerResponseSchema,
  encodeFrame,
  FrameDecoder,
  RunnerBindNotificationSchema,
  RunnerRequestSchema,
  type ModelCallResult,
  type RunnerBinding,
  type RunnerModelMessage,
  type RunnerRequest,
  type RunnerResponse,
  type ToolExecuteResult,
  type TurnContextGetResult,
} from '@agent-workbench/protocol';

type PendingRequest = {
  readonly request: RunnerRequest;
  resolve(response: RunnerResponse): void;
  reject(error: unknown): void;
};

const input = createReadStream('/dev/null', { fd: 3, autoClose: false });
const output = createWriteStream('/dev/null', { fd: 4, autoClose: false });
const decoder = new FrameDecoder();
const pending = new Map<string, PendingRequest>();
let binding: RunnerBinding | undefined;
let heartbeat: NodeJS.Timeout | undefined;
let exiting = false;

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const maxCycles = positiveInteger(process.env.AGENT_WORKBENCH_RUNNER_MAX_CYCLES, 64);
const heartbeatIntervalMs = positiveInteger(
  process.env.AGENT_WORKBENCH_RUNNER_HEARTBEAT_INTERVAL_MS,
  1_000,
);

const runnerError = (code: string): Error & { readonly code: string } =>
  Object.assign(new Error(code), { code });

const exitWithError = (code: string): void => {
  if (exiting) return;
  exiting = true;
  if (heartbeat) clearInterval(heartbeat);
  for (const request of pending.values()) request.reject(runnerError(code));
  pending.clear();
  const message = `${JSON.stringify({ event: 'runner_error', errorCode: code })}\n`;
  try {
    writeSync(2, message);
  } finally {
    closeSync(3);
    closeSync(4);
    process.exitCode = 1;
  }
};

const exitSuccessfully = (): void => {
  if (exiting) return;
  exiting = true;
  if (heartbeat) clearInterval(heartbeat);
  closeSync(3);
  closeSync(4);
  process.exitCode = 0;
};

const write = (value: unknown): void => {
  if (exiting) throw runnerError('RUNNER_CHANNEL_CLOSED');
  output.write(encodeFrame(value));
};

const request = async (
  method: RunnerRequest['method'],
  payload: unknown,
): Promise<RunnerResponse> => {
  const currentBinding = binding;
  if (!currentBinding) throw runnerError('RUNNER_NOT_BOUND');
  const value = RunnerRequestSchema.parse({
    kind: 'request',
    protocolVersion: 1,
    requestId: randomUUID(),
    traceId: randomUUID(),
    sessionId: currentBinding.sessionId,
    turnId: currentBinding.turnId,
    binding: currentBinding,
    method,
    payload,
  });
  const response = new Promise<RunnerResponse>((resolve, reject) => {
    pending.set(value.requestId, { request: value, resolve, reject });
  });
  write(value);
  return await response;
};

const resultOf = <Result>(response: RunnerResponse): Result => {
  if (!response.ok) throw runnerError(response.error.code);
  return response.result as Result;
};

const handleResponse = (value: unknown): void => {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) {
    exitWithError('RUNNER_RESPONSE_MISMATCH');
    return;
  }
  const requestId = value.requestId;
  if (typeof requestId !== 'string') {
    exitWithError('RUNNER_RESPONSE_MISMATCH');
    return;
  }
  const expected = pending.get(requestId);
  if (!expected) {
    exitWithError('RUNNER_RESPONSE_MISMATCH');
    return;
  }
  const parsed = createRunnerResponseSchema(expected.request).safeParse(value);
  if (!parsed.success) {
    exitWithError('RUNNER_RESPONSE_MISMATCH');
    return;
  }
  pending.delete(requestId);
  expected.resolve(parsed.data);
};

const runAgentLoop = async (): Promise<void> => {
  resultOf(await request('runner.ready', {}));
  heartbeat = setInterval(() => {
    void request('runner.heartbeat', {})
      .then((response) => resultOf(response))
      .catch(() => exitWithError('RUNNER_HEARTBEAT_FAILED'));
  }, heartbeatIntervalMs);
  const context = resultOf<TurnContextGetResult>(
    await request('turn.context.get', {}),
  );
  const messages: RunnerModelMessage[] = [...context.messages];

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const model = resultOf<ModelCallResult>(
      await request('model.call', { messages }),
    );
    if (model.finishReason === 'stop') {
      resultOf(
        await request('turn.complete', { modelAttemptId: model.modelAttemptId }),
      );
      exitSuccessfully();
      return;
    }

    messages.push({
      role: 'assistant',
      content: model.content,
      toolCalls: model.toolCalls,
    });
    for (const toolCall of model.toolCalls) {
      const tool = resultOf<ToolExecuteResult>(
        await request('tool.execute', {
          modelAttemptId: model.modelAttemptId,
          logicalCallId: toolCall.logicalCallId,
        }),
      );
      if (tool.logicalCallId !== toolCall.logicalCallId) {
        throw runnerError('RUNNER_RESPONSE_MISMATCH');
      }
      messages.push({
        role: 'tool',
        logicalCallId: tool.logicalCallId,
        content: tool.content,
      });
    }
  }
  exitWithError('RUNNER_MAX_CYCLES_EXCEEDED');
};

const handleFrame = (value: unknown): void => {
  if (!binding) {
    const parsed = RunnerBindNotificationSchema.safeParse(value);
    if (!parsed.success) {
      exitWithError('RUNNER_BIND_INVALID');
      return;
    }
    binding = Object.freeze({ ...parsed.data.payload });
    void runAgentLoop().catch((error: unknown) => {
      const code =
        typeof error === 'object' && error !== null && 'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'RUNNER_EXECUTION_FAILED';
      exitWithError(code);
    });
    return;
  }
  handleResponse(value);
};

input.on('data', (chunk: Buffer) => {
  if (exiting) return;
  try {
    for (const frame of decoder.push(chunk)) handleFrame(frame);
  } catch {
    exitWithError('RUNNER_CHANNEL_INVALID');
  }
});
input.once('end', () => exitWithError('RUNNER_CHANNEL_EOF'));
input.once('error', () => exitWithError('RUNNER_CHANNEL_ERROR'));
output.once('error', () => exitWithError('RUNNER_CHANNEL_ERROR'));
