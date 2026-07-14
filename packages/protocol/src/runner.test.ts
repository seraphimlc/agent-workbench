import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

type ParseSchema = {
  safeParse: (value: unknown) => { success: boolean };
};

type SchemaFactory = (binding: Record<string, unknown>) => ParseSchema;

const getSchema = (name: string): ParseSchema => {
  const schema = Reflect.get(protocol, name) as ParseSchema | undefined;
  expect(schema, `${name} should be exported`).toBeDefined();
  return schema as ParseSchema;
};

const getSchemaFactory = (name: string): SchemaFactory => {
  const factory = Reflect.get(protocol, name) as SchemaFactory | undefined;
  expect(factory, `${name} should be exported`).toBeDefined();
  return factory as SchemaFactory;
};

const binding = {
  runnerInstanceId: 'runner-1',
  capability: 'capability-1',
  daemonEpoch: 'daemon-epoch-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  leaseId: 'lease-1',
  leaseEpoch: 1,
  executionFence: 1,
};

const requestFor = (method: string, payload: unknown) => ({
  kind: 'request',
  protocolVersion: 1,
  requestId: `request-${method}`,
  traceId: `trace-${method}`,
  sessionId: binding.sessionId,
  turnId: binding.turnId,
  binding,
  method,
  payload,
});

const successResponseFor = (method: string, result: unknown) => ({
  kind: 'response',
  protocolVersion: 1,
  requestId: `request-${method}`,
  traceId: `trace-${method}`,
  sessionId: binding.sessionId,
  turnId: binding.turnId,
  method,
  ok: true,
  result,
});

const errorResponseFor = (method: string) => ({
  kind: 'response',
  protocolVersion: 1,
  requestId: `request-${method}`,
  traceId: `trace-${method}`,
  sessionId: binding.sessionId,
  turnId: binding.turnId,
  method,
  ok: false,
  error: {
    code: 'RUNNER_REQUEST_REJECTED',
    message: 'The Runner request was rejected',
    retryable: false,
  },
});

const modelMessages = [
  { role: 'system', content: 'Work only inside the bound Turn.' },
  { role: 'user', content: 'Summarize notes.md.' },
  {
    role: 'assistant',
    content: null,
    toolCalls: [
      {
        logicalCallId: 'logical-call-1',
        toolId: 'fs.read_text',
        argumentsJson: '{"path":"notes.md"}',
      },
    ],
  },
  {
    role: 'tool',
    logicalCallId: 'logical-call-1',
    content: '{"text":"notes"}',
  },
];

describe('Runner binding', () => {
  it('accepts one exact runner.bind notification', () => {
    const schema = getSchema('RunnerBindNotificationSchema');
    const notification = {
      kind: 'notification',
      protocolVersion: 1,
      traceId: 'trace-bind',
      sessionId: binding.sessionId,
      turnId: binding.turnId,
      method: 'runner.bind',
      payload: binding,
    };

    expect(schema.safeParse(notification).success).toBe(true);
    expect(
      schema.safeParse({ ...notification, turnId: 'turn-other' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...notification, unexpected: true }).success,
    ).toBe(false);
  });

  it.each([
    ['missing capability', { ...binding, capability: undefined }],
    ['zero lease epoch', { ...binding, leaseEpoch: 0 }],
    ['zero execution fence', { ...binding, executionFence: 0 }],
    ['negative execution fence', { ...binding, executionFence: -1 }],
  ])('rejects a binding with %s', (_name, candidate) => {
    const schema = getSchema('RunnerBindingSchema');
    expect(schema.safeParse(candidate).success).toBe(false);
  });
});

describe('Runner requests', () => {
  it.each([
    ['runner.ready', {}],
    ['runner.heartbeat', {}],
    ['turn.context.get', {}],
    ['model.call', { messages: modelMessages }],
    [
      'tool.execute',
      { modelAttemptId: 'model-attempt-1', logicalCallId: 'logical-call-1' },
    ],
    ['turn.complete', { modelAttemptId: 'model-attempt-2' }],
  ])('accepts the exact %s request', (method, payload) => {
    const schema = getSchema('RunnerRequestSchema');
    expect(schema.safeParse(requestFor(method, payload)).success).toBe(true);
  });

  it.each([
    ['runnerInstanceId', 'runner-other'],
    ['capability', 'capability-other'],
    ['daemonEpoch', 'daemon-epoch-other'],
    ['sessionId', 'session-other'],
    ['turnId', 'turn-other'],
    ['leaseId', 'lease-other'],
    ['leaseEpoch', 2],
    ['executionFence', 2],
  ] as const)(
    'binds every request to the expected immutable %s',
    (field, replacement) => {
      const schema = getSchemaFactory('createRunnerRequestSchema')(binding);
      const request = requestFor('runner.ready', {});

      expect(schema.safeParse(request).success).toBe(true);
      expect(
        schema.safeParse({
          ...request,
          ...(field === 'sessionId' ? { sessionId: String(replacement) } : {}),
          ...(field === 'turnId' ? { turnId: String(replacement) } : {}),
          binding: { ...binding, [field]: replacement },
        }).success,
      ).toBe(false);
    },
  );

  it('rejects top-level Session or Turn identity mismatches', () => {
    const schema = getSchema('RunnerRequestSchema');
    const request = requestFor('runner.heartbeat', {});

    expect(
      schema.safeParse({ ...request, sessionId: 'session-other' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...request, turnId: 'turn-other' }).success,
    ).toBe(false);
  });

  it('rejects arbitrary methods and extra envelope or payload fields', () => {
    const schema = getSchema('RunnerRequestSchema');

    expect(
      schema.safeParse(requestFor('runner.exec', {})).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...requestFor('runner.ready', {}),
        credentials: 'must-not-cross-runner-boundary',
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...requestFor('model.call', { messages: modelMessages }),
        payload: { messages: modelMessages, temperature: 2 },
      }).success,
    ).toBe(false);
  });

  it('accepts only the normalized model transcript shape', () => {
    const schema = getSchema('RunnerRequestSchema');

    expect(
      schema.safeParse(requestFor('model.call', { messages: modelMessages })).success,
    ).toBe(true);
    expect(
      schema.safeParse(
        requestFor('model.call', {
          messages: [{ role: 'tool', toolId: 'fs.read_text', content: 'forged' }],
        }),
      ).success,
    ).toBe(false);
  });

  it('allows tool.execute to reference only a persisted model Tool Call', () => {
    const schema = getSchema('RunnerRequestSchema');
    const request = requestFor('tool.execute', {
      modelAttemptId: 'model-attempt-1',
      logicalCallId: 'logical-call-1',
    });

    expect(schema.safeParse(request).success).toBe(true);
    expect(
      schema.safeParse({
        ...request,
        payload: {
          ...request.payload,
          toolId: 'fs.write_text',
          arguments: { path: '/tmp/escape' },
        },
      }).success,
    ).toBe(false);
  });

  it('allows turn.complete to reference only the final persisted ModelAttempt', () => {
    const schema = getSchema('RunnerRequestSchema');
    const request = requestFor('turn.complete', {
      modelAttemptId: 'model-attempt-final',
    });

    expect(schema.safeParse(request).success).toBe(true);
    expect(
      schema.safeParse({
        ...request,
        payload: {
          modelAttemptId: 'model-attempt-final',
          assistantText: 'Runner must not author the durable result',
        },
      }).success,
    ).toBe(false);
  });
});

describe('Runner responses', () => {
  const modelToolCalls = [
    {
      logicalCallId: 'logical-call-response-1',
      toolId: 'fs.read_text',
      argumentsJson: '{"path":"notes.md"}',
    },
  ];

  it.each([
    [
      'runner.ready',
      'RunnerReadyResultSchema',
      'RunnerReadySuccessResponseSchema',
      { accepted: true },
    ],
    [
      'runner.heartbeat',
      'RunnerHeartbeatResultSchema',
      'RunnerHeartbeatSuccessResponseSchema',
      { accepted: true },
    ],
    [
      'turn.context.get',
      'TurnContextGetResultSchema',
      'TurnContextGetSuccessResponseSchema',
      { messages: modelMessages },
    ],
    [
      'model.call',
      'ModelCallResultSchema',
      'ModelCallSuccessResponseSchema',
      {
        modelAttemptId: 'model-attempt-final',
        finishReason: 'stop',
        content: 'Completed',
        toolCalls: [],
      },
    ],
    [
      'tool.execute',
      'ToolExecuteResultSchema',
      'ToolExecuteSuccessResponseSchema',
      {
        logicalCallId: 'logical-call-response-1',
        content: '{"text":"notes"}',
      },
    ],
    [
      'turn.complete',
      'TurnCompleteResultSchema',
      'TurnCompleteSuccessResponseSchema',
      { terminalStatus: 'succeeded', resultMessageId: 'message-result-1' },
    ],
  ])(
    'accepts the exact successful %s response',
    (method, resultSchemaName, responseSchemaName, result) => {
      const resultSchema = getSchema(resultSchemaName);
      const responseSchema = getSchema(responseSchemaName);
      const unionSchema = getSchema('RunnerResponseSchema');
      const response = successResponseFor(method, result);

      expect(resultSchema.safeParse(result).success).toBe(true);
      expect(responseSchema.safeParse(response).success).toBe(true);
      expect(unionSchema.safeParse(response).success).toBe(true);
    },
  );

  it('keeps the generic response envelope strict', () => {
    const schema = getSchema('RunnerResponseEnvelopeSchema');
    const response = successResponseFor('runner.ready', { accepted: true });

    expect(schema.safeParse(response).success).toBe(true);
    expect(schema.safeParse({ ...response, unexpected: true }).success).toBe(false);
  });

  it.each([
    ['runner.ready', { terminalStatus: 'succeeded', resultMessageId: 'message-1' }],
    ['turn.complete', { accepted: true }],
    ['model.call', { logicalCallId: 'logical-1', content: 'wrong result' }],
  ])('rejects %s paired with another method result', (method, result) => {
    const successSchema = getSchema('RunnerSuccessResponseSchema');
    const envelopeSchema = getSchema('RunnerResponseEnvelopeSchema');
    const response = successResponseFor(method, result);

    expect(successSchema.safeParse(response).success).toBe(false);
    expect(envelopeSchema.safeParse(response).success).toBe(false);
  });

  it('enforces the final stop model result invariant', () => {
    const schema = getSchema('ModelCallResultSchema');
    const result = {
      modelAttemptId: 'model-attempt-stop',
      finishReason: 'stop',
      content: 'Completed',
      toolCalls: [],
    };

    expect(schema.safeParse(result).success).toBe(true);
    expect(schema.safeParse({ ...result, content: null }).success).toBe(false);
    expect(schema.safeParse({ ...result, content: '' }).success).toBe(false);
    expect(schema.safeParse({ ...result, content: '   ' }).success).toBe(false);
    expect(schema.safeParse({ ...result, toolCalls: modelToolCalls }).success).toBe(false);
  });

  it('enforces the tool_calls model result invariant', () => {
    const schema = getSchema('ModelCallResultSchema');
    const result = {
      modelAttemptId: 'model-attempt-tools',
      finishReason: 'tool_calls',
      content: null,
      toolCalls: modelToolCalls,
    };

    expect(schema.safeParse(result).success).toBe(true);
    expect(schema.safeParse({ ...result, content: 'Calling a Tool' }).success).toBe(true);
    expect(schema.safeParse({ ...result, toolCalls: [] }).success).toBe(false);
  });

  it.each(['category', 'userAction', 'detailsRef', 'traceId'])(
    'rejects Main-only %s inside a Runner error',
    (field) => {
      const schema = getSchema('RunnerErrorSchema');
      const error = errorResponseFor('runner.ready').error;

      expect(schema.safeParse(error).success).toBe(true);
      expect(
        schema.safeParse({ ...error, [field]: 'must-not-cross-runner-boundary' })
          .success,
      ).toBe(false);
    },
  );

  it('accepts only an independent strict Runner error response', () => {
    const errorResponseSchema = getSchema('RunnerErrorResponseSchema');
    const schema = getSchema('RunnerResponseSchema');
    const response = errorResponseFor('runner.heartbeat');

    expect(errorResponseSchema.safeParse(response).success).toBe(true);
    expect(schema.safeParse(response).success).toBe(true);
    expect(
      schema.safeParse({ ...response, result: { accepted: false } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...response,
        error: { ...response.error, traceId: response.traceId },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['requestId', 'request-other'],
    ['traceId', 'trace-other'],
    ['sessionId', 'session-other'],
    ['turnId', 'turn-other'],
    ['method', 'runner.heartbeat'],
  ] as const)(
    'binds a response to the originating request %s',
    (field, replacement) => {
      const request = requestFor('runner.ready', {});
      const schema = getSchemaFactory('createRunnerResponseSchema')(request);
      const response = successResponseFor('runner.ready', { accepted: true });

      expect(schema.safeParse(response).success).toBe(true);
      expect(schema.safeParse({ ...response, [field]: replacement }).success).toBe(false);
    },
  );

  it.each(['binding', 'capability'])(
    'rejects response secret surface field %s',
    (field) => {
      const exactSchema = getSchema('RunnerResponseSchema');
      const envelopeSchema = getSchema('RunnerResponseEnvelopeSchema');
      const response = successResponseFor('runner.ready', { accepted: true });
      const leaked = {
        ...response,
        [field]: field === 'binding' ? binding : binding.capability,
      };

      expect(exactSchema.safeParse(leaked).success).toBe(false);
      expect(envelopeSchema.safeParse(leaked).success).toBe(false);
    },
  );

  it('rejects capability nested inside a method result', () => {
    const schema = getSchema('RunnerResponseSchema');
    const response = successResponseFor('runner.ready', {
      accepted: true,
      capability: binding.capability,
    });

    expect(schema.safeParse(response).success).toBe(false);
  });
});
