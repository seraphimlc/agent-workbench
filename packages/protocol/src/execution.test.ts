import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

type ParseSchema = {
  safeParse: (value: unknown) => { success: boolean };
};

const getSchema = (name: string): ParseSchema => {
  const schema = Reflect.get(protocol, name) as ParseSchema | undefined;
  expect(schema, `${name} should be exported`).toBeDefined();
  return schema as ParseSchema;
};

const now = '2026-07-14T00:00:00.000Z';
const sha256 = 'a'.repeat(64);

const modelCall = {
  id: 'model-call-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  ordinal: 1,
  kind: 'craft',
  status: 'succeeded',
  successfulAttemptId: 'model-attempt-1',
  errorCode: null,
  createdAt: now,
  startedAt: now,
  finishedAt: now,
};

const modelAttempt = {
  id: 'model-attempt-1',
  modelCallId: 'model-call-1',
  attempt: 1,
  status: 'succeeded',
  providerRequestId: 'provider-request-1',
  finishReason: 'stop',
  inputTokens: 10,
  outputTokens: 5,
  cachedTokens: 2,
  latencyMs: 25,
  errorCode: null,
  retryable: null,
  startedAt: now,
  finishedAt: now,
};

const toolRun = {
  id: 'tool-run-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  ordinal: 1,
  logicalCallId: 'logical-call-1',
  sourceModelCallId: 'model-call-1',
  sourceModelAttemptId: 'model-attempt-1',
  attempt: 1,
  operationId: 'operation-1',
  idempotencyKey: 'operation-1',
  toolId: 'fs.write_text',
  toolVersion: '1',
  executionMode: 'worker',
  sideEffectClass: 'local_write',
  status: 'succeeded',
  dispatchState: 'acknowledged',
  normalizedInputHash: sha256,
  effectState: 'applied',
  errorCode: null,
  queuedAt: now,
  startedAt: now,
  finishedAt: now,
};

const artifact = {
  id: 'artifact-1',
  sessionId: 'session-1',
  logicalName: 'summary',
  currentVersionId: 'artifact-version-1',
  createdAt: now,
  updatedAt: now,
};

const artifactVersion = {
  id: 'artifact-version-1',
  artifactId: 'artifact-1',
  version: 1,
  sourceTurnId: 'turn-1',
  sourceToolRunId: 'tool-run-1',
  blobSha256: sha256,
  visibility: 'final',
  artifactType: 'markdown',
  mimeType: 'text/markdown',
  filename: 'summary.md',
  size: 12,
  validationStatus: 'unchecked',
  registrationKey: 'summary-final',
  registrationInputHash: sha256,
  createdAt: now,
};

const turnOutcome = {
  turnId: 'turn-1',
  terminalStatus: 'succeeded',
  errorCode: null,
  resultMessageId: 'message-result-1',
  finalArtifactVersionIds: ['artifact-version-1'],
  workingArtifactVersionIds: [],
  evidenceArtifactVersionIds: [],
  modelCallSummary: { total: 1, succeeded: 1, failed: 0, interrupted: 0 },
  toolRunSummary: { total: 1, succeeded: 1, failed: 0, interrupted: 0 },
  skillRunSummary: { total: 0, succeeded: 0, failed: 0, interrupted: 0 },
  checklistSummary: {
    total: 0,
    pending: 0,
    inProgress: 0,
    completed: 0,
    skipped: 0,
  },
  usageSummary: {
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 2,
    incomplete: false,
  },
  unresolvedEffectToolRunIds: [],
};

describe('safe execution projections', () => {
  it.each([
    ['ModelCallSchema', modelCall],
    ['ModelAttemptSchema', modelAttempt],
    ['ToolRunSchema', toolRun],
    ['ArtifactSchema', artifact],
    ['ArtifactVersionSchema', artifactVersion],
    ['TurnOutcomeSchema', turnOutcome],
  ])('accepts the exact %s public projection', (schemaName, value) => {
    const schema = getSchema(schemaName);
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['ModelCallSchema', modelCall, 'inputJson'],
    ['ModelCallSchema', modelCall, 'resultJson'],
    ['ModelCallSchema', modelCall, 'profileSnapshotJson'],
    ['ModelAttemptSchema', modelAttempt, 'partialOutputJson'],
    ['ModelAttemptSchema', modelAttempt, 'resultJson'],
    ['ToolRunSchema', toolRun, 'inputJson'],
    ['ToolRunSchema', toolRun, 'resultJson'],
    ['ToolRunSchema', toolRun, 'sourceHandle'],
    ['ToolRunSchema', toolRun, 'dispatchNonce'],
    ['ArtifactSchema', artifact, 'credentials'],
    ['ArtifactVersionSchema', artifactVersion, 'storageRelpath'],
    ['ArtifactVersionSchema', artifactVersion, 'provenanceJson'],
  ])('rejects persistence-private %s.%s', (schemaName, value, privateField) => {
    const schema = getSchema(schemaName);
    expect(
      schema.safeParse({ ...value, [privateField]: 'must-not-project' }).success,
    ).toBe(false);
  });

  it('locks the complete minimum TurnOutcome shape', () => {
    const schema = getSchema('TurnOutcomeSchema');
    const missingUsage: Record<string, unknown> = { ...turnOutcome };
    delete missingUsage.usageSummary;

    expect(schema.safeParse(turnOutcome).success).toBe(true);
    expect(schema.safeParse(missingUsage).success).toBe(false);
    expect(
      schema.safeParse({
        ...turnOutcome,
        terminalStatus: 'running',
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...turnOutcome,
        skillRunSummary: {
          total: -1,
          succeeded: 0,
          failed: 0,
          interrupted: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...turnOutcome, inputJson: '{}' }).success,
    ).toBe(false);
  });
});
