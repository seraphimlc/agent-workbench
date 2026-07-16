import { describe, expect, it } from 'vitest';

type ProviderConfigModule = {
  parseProviderConfig(env: Readonly<Record<string, string | undefined>>): {
    readonly privateConfig: {
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly modelId: string | null;
    };
    readonly publicConfig: {
      readonly baseHost: string;
      readonly modelId: string | null;
    };
  };
};

const MODULE_PATH = './config.js';

const loadConfig = async (): Promise<ProviderConfigModule> =>
  (await import(MODULE_PATH)) as unknown as ProviderConfigModule;

const validEnv = (overrides: Readonly<Record<string, string | undefined>> = {}) => ({
  AGENT_WORKBENCH_PROVIDER_BASE_URL: 'https://api.example.test',
  AGENT_WORKBENCH_PROVIDER_API_KEY: 'secret-key',
  ...overrides,
});

describe('parseProviderConfig', () => {
  it('normalizes an HTTP provider base to one v1 path and exposes sanitized metadata', async () => {
    const { parseProviderConfig } = await loadConfig();
    const parsed = parseProviderConfig(validEnv());

    expect(parsed.privateConfig).toMatchObject({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'secret-key',
      modelId: null,
    });
    expect(parsed.publicConfig).toEqual({
      baseHost: 'api.example.test',
      modelId: null,
    });
    expect(Object.keys(parsed.publicConfig)).toEqual(['baseHost', 'modelId']);
    expect(JSON.stringify(parsed)).not.toContain('secret-key');
    expect(JSON.stringify(parsed.privateConfig)).not.toContain('secret-key');
    expect(JSON.stringify(parsed.publicConfig)).not.toContain('secret-key');
  });

  it.each([
    ['http://localhost:11434/', 'http://localhost:11434/v1'],
    ['https://api.example.test/v1/', 'https://api.example.test/v1'],
    ['https://api.example.test/openai', 'https://api.example.test/openai/v1'],
    ['https://api.example.test/openai/v1', 'https://api.example.test/openai/v1'],
  ])('normalizes %s to %s', async (baseUrl, expected) => {
    const { parseProviderConfig } = await loadConfig();

    expect(
      parseProviderConfig(
        validEnv({ AGENT_WORKBENCH_PROVIDER_BASE_URL: baseUrl }),
      ).privateConfig.baseUrl,
    ).toBe(expected);
  });

  it('trims an explicit model while leaving workspace validation to later startup', async () => {
    const { parseProviderConfig } = await loadConfig();
    const parsed = parseProviderConfig(
      validEnv({
        AGENT_WORKBENCH_PROVIDER_MODEL: '  chat-model  ',
        AGENT_WORKBENCH_DEMO_WORKSPACE: '../validated-later',
      }),
    );

    expect(parsed.privateConfig.modelId).toBe('chat-model');
    expect(parsed.publicConfig.modelId).toBe('chat-model');
  });

  it.each([
    ['missing base URL', { AGENT_WORKBENCH_PROVIDER_BASE_URL: undefined }],
    ['invalid base URL', { AGENT_WORKBENCH_PROVIDER_BASE_URL: 'not a url' }],
    ['non-HTTP base URL', { AGENT_WORKBENCH_PROVIDER_BASE_URL: 'file:///tmp/provider' }],
    ['base URL credentials', { AGENT_WORKBENCH_PROVIDER_BASE_URL: 'https://user:pass@example.test' }],
    ['base URL query', { AGENT_WORKBENCH_PROVIDER_BASE_URL: 'https://example.test?key=value' }],
    ['missing API key', { AGENT_WORKBENCH_PROVIDER_API_KEY: undefined }],
    ['blank API key', { AGENT_WORKBENCH_PROVIDER_API_KEY: '   ' }],
  ])('rejects %s without echoing configuration values', async (_name, overrides) => {
    const { parseProviderConfig } = await loadConfig();

    expect(() => parseProviderConfig(validEnv(overrides))).toThrowError(
      expect.objectContaining({
        code: 'PROVIDER_CONFIG_INVALID',
        message: 'Provider configuration is invalid',
      }),
    );
  });
});
