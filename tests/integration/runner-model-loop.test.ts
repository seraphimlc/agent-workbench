import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { RunnerBinding, RunnerRequest } from '../../packages/protocol/src/runner.js';

type RunnerExecution = {
  readonly ready: Promise<void>;
  readonly completion: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  nextRequest(): Promise<RunnerRequest>;
  respond(response: unknown): void;
  kill(signal?: NodeJS.Signals): void;
};

type RunnerSupervisorModule = {
  RunnerSupervisor: new (options: {
    readonly runnerEntryPoint: string;
    readonly readyTimeoutMs: number;
    readonly heartbeatIntervalMs: number;
    readonly heartbeatExpiryMs: number;
    readonly maxCycles: number;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  }) => {
    start(binding: RunnerBinding): Promise<RunnerExecution>;
  };
};

const MODULE_PATH = '../../services/daemon/src/runtime/runner-supervisor.js';
const runnerEntryPoint = fileURLToPath(
  new URL('../../runtimes/session-runner/src/index.ts', import.meta.url),
);
const binding: RunnerBinding = {
  runnerInstanceId: 'runner-loop-1',
  capability: 'runner-loop-capability',
  daemonEpoch: 'daemon-loop-epoch',
  sessionId: 'session-loop',
  turnId: 'turn-loop',
  leaseId: 'lease-loop',
  leaseEpoch: 1,
  executionFence: 1,
};

const loadSupervisor = async (): Promise<RunnerSupervisorModule> =>
  (await import(MODULE_PATH)) as unknown as RunnerSupervisorModule;

const responseFor = (request: RunnerRequest, result: unknown): unknown => ({
  kind: 'response',
  protocolVersion: 1,
  requestId: request.requestId,
  traceId: request.traceId,
  sessionId: request.sessionId,
  turnId: request.turnId,
  method: request.method,
  ok: true,
  result,
});

const startRunner = async (): Promise<RunnerExecution> => {
  const { RunnerSupervisor } = await loadSupervisor();
  return await new RunnerSupervisor({
    runnerEntryPoint,
    readyTimeoutMs: 5_000,
    heartbeatIntervalMs: 5_000,
    heartbeatExpiryMs: 20_000,
    maxCycles: 64,
    environment: {},
  }).start(binding);
};

const acceptReady = async (execution: RunnerExecution): Promise<void> => {
  const ready = await execution.nextRequest();
  expect(ready).toMatchObject({ method: 'runner.ready', binding });
  execution.respond(responseFor(ready, { accepted: true }));
  await execution.ready;
};

describe('Session Runner Agent Loop', () => {
  it('runs context → model → ordered Tool references → model → complete with immutable Binding', async () => {
    await loadSupervisor();
    const execution = await startRunner();

    try {
      await acceptReady(execution);
      const context = await execution.nextRequest();
      expect(context).toMatchObject({ method: 'turn.context.get', binding, payload: {} });
      execution.respond(
        responseFor(context, {
          messages: [
            { role: 'system', content: 'Use Tools through the Daemon.' },
            { role: 'user', content: 'Read notes and summarize.' },
          ],
        }),
      );

      const firstModel = await execution.nextRequest();
      expect(firstModel).toMatchObject({ method: 'model.call', binding });
      expect(Object.keys(firstModel.payload)).toEqual(['messages']);
      expect(JSON.stringify(firstModel)).not.toContain('apiKey');
      expect(JSON.stringify(firstModel)).not.toContain('endpoint');
      expect(JSON.stringify(firstModel)).not.toContain('toolSchema');
      const toolCalls = [
        {
          logicalCallId: 'call-1',
          toolId: 'fs.read_text',
          argumentsJson: '{"path":"notes.md"}',
        },
        {
          logicalCallId: 'call-2',
          toolId: 'fs.read_text',
          argumentsJson: '{"path":"more.md"}',
        },
      ] as const;
      execution.respond(
        responseFor(firstModel, {
          modelAttemptId: 'attempt-tools',
          finishReason: 'tool_calls',
          content: null,
          toolCalls,
        }),
      );

      for (const [logicalCallId, content] of [
        ['call-1', 'notes'],
        ['call-2', 'more'],
      ] as const) {
        const tool = await execution.nextRequest();
        expect(tool).toMatchObject({
          method: 'tool.execute',
          binding,
          payload: { modelAttemptId: 'attempt-tools', logicalCallId },
        });
        expect(Object.keys(tool.payload).sort()).toEqual(['logicalCallId', 'modelAttemptId']);
        execution.respond(responseFor(tool, { logicalCallId, content }));
      }

      const finalModel = await execution.nextRequest();
      expect(finalModel).toMatchObject({ method: 'model.call', binding });
      expect(finalModel.payload).toEqual({
        messages: [
          { role: 'system', content: 'Use Tools through the Daemon.' },
          { role: 'user', content: 'Read notes and summarize.' },
          { role: 'assistant', content: null, toolCalls },
          { role: 'tool', logicalCallId: 'call-1', content: 'notes' },
          { role: 'tool', logicalCallId: 'call-2', content: 'more' },
        ],
      });
      execution.respond(
        responseFor(finalModel, {
          modelAttemptId: 'attempt-final',
          finishReason: 'stop',
          content: 'Summary',
          toolCalls: [],
        }),
      );

      const complete = await execution.nextRequest();
      expect(complete).toMatchObject({
        method: 'turn.complete',
        binding,
        payload: { modelAttemptId: 'attempt-final' },
      });
      execution.respond(
        responseFor(complete, {
          terminalStatus: 'succeeded',
          resultMessageId: 'message-final',
        }),
      );
      await expect(execution.completion).resolves.toEqual({ code: 0, signal: null });
    } finally {
      execution.kill('SIGKILL');
    }
  });

  it('stops after 64 model/tool cycles without constructing schemas or touching files/provider config', async () => {
    await loadSupervisor();
    const execution = await startRunner();

    try {
      await acceptReady(execution);
      const context = await execution.nextRequest();
      execution.respond(
        responseFor(context, { messages: [{ role: 'user', content: 'Loop' }] }),
      );
      for (let cycle = 1; cycle <= 64; cycle += 1) {
        const model = await execution.nextRequest();
        expect(model).toMatchObject({ method: 'model.call', binding });
        expect(Object.keys(model.payload)).toEqual(['messages']);
        execution.respond(
          responseFor(model, {
            modelAttemptId: `attempt-${String(cycle)}`,
            finishReason: 'tool_calls',
            content: null,
            toolCalls: [
              {
                logicalCallId: `call-${String(cycle)}`,
                toolId: 'fs.read_text',
                argumentsJson: '{"path":"notes.md"}',
              },
            ],
          }),
        );
        const tool = await execution.nextRequest();
        expect(tool).toMatchObject({
          method: 'tool.execute',
          payload: {
            modelAttemptId: `attempt-${String(cycle)}`,
            logicalCallId: `call-${String(cycle)}`,
          },
        });
        execution.respond(
          responseFor(tool, {
            logicalCallId: `call-${String(cycle)}`,
            content: 'result',
          }),
        );
      }

      await expect(execution.completion).resolves.toMatchObject({
        code: 1,
        signal: null,
        errorCode: 'RUNNER_MAX_CYCLES_EXCEEDED',
      });
    } finally {
      execution.kill('SIGKILL');
    }
  });

  it('rejects a daemon response whose correlation tuple does not match the pending request', async () => {
    await loadSupervisor();
    const execution = await startRunner();

    try {
      await acceptReady(execution);
      const context = await execution.nextRequest();
      expect(context).toMatchObject({ method: 'turn.context.get', binding });
      const wrongResponse = {
        ...(responseFor(context, {
          messages: [{ role: 'user', content: 'Must not be accepted' }],
        }) as Record<string, unknown>),
        requestId: `${context.requestId}-wrong`,
      };
      let rejectedBySupervisor = false;
      try {
        execution.respond(wrongResponse);
      } catch {
        rejectedBySupervisor = true;
      }

      if (!rejectedBySupervisor) {
        const outcome = await Promise.race([
          execution.completion.then((completion) => ({ kind: 'completion' as const, completion })),
          execution.nextRequest().then((request) => ({ kind: 'request' as const, request })),
        ]);
        expect(outcome.kind).toBe('completion');
        if (outcome.kind === 'completion') {
          expect(outcome.completion).not.toMatchObject({ code: 0, signal: null });
        }
      }
    } finally {
      execution.kill('SIGKILL');
      await execution.completion.catch(() => undefined);
    }
  });
});
