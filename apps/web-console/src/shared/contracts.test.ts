import { describe, expect, it } from 'vitest';

type ContractsModule = {
  RuntimePublicInfoSchema: {
    parse(value: unknown): unknown;
  };
  SessionSubmissionSchema: {
    parse(value: unknown): unknown;
  };
  TurnSubmissionSchema: {
    parse(value: unknown): unknown;
  };
  SessionSnapshotHttpResponseSchema: {
    parse(value: unknown): unknown;
  };
  SessionEventsHttpResponseSchema: {
    parse(value: unknown): unknown;
  };
  PublicErrorResponseSchema: {
    parse(value: unknown): unknown;
  };
};

const loadContracts = async (): Promise<ContractsModule> =>
  (await import('./contracts.js')) as unknown as ContractsModule;

const submissionId = '123e4567-e89b-42d3-a456-426614174000';

const emptySnapshot = {
  session: {
    id: 'session-1',
    title: 'Inspect repository',
    workspaceId: 'workspace-1',
    lifecycleStatus: 'active',
    runtimeStatus: 'idle',
    queueBlockReason: null,
    recoveryEpisode: 0,
    recoverySourceTurnId: null,
    currentTurnId: null,
    mode: 'craft',
    accessMode: 'full_access',
    nextTurnOrdinal: 1,
    nextEventSeq: 1,
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  },
  messages: [],
  turns: [],
  highWaterSeq: 0,
  events: [],
};

describe('web console HTTP contracts', () => {
  it('accepts only sanitized runtime public information', async () => {
    const { RuntimePublicInfoSchema } = await loadContracts();
    const runtime = {
      daemon: { status: 'ready', protocolVersion: 1, pid: 1234 },
      provider: { baseHost: 'api.example.test', modelId: 'chat-model' },
      workspace: { name: 'agent-workbench' },
    };

    expect(RuntimePublicInfoSchema.parse(runtime)).toEqual(runtime);
    expect(() =>
      RuntimePublicInfoSchema.parse({
        ...runtime,
        provider: { ...runtime.provider, apiKey: 'secret-key' },
      }),
    ).toThrow();
  });

  it.each([
    ['session', 'SessionSubmissionSchema'],
    ['turn', 'TurnSubmissionSchema'],
  ] as const)('requires a canonical UUID submissionId for %s submission', async (_name, key) => {
    const contracts = await loadContracts();
    const schema = contracts[key];

    expect(schema.parse({ submissionId, prompt: 'Read README.md' })).toEqual({
      submissionId,
      prompt: 'Read README.md',
    });
    expect(() => schema.parse({ submissionId: 'retry-1', prompt: 'Read README.md' })).toThrow();
    expect(() => schema.parse({ submissionId, prompt: '   ' })).toThrow();
  });

  it('wraps protocol snapshots and event pages without accepting extra fields', async () => {
    const {
      SessionSnapshotHttpResponseSchema,
      SessionEventsHttpResponseSchema,
    } = await loadContracts();

    expect(
      SessionSnapshotHttpResponseSchema.parse({ snapshot: emptySnapshot }),
    ).toEqual({ snapshot: emptySnapshot });
    expect(
      SessionEventsHttpResponseSchema.parse({ events: [], highWaterSeq: 0 }),
    ).toEqual({ events: [], highWaterSeq: 0 });
    expect(() =>
      SessionEventsHttpResponseSchema.parse({
        events: [],
        highWaterSeq: 0,
        socketPath: '/tmp/private.sock',
      }),
    ).toThrow();
  });

  it('exposes a strict sanitized public error wrapper', async () => {
    const { PublicErrorResponseSchema } = await loadContracts();
    const response = {
      error: {
        code: 'RPC_UNAVAILABLE',
        message: 'Runtime is unavailable',
        retryable: true,
        userAction: 'Retry in a moment',
      },
    };

    expect(PublicErrorResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      PublicErrorResponseSchema.parse({
        error: { ...response.error, detailsRef: 'private-trace' },
      }),
    ).toThrow();
  });
});
