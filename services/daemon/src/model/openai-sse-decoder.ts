export type NormalizedOpenAiToolCall = {
  readonly logicalCallId: string;
  readonly toolId: string;
  readonly argumentsJson: string;
};

export type DecodedOpenAiResponse = {
  readonly finishReason: 'stop' | 'tool_calls';
  readonly content: string | null;
  readonly toolCalls: readonly NormalizedOpenAiToolCall[];
  readonly providerRequestId: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens: number;
  } | null;
};

export type OpenAiDecoderErrorCode =
  | 'MODEL_STREAM_INTERRUPTED'
  | 'MODEL_RESPONSE_INVALID'
  | 'MODEL_PROVIDER_ERROR';

export class OpenAiDecoderError extends Error {
  readonly code: OpenAiDecoderErrorCode;
  readonly status?: number;
  readonly responseBody?: string;
  readonly responseBodyTruncated?: boolean;

  constructor(
    code: OpenAiDecoderErrorCode,
    message: string,
    details: {
      readonly status?: number;
      readonly responseBody?: string;
      readonly responseBodyTruncated?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'OpenAiDecoderError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.responseBody !== undefined) this.responseBody = details.responseBody;
    if (details.responseBodyTruncated !== undefined) {
      this.responseBodyTruncated = details.responseBodyTruncated;
    }
  }
}

type ToolAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

const invalid = (message: string): never => {
  throw new OpenAiDecoderError('MODEL_RESPONSE_INVALID', message);
};

const interrupted = (message: string): never => {
  throw new OpenAiDecoderError('MODEL_STREAM_INTERRUPTED', message);
};

const readBoundedBody = async (
  response: Response,
  limit: number,
): Promise<{ readonly body: string; readonly truncated: boolean }> => {
  const reader = response.body?.getReader();
  if (!reader) return { body: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let captured = 0;
  let truncated = false;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (!next.value) continue;
    const remaining = Math.max(0, limit - captured);
    if (next.value.byteLength > remaining) truncated = true;
    if (remaining > 0) {
      chunks.push(next.value.slice(0, remaining));
      captured += Math.min(remaining, next.value.byteLength);
    }
  }
  const body = new Uint8Array(captured);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(body), truncated };
};

const numberOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export const decodeOpenAiSseResponse = async (
  response: Response,
  options: {
    readonly signal?: AbortSignal;
    readonly maxResponseBytes: number;
    readonly maxErrorBodyBytes: number;
  },
): Promise<DecodedOpenAiResponse> => {
  if (!response.ok) {
    const errorBody = await readBoundedBody(response, options.maxErrorBodyBytes);
    throw new OpenAiDecoderError('MODEL_PROVIDER_ERROR', 'Provider returned a non-success status', {
      status: response.status,
      responseBody: errorBody.body,
      responseBodyTruncated: errorBody.truncated,
    });
  }
  if (!response.body) {
    throw new OpenAiDecoderError('MODEL_STREAM_INTERRUPTED', 'Provider response has no stream body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const tools = new Map<number, ToolAccumulator>();
  let textBuffer = '';
  let eventData: string[] = [];
  let totalBytes = 0;
  let content = '';
  let finishReason: 'stop' | 'tool_calls' | null = null;
  let done = false;
  let providerRequestId: string | null = null;
  let usage: DecodedOpenAiResponse['usage'] = null;

  const dispatchEvent = (data: string): void => {
    if (data === '[DONE]') {
      if (done) invalid('Provider sent duplicate DONE markers');
      done = true;
      return;
    }
    if (done) invalid('Provider sent data after DONE marker');
    if (finishReason !== null) invalid('Provider sent data after terminal finish');
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      invalid('SSE data is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      invalid('SSE event must be an object');
    }
    const event = parsed as Record<string, unknown>;
    if (typeof event.id === 'string') {
      if (providerRequestId !== null && providerRequestId !== event.id) {
        invalid('Provider response id changed during the stream');
      }
      providerRequestId = event.id;
    }
    if (event.usage !== undefined) {
      if (typeof event.usage !== 'object' || event.usage === null || Array.isArray(event.usage)) {
        invalid('Provider usage is invalid');
      }
      const providerUsage = event.usage as Record<string, unknown>;
      const details =
        typeof providerUsage.prompt_tokens_details === 'object' &&
        providerUsage.prompt_tokens_details !== null
          ? (providerUsage.prompt_tokens_details as Record<string, unknown>)
          : {};
      usage = {
        inputTokens: numberOrZero(providerUsage.prompt_tokens),
        outputTokens: numberOrZero(providerUsage.completion_tokens),
        cachedTokens: numberOrZero(details.cached_tokens),
      };
    }
    const choices = event.choices;
    if (!Array.isArray(choices)) invalid('Provider choices are invalid');
    const choiceIndexes = new Set<unknown>();
    for (const rawChoice of choices as unknown[]) {
      if (typeof rawChoice !== 'object' || rawChoice === null || Array.isArray(rawChoice)) {
        invalid('Provider choice is invalid');
      }
      const choice = rawChoice as Record<string, unknown>;
      if (choiceIndexes.has(choice.index)) invalid('Provider choice index is duplicated in one event');
      choiceIndexes.add(choice.index);
      if (choice.index !== 0) continue;
      const rawFinish = choice.finish_reason;
      let normalizedFinish: 'stop' | 'tool_calls' | null = null;
      if (rawFinish !== undefined && rawFinish !== null) {
        if (rawFinish !== 'stop' && rawFinish !== 'tool_calls') invalid('Provider finish reason is invalid');
        normalizedFinish = rawFinish as 'stop' | 'tool_calls';
        if (finishReason !== null && finishReason !== normalizedFinish) {
          invalid('Provider finish reason changed');
        }
      }
      const delta = choice.delta;
      if (typeof delta !== 'object' || delta === null || Array.isArray(delta)) {
        invalid('Provider delta is invalid');
      }
      const deltaObject = delta as Record<string, unknown>;
      if (
        normalizedFinish !== null &&
        ((deltaObject.content !== undefined && deltaObject.content !== null) ||
          deltaObject.tool_calls !== undefined)
      ) {
        invalid('Provider sent a semantic delta with terminal finish');
      }
      if (deltaObject.content !== undefined && deltaObject.content !== null) {
        if (typeof deltaObject.content !== 'string') invalid('Text delta is invalid');
        content += deltaObject.content;
      }
      const toolDeltas = deltaObject.tool_calls;
      if (toolDeltas !== undefined) {
        if (!Array.isArray(toolDeltas)) invalid('Tool Call deltas are invalid');
        const indexes = new Set<number>();
        for (const rawTool of toolDeltas as unknown[]) {
          if (typeof rawTool !== 'object' || rawTool === null || Array.isArray(rawTool)) {
            invalid('Tool Call delta is invalid');
          }
          const tool = rawTool as Record<string, unknown>;
          if (!Number.isSafeInteger(tool.index) || (tool.index as number) < 0) {
            invalid('Tool Call index is invalid');
          }
          const index = tool.index as number;
          if (indexes.has(index)) invalid('Tool Call index is duplicated in one event');
          indexes.add(index);
          const accumulator = tools.get(index) ?? { id: '', name: '', arguments: '' };
          if (tool.id !== undefined) {
            if (typeof tool.id !== 'string') invalid('Tool Call id fragment is invalid');
            accumulator.id += tool.id;
          }
          if (tool.type !== undefined && tool.type !== 'function') {
            invalid('Tool Call type is invalid');
          }
          if (tool.function !== undefined) {
            if (typeof tool.function !== 'object' || tool.function === null || Array.isArray(tool.function)) {
              invalid('Tool Call function fragment is invalid');
            }
            const functionDelta = tool.function as Record<string, unknown>;
            if (functionDelta.name !== undefined) {
              if (typeof functionDelta.name !== 'string') invalid('Tool name fragment is invalid');
              accumulator.name += functionDelta.name;
            }
            if (functionDelta.arguments !== undefined) {
              if (typeof functionDelta.arguments !== 'string') invalid('Tool arguments fragment is invalid');
              accumulator.arguments += functionDelta.arguments;
            }
          }
          tools.set(index, accumulator);
        }
      }
      if (normalizedFinish !== null) finishReason = normalizedFinish;
    }
  };

  const consumeText = (text: string): void => {
    textBuffer += text;
    while (true) {
      const newline = textBuffer.indexOf('\n');
      if (newline < 0) break;
      let line = textBuffer.slice(0, newline);
      textBuffer = textBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length === 0) {
        if (eventData.length > 0) {
          dispatchEvent(eventData.join('\n'));
          eventData = [];
        }
      } else if (line.startsWith('data:')) {
        eventData.push(line.slice(5).replace(/^ /, ''));
      }
    }
  };

  try {
    while (true) {
      if (options.signal?.aborted) interrupted('Model stream was aborted');
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      totalBytes += next.value.byteLength;
      if (totalBytes > options.maxResponseBytes) invalid('Provider response exceeded its byte limit');
      try {
        consumeText(decoder.decode(next.value, { stream: true }));
      } catch {
        invalid('Provider response contains invalid UTF-8');
      }
    }
    try {
      consumeText(decoder.decode());
    } catch {
      invalid('Provider response ends with invalid UTF-8');
    }
    const hasTrailingData = eventData.length > 0 || textBuffer.startsWith('data:');
    if (hasTrailingData && done) invalid('Provider sent incomplete data after DONE marker');
    if (hasTrailingData && finishReason !== null) {
      invalid('Provider sent incomplete data after terminal finish');
    }
  } catch (error) {
    if (error instanceof OpenAiDecoderError) throw error;
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      interrupted('Model stream was aborted');
    }
    interrupted('Model stream ended unexpectedly');
  }

  const terminalFinishReason = finishReason;
  if (!done || terminalFinishReason === null) interrupted('Model stream is incomplete');
  const completedFinishReason = terminalFinishReason as unknown as 'stop' | 'tool_calls';
  const ordered = [...tools.entries()].sort(([left], [right]) => left - right);
  for (const [position, [index]] of ordered.entries()) {
    if (index !== position) invalid('Tool Call indexes are not contiguous');
  }
  const toolCalls = ordered.map(([, tool]) => {
    if (tool.id.length === 0 || tool.name.length === 0 || tool.arguments.length === 0) {
      invalid('Tool Call fragments are incomplete');
    }
    return {
      logicalCallId: tool.id,
      toolId: tool.name,
      argumentsJson: tool.arguments,
    };
  });
  if (completedFinishReason === 'stop') {
    if (toolCalls.length !== 0 || content.trim().length === 0) invalid('Stop response is invalid');
  } else if (toolCalls.length === 0) {
    invalid('Tool response has no Tool Calls');
  }
  return {
    finishReason: completedFinishReason,
    content: content.length === 0 ? null : content,
    toolCalls,
    providerRequestId,
    usage,
  };
};
