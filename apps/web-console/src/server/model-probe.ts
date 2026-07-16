import { BUILTIN_TOOL_DEFINITIONS } from '@agent-workbench/daemon/model/model-gateway';
import { OpenAiCompatibleAdapter } from '@agent-workbench/daemon/model/openai-compatible-adapter';
import { z } from 'zod';

import type { ProviderPrivateConfig } from './config.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 45_000;
const MAX_CANDIDATES = 3;
const CHAT_MESSAGES = [{ role: 'user', content: 'Reply with the single word OK.' }] as const;
const TOOL_MESSAGES = [
  {
    role: 'user',
    content: 'Call fs.read_text with {"path":"README.md"}. Do not answer with text.',
  },
] as const;
const READ_TOOL = BUILTIN_TOOL_DEFINITIONS['fs.read_text'];

const modelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().trim().min(1),
    }),
  ),
});

type ProbeResult = {
  readonly finishReason: 'stop' | 'tool_calls';
  readonly content: string | null;
  readonly toolCalls: readonly {
    readonly logicalCallId: string;
    readonly toolId: string;
    readonly argumentsJson: string;
  }[];
};

export type ProviderModelProbeAdapter = {
  call(input: {
    readonly endpoint: string;
    readonly modelId: string;
    readonly apiKey: string;
    readonly messages: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly signal?: AbortSignal;
  }): Promise<ProbeResult>;
};

export type ProviderModelProbeOptions = {
  readonly fetch?: typeof fetch;
  readonly adapter?: ProviderModelProbeAdapter;
  readonly requestTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
};

export class ProviderModelProbeError extends Error {
  readonly code = 'PROVIDER_MODEL_PROBE_FAILED';

  constructor() {
    super('Provider model probe failed');
    this.name = 'ProviderModelProbeError';
  }
}

const isPositiveTimeout = (value: number): boolean => Number.isFinite(value) && value > 0;

const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<T> => {
  if (parentSignal.aborted) throw new ProviderModelProbeError();
  const controller = new AbortController();
  let rejectTimeout!: (error: ProviderModelProbeError) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const abort = (): void => {
    controller.abort();
    rejectTimeout(new ProviderModelProbeError());
  };
  const timer = setTimeout(abort, timeoutMs);
  parentSignal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', abort);
  }
};

const isNonChatModel = (modelId: string): boolean => {
  const normalized = modelId.toLowerCase();
  return [
    'embedding',
    'embed',
    'rerank',
    'image',
    'audio',
    'whisper',
    'dall-e',
    'tts',
    'speech',
  ].some((marker) => normalized.includes(marker));
};

const compareModelIds = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const discoverCandidates = async (
  config: ProviderPrivateConfig,
  fetchImplementation: typeof fetch,
  requestTimeoutMs: number,
  totalSignal: AbortSignal,
): Promise<readonly string[]> => {
  const body = await withTimeout(
    async (signal) => {
      const response = await fetchImplementation(`${config.baseUrl}/models`, {
        method: 'GET',
        redirect: 'error',
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal,
      });
      if (!response.ok) throw new ProviderModelProbeError();
      return await response.json();
    },
    requestTimeoutMs,
    totalSignal,
  );
  const parsed = modelsResponseSchema.safeParse(body);
  if (!parsed.success) throw new ProviderModelProbeError();
  return [...new Set(parsed.data.data.map(({ id }) => id))]
    .filter((modelId) => !isNonChatModel(modelId))
    .sort(compareModelIds)
    .slice(0, MAX_CANDIDATES);
};

const isChatSuccess = (result: ProbeResult): boolean =>
  result.finishReason === 'stop' &&
  result.content !== null &&
  result.content.trim().length > 0 &&
  result.toolCalls.length === 0;

const hasValidReadToolCall = (result: ProbeResult): boolean => {
  if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) return false;
  return result.toolCalls.some((toolCall) => {
    if (toolCall.toolId !== 'fs.read_text' || toolCall.logicalCallId.length === 0) return false;
    try {
      const input = JSON.parse(toolCall.argumentsJson) as unknown;
      return (
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input) &&
        Object.keys(input).length === 1 &&
        typeof (input as { readonly path?: unknown }).path === 'string' &&
        (input as { readonly path: string }).path.length > 0
      );
    } catch {
      return false;
    }
  });
};

const probeCandidate = async (
  adapter: ProviderModelProbeAdapter,
  config: ProviderPrivateConfig,
  modelId: string,
  requestTimeoutMs: number,
  totalSignal: AbortSignal,
): Promise<boolean> => {
  const endpoint = `${config.baseUrl}/chat/completions`;
  const chat = await withTimeout(
    (signal) =>
      adapter.call({
        endpoint,
        modelId,
        apiKey: config.apiKey,
        messages: CHAT_MESSAGES,
        tools: [],
        signal,
      }),
    requestTimeoutMs,
    totalSignal,
  );
  if (!isChatSuccess(chat)) return false;
  const tool = await withTimeout(
    (signal) =>
      adapter.call({
        endpoint,
        modelId,
        apiKey: config.apiKey,
        messages: TOOL_MESSAGES,
        tools: [READ_TOOL],
        signal,
      }),
    requestTimeoutMs,
    totalSignal,
  );
  return hasValidReadToolCall(tool);
};

export const probeProviderModel = async (
  config: ProviderPrivateConfig,
  options: ProviderModelProbeOptions = {},
): Promise<string> => {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  if (!isPositiveTimeout(requestTimeoutMs) || !isPositiveTimeout(totalTimeoutMs)) {
    throw new ProviderModelProbeError();
  }
  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(), totalTimeoutMs);
  const adapter =
    options.adapter ?? new OpenAiCompatibleAdapter({ timeoutMs: requestTimeoutMs });
  const fetchImplementation = options.fetch ?? fetch;

  try {
    const candidates =
      config.modelId === null
        ? await discoverCandidates(config, fetchImplementation, requestTimeoutMs, total.signal)
        : [config.modelId];
    for (const modelId of candidates) {
      if (total.signal.aborted) break;
      try {
        if (await probeCandidate(adapter, config, modelId, requestTimeoutMs, total.signal)) {
          return modelId;
        }
      } catch {
        if (total.signal.aborted) break;
      }
    }
    throw new ProviderModelProbeError();
  } catch {
    throw new ProviderModelProbeError();
  } finally {
    clearTimeout(totalTimer);
  }
};
