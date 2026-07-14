import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

type ParseSchema = {
  safeParse: (value: unknown) => { success: boolean };
};

type NonceSchemaFactory = (dispatchNonce: string) => ParseSchema;

const getSchema = (name: string): ParseSchema => {
  const schema = Reflect.get(protocol, name) as ParseSchema | undefined;
  expect(schema, `${name} should be exported`).toBeDefined();
  return schema as ParseSchema;
};

const getNonceSchemaFactory = (name: string): NonceSchemaFactory => {
  const factory = Reflect.get(protocol, name) as NonceSchemaFactory | undefined;
  expect(factory, `${name} should be exported`).toBeDefined();
  return factory as NonceSchemaFactory;
};

const sha256 = 'a'.repeat(64);
const otherSha256 = 'b'.repeat(64);
const dispatchNonce = 'dispatch-nonce-1';

const init = {
  kind: 'INIT',
  daemonEpoch: 'daemon-epoch-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolRunId: 'tool-run-1',
  executionFence: 1,
  capability: 'worker-capability-1',
  dispatchNonce,
  requestedPath: 'summary.md',
  canonicalPath: '/workspace/summary.md',
  targetExistedBefore: true,
  baselineSha256: sha256,
  expectedSha256: otherSha256,
  expectedSize: 12,
  content: 'new summary\n',
  maxBytes: 1_048_576,
};

describe('one-shot write-worker messages', () => {
  it.each([
    ['ToolWorkerInitSchema', init],
    ['ToolWorkerReadySchema', { kind: 'READY', dispatchNonce }],
    ['ToolWorkerGoSchema', { kind: 'GO', dispatchNonce }],
    ['ToolWorkerAckSchema', { kind: 'ACK', dispatchNonce }],
    [
      'ToolWorkerResultSchema',
      {
        kind: 'RESULT',
        status: 'succeeded',
        baselineSha256: sha256,
        finalSha256: otherSha256,
        size: 12,
        errorCode: null,
        errorMessage: null,
        retryable: null,
      },
    ],
    [
      'ToolWorkerErrorSchema',
      {
        kind: 'ERROR',
        errorCode: 'WORKER_PROTOCOL_INVALID',
        errorMessage: 'Invalid worker message',
        retryable: false,
      },
    ],
  ])('accepts the exact %s message', (schemaName, message) => {
    const schema = getSchema(schemaName);
    expect(schema.safeParse(message).success).toBe(true);
  });

  it('accepts all six kinds through one strict discriminated envelope', () => {
    const schema = getSchema('ToolWorkerEnvelopeSchema');
    const messages = [
      init,
      { kind: 'READY', dispatchNonce },
      { kind: 'GO', dispatchNonce },
      { kind: 'ACK', dispatchNonce },
      {
        kind: 'RESULT',
        status: 'failed',
        baselineSha256: sha256,
        finalSha256: null,
        size: null,
        errorCode: 'FILE_CHANGED_SINCE_READ',
        errorMessage: 'The target changed after it was read',
        retryable: false,
      },
      {
        kind: 'ERROR',
        errorCode: 'WORKER_PROTOCOL_INVALID',
        errorMessage: 'Invalid worker message',
        retryable: false,
      },
    ];

    for (const message of messages) {
      expect(schema.safeParse(message).success).toBe(true);
    }
  });

  it('requires INIT to bind the exact execution and dispatch tuple', () => {
    const schema = getSchema('ToolWorkerInitSchema');

    expect(schema.safeParse(init).success).toBe(true);
    expect(schema.safeParse({ ...init, capability: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...init, executionFence: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...init, dispatchNonce: '' }).success).toBe(false);
  });

  it.each([
    ['createToolWorkerGoSchema', 'GO'],
    ['createToolWorkerAckSchema', 'ACK'],
  ])('makes %s consume the exact dispatch nonce', (factoryName, kind) => {
    const schema = getNonceSchemaFactory(factoryName)(dispatchNonce);

    expect(schema.safeParse({ kind, dispatchNonce }).success).toBe(true);
    expect(
      schema.safeParse({ kind, dispatchNonce: 'dispatch-nonce-other' }).success,
    ).toBe(false);
  });

  it('rejects unknown kinds and extra fields at every layer', () => {
    const envelope = getSchema('ToolWorkerEnvelopeSchema');
    const result = getSchema('ToolWorkerResultSchema');

    expect(envelope.safeParse({ kind: 'WAIT', dispatchNonce }).success).toBe(false);
    expect(
      envelope.safeParse({ kind: 'ACK', dispatchNonce, duplicate: true }).success,
    ).toBe(false);
    expect(
      result.safeParse({
        kind: 'RESULT',
        status: 'succeeded',
        baselineSha256: sha256,
        finalSha256: otherSha256,
        size: 12,
        errorCode: null,
        errorMessage: null,
        retryable: null,
        sourceHandle: 'must-stay-daemon-private',
      }).success,
    ).toBe(false);
  });

  it.each([
    ['missing final hash', { finalSha256: null }],
    ['missing size', { size: null }],
    ['error code', { errorCode: 'UNEXPECTED_ERROR' }],
    ['error message', { errorMessage: 'must be absent' }],
    ['retryability', { retryable: false }],
  ])('rejects a succeeded RESULT with %s', (_name, replacement) => {
    const schema = getSchema('ToolWorkerResultSchema');
    const succeeded = {
      kind: 'RESULT',
      status: 'succeeded',
      baselineSha256: sha256,
      finalSha256: otherSha256,
      size: 12,
      errorCode: null,
      errorMessage: null,
      retryable: null,
    };

    expect(schema.safeParse({ ...succeeded, ...replacement }).success).toBe(false);
  });

  it.each([
    ['error code', { errorCode: null }],
    ['error message', { errorMessage: null }],
    ['retryability', { retryable: null }],
  ])('rejects a failed RESULT without %s', (_name, replacement) => {
    const schema = getSchema('ToolWorkerResultSchema');
    const failed = {
      kind: 'RESULT',
      status: 'failed',
      baselineSha256: sha256,
      finalSha256: otherSha256,
      size: 12,
      errorCode: 'FILE_CHANGED_SINCE_READ',
      errorMessage: 'The target changed after it was read',
      retryable: false,
    };

    expect(schema.safeParse({ ...failed, ...replacement }).success).toBe(false);
  });

  it('allows a failed RESULT to carry observed hash and size evidence', () => {
    const schema = getSchema('ToolWorkerResultSchema');

    expect(
      schema.safeParse({
        kind: 'RESULT',
        status: 'failed',
        baselineSha256: sha256,
        finalSha256: otherSha256,
        size: 12,
        errorCode: 'POSTCONDITION_MISMATCH',
        errorMessage: 'The observed final hash did not match the intended hash',
        retryable: false,
      }).success,
    ).toBe(true);
  });
});
