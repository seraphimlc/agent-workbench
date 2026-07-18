import { z } from 'zod';

const providerEnvironmentSchema = z.object({
  AGENT_WORKBENCH_PROVIDER_BASE_URL: z.string().trim().min(1),
  AGENT_WORKBENCH_PROVIDER_API_KEY: z.string().trim().min(1),
  AGENT_WORKBENCH_PROVIDER_MODEL: z.string().optional(),
});

export type ProviderPrivateConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string | null;
};

export type ProviderPublicConfig = {
  readonly baseHost: string;
  readonly modelId: string | null;
};

export type ParsedProviderConfig = {
  readonly privateConfig: ProviderPrivateConfig;
  readonly publicConfig: ProviderPublicConfig;
};

export class ProviderConfigError extends Error {
  readonly code = 'PROVIDER_CONFIG_INVALID';

  constructor() {
    super('Provider configuration is invalid');
    this.name = 'ProviderConfigError';
  }
}

const invalidConfig = (): never => {
  throw new ProviderConfigError();
};

const normalizeBaseUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidConfig();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return invalidConfig();
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  return url;
};

const createPrivateConfig = (input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string | null;
}): ProviderPrivateConfig => {
  const privateConfig = {
    baseUrl: input.baseUrl,
    modelId: input.modelId,
  } as ProviderPrivateConfig;
  Object.defineProperty(privateConfig, 'apiKey', {
    configurable: false,
    enumerable: false,
    value: input.apiKey,
    writable: false,
  });
  return Object.freeze(privateConfig);
};

export const parseProviderConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): ParsedProviderConfig => {
  const result = providerEnvironmentSchema.safeParse(environment);
  if (!result.success) return invalidConfig();
  const url = normalizeBaseUrl(result.data.AGENT_WORKBENCH_PROVIDER_BASE_URL);
  const modelId = result.data.AGENT_WORKBENCH_PROVIDER_MODEL?.trim() || null;
  const baseUrl = url.toString().replace(/\/$/, '');
  const privateConfig = createPrivateConfig({
    baseUrl,
    apiKey: result.data.AGENT_WORKBENCH_PROVIDER_API_KEY,
    modelId,
  });
  const publicConfig = Object.freeze({
    baseHost: url.host,
    modelId,
  });
  return Object.freeze({ privateConfig, publicConfig });
};
