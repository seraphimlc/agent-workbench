import {
  decodeOpenAiSseResponse,
  type DecodedOpenAiResponse,
  OpenAiDecoderError,
} from './openai-sse-decoder.js';

export type OpenAiCompatibleAdapterOptions = {
  readonly timeoutMs: number;
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
      const providerTools = input.tools.map((tool) => {
        if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) return tool;
        const providerTool = { ...(tool as Record<string, unknown>) };
        delete providerTool.toolId;
        return providerTool;
      });
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
          tools: providerTools,
        }),
        signal: combined.signal,
      });
      return await decodeOpenAiSseResponse(response, {
        signal: combined.signal,
        maxResponseBytes: 16 * 1024 * 1024,
        maxErrorBodyBytes: 64 * 1024,
      });
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
