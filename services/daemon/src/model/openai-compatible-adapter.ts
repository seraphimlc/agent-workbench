import {
  decodeOpenAiSseResponse,
  type DecodedOpenAiResponse,
  OpenAiDecoderError,
} from './openai-sse-decoder.js';

export type OpenAiCompatibleAdapterOptions = {
  readonly timeoutMs: number;
};

const PROVIDER_FUNCTION_NAME = /^[a-zA-Z0-9_-]+$/;

type ProviderFunctionBinding = {
  readonly index: number;
  readonly internalName: string;
  readonly toolId: string;
  readonly baseName: string;
  readonly alreadySafe: boolean;
};

const sanitizedProviderFunctionName = (internalName: string): string => {
  if (PROVIDER_FUNCTION_NAME.test(internalName)) return internalName;
  return internalName.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'tool';
};

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const prepareProviderTools = (
  tools: readonly unknown[],
): {
  readonly tools: readonly unknown[];
  readonly providerNameToToolId: ReadonlyMap<string, string>;
} => {
  const bindings: ProviderFunctionBinding[] = [];
  for (const [index, tool] of tools.entries()) {
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) continue;
    const definition = tool as Record<string, unknown>;
    if (
      typeof definition.function !== 'object' ||
      definition.function === null ||
      Array.isArray(definition.function)
    ) {
      continue;
    }
    const internalName = (definition.function as Record<string, unknown>).name;
    if (typeof internalName !== 'string') continue;
    const toolId = definition.toolId;
    bindings.push({
      index,
      internalName,
      toolId: typeof toolId === 'string' && toolId.length > 0 ? toolId : internalName,
      baseName: sanitizedProviderFunctionName(internalName),
      alreadySafe: PROVIDER_FUNCTION_NAME.test(internalName),
    });
  }

  const providerNameByIndex = new Map<number, string>();
  const providerNameToToolId = new Map<string, string>();
  const usedProviderNames = new Set<string>();
  bindings.sort(
    (left, right) =>
      Number(right.alreadySafe) - Number(left.alreadySafe) ||
      compareStrings(left.baseName, right.baseName) ||
      compareStrings(left.internalName, right.internalName) ||
      compareStrings(left.toolId, right.toolId) ||
      left.index - right.index,
  );
  for (const binding of bindings) {
    let providerName = binding.baseName;
    let suffix = 2;
    while (usedProviderNames.has(providerName)) {
      providerName = `${binding.baseName}_${suffix}`;
      suffix += 1;
    }
    usedProviderNames.add(providerName);
    providerNameByIndex.set(binding.index, providerName);
    providerNameToToolId.set(providerName, binding.toolId);
  }

  const providerTools = tools.map((tool, index) => {
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) return tool;
    const providerTool = { ...(tool as Record<string, unknown>) };
    delete providerTool.toolId;
    if (
      typeof providerTool.function === 'object' &&
      providerTool.function !== null &&
      !Array.isArray(providerTool.function)
    ) {
      const providerFunction = {
        ...(providerTool.function as Record<string, unknown>),
      };
      const providerName = providerNameByIndex.get(index);
      if (providerName !== undefined) providerFunction.name = providerName;
      providerTool.function = providerFunction;
    }
    return providerTool;
  });
  return { tools: providerTools, providerNameToToolId };
};

export class OpenAiCompatibleAdapter {
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleAdapterOptions) {
    this.timeoutMs = options.timeoutMs;
  }

  async call(input: {
    readonly endpoint: string;
    readonly modelId: string;
    readonly apiKey: string;
    readonly messages: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly signal?: AbortSignal;
  }): Promise<DecodedOpenAiResponse> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const combined = new AbortController();
    const abort = (): void => combined.abort();
    timeout.signal.addEventListener('abort', abort, { once: true });
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const preparedTools = prepareProviderTools(input.tools);
      const response = await fetch(input.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: input.modelId,
          stream: true,
          messages: input.messages,
          tools: preparedTools.tools,
        }),
        signal: combined.signal,
      });
      const decoded = await decodeOpenAiSseResponse(response, {
        signal: combined.signal,
        maxResponseBytes: 16 * 1024 * 1024,
        maxErrorBodyBytes: 64 * 1024,
      });
      if (decoded.toolCalls.length === 0) return decoded;
      return {
        ...decoded,
        toolCalls: decoded.toolCalls.map((toolCall) => ({
          ...toolCall,
          toolId: preparedTools.providerNameToToolId.get(toolCall.toolId) ?? toolCall.toolId,
        })),
      };
    } catch (error) {
      if (combined.signal.aborted && !(error instanceof OpenAiDecoderError)) {
        throw new OpenAiDecoderError('MODEL_STREAM_INTERRUPTED', 'Model request was aborted');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      timeout.signal.removeEventListener('abort', abort);
      input.signal?.removeEventListener('abort', abort);
    }
  }
}
