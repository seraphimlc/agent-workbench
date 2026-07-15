import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type {
  RunnerBinding,
  RunnerRequest,
} from '../../packages/protocol/src/runner.js';

type RunnerExecution = {
  readonly child: ChildProcess;
  readonly launchArguments: readonly string[];
  readonly launchEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly daemonFrames: readonly unknown[];
  readonly stdout: string;
  readonly stderr: string;
  readonly ready: Promise<void>;
  readonly completion: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  nextRequest(): Promise<RunnerRequest>;
  respond(response: unknown): void;
  closeDaemonInput(): void;
  kill(signal?: NodeJS.Signals): void;
};

type RunnerSupervisorModule = {
  RunnerSupervisor: new (options: {
    readonly runnerEntryPoint: string;
    readonly readyTimeoutMs: number;
    readonly heartbeatIntervalMs: number;
    readonly heartbeatExpiryMs: number;
    readonly maxOutputBytes: number;
    readonly secrets: readonly string[];
  }) => {
    start(binding: RunnerBinding): Promise<RunnerExecution>;
  };
};

type RunnerChannelModule = {
  RunnerChannel: new (options: {
    readonly readable: PassThrough;
    readonly writable: PassThrough;
    readonly binding: RunnerBinding;
    readonly onAuthorizedRequest: (request: RunnerRequest) => void;
  }) => {
    readonly closed: Promise<void>;
    start(): void;
  };
};

const SUPERVISOR_MODULE_PATH = '../../services/daemon/src/runtime/runner-supervisor.js';
const CHANNEL_MODULE_PATH = '../../services/daemon/src/runtime/runner-channel.js';
const runnerEntryPoint = fileURLToPath(
  new URL('../../runtimes/session-runner/src/index.ts', import.meta.url),
);
const noHeartbeatRunnerEntryPoint = fileURLToPath(
  new URL('../fixtures/no-heartbeat-runner.ts', import.meta.url),
);
const environmentProbeRunnerEntryPoint = fileURLToPath(
  new URL('../fixtures/environment-probe-runner.ts', import.meta.url),
);
const forgedErrorRunnerEntryPoint = fileURLToPath(
  new URL('../fixtures/forged-error-runner.ts', import.meta.url),
);
const resistantRunnerEntryPoint = fileURLToPath(
  new URL('../fixtures/resistant-ready-runner.ts', import.meta.url),
);
const capability = 'runner-capability-secret';
const apiKey = 'provider-api-key-secret';
const prompt = 'prompt-secret-content';
const toolArguments = '{"path":"notes.md"}';

const binding: RunnerBinding = {
  runnerInstanceId: 'runner-instance-1',
  capability,
  daemonEpoch: 'daemon-epoch-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  leaseId: 'lease-1',
  leaseEpoch: 1,
  executionFence: 1,
};

const loadSupervisor = async (): Promise<RunnerSupervisorModule> =>
  (await import(SUPERVISOR_MODULE_PATH)) as unknown as RunnerSupervisorModule;

const loadChannel = async (): Promise<RunnerChannelModule> =>
  (await import(CHANNEL_MODULE_PATH)) as unknown as RunnerChannelModule;

const createSupervisor = async () => {
  const { RunnerSupervisor } = await loadSupervisor();
  return new RunnerSupervisor({
    runnerEntryPoint,
    readyTimeoutMs: 50,
    heartbeatIntervalMs: 5_000,
    heartbeatExpiryMs: 20_000,
    maxOutputBytes: 64 * 1024,
    secrets: [capability, apiKey, prompt, toolArguments],
  });
};

const createNoHeartbeatSupervisor = async () => {
  const { RunnerSupervisor } = await loadSupervisor();
  return new RunnerSupervisor({
    runnerEntryPoint: noHeartbeatRunnerEntryPoint,
    readyTimeoutMs: 5_000,
    heartbeatIntervalMs: 100,
    heartbeatExpiryMs: 500,
    maxOutputBytes: 64 * 1024,
    secrets: [capability, apiKey, prompt, toolArguments],
  });
};

describe('Runner binding and supervision', () => {
  it('spawns the real child with inherited fd 3/4 and sends runner.bind as the first daemon frame', async () => {
    await loadSupervisor();
    const supervisor = await createSupervisor();
    const execution = await supervisor.start(binding);

    try {
      expect(execution.child.stdio[3]).not.toBeNull();
      expect(execution.child.stdio[4]).not.toBeNull();
      expect(execution.daemonFrames[0]).toEqual({
        kind: 'notification',
        protocolVersion: 1,
        traceId: expect.any(String),
        sessionId: binding.sessionId,
        turnId: binding.turnId,
        method: 'runner.bind',
        payload: binding,
      });
      const launchSurface = JSON.stringify({
        argv: execution.launchArguments,
        env: execution.launchEnvironment,
      });
      for (const secret of [
        binding.sessionId,
        binding.turnId,
        binding.leaseId,
        capability,
        apiKey,
        prompt,
        toolArguments,
      ]) {
        expect(launchSurface).not.toContain(secret);
      }

      const ready = await execution.nextRequest();
      expect(ready).toMatchObject({ method: 'runner.ready', binding });
      execution.respond({
        kind: 'response',
        protocolVersion: 1,
        requestId: ready.requestId,
        traceId: ready.traceId,
        sessionId: ready.sessionId,
        turnId: ready.turnId,
        method: 'runner.ready',
        ok: true,
        result: { accepted: true },
      });
      await execution.ready;
    } finally {
      execution.kill('SIGKILL');
      await execution.completion;
    }
  });

  it.each([
    ['runner instance', { runnerInstanceId: 'runner-instance-other' }],
    ['capability-prefix', { capability: `x${capability.slice(1)}` }],
    ['capability-suffix', { capability: `${capability.slice(0, -1)}x` }],
    ['capability-length', { capability: `${capability}x` }],
    ['daemon epoch', { daemonEpoch: 'daemon-epoch-other' }],
    ['session', { sessionId: 'session-other' }],
    ['turn', { turnId: 'turn-other' }],
    ['lease', { leaseId: 'lease-other' }],
    ['lease epoch', { leaseEpoch: 2 }],
    ['execution fence', { executionFence: 2 }],
  ])('closes the channel identically for a wrong %s', async (_name, replacement) => {
    await loadChannel();
    const { RunnerChannel } = await loadChannel();
    const readable = new PassThrough();
    const writable = new PassThrough();
    const authorized: RunnerRequest[] = [];
    const channel = new RunnerChannel({
      readable,
      writable,
      binding,
      onAuthorizedRequest: (request) => authorized.push(request),
    });
    channel.start();
    const wrongBinding = { ...binding, ...replacement };
    const body = Buffer.from(
      JSON.stringify({
        kind: 'request',
        protocolVersion: 1,
        requestId: 'request-wrong',
        traceId: 'trace-wrong',
        sessionId: wrongBinding.sessionId,
        turnId: wrongBinding.turnId,
        binding: wrongBinding,
        method: 'runner.heartbeat',
        payload: {},
      }),
    );
    const frame = Buffer.alloc(4 + body.byteLength);
    frame.writeUInt32BE(body.byteLength, 0);
    body.copy(frame, 4);
    readable.end(frame);

    await channel.closed;
    expect(authorized).toEqual([]);
    expect(writable.readableEnded || writable.destroyed).toBe(true);
  });

  it('terminates and reaps a child that misses READY or the configured heartbeat expiry', async () => {
    await loadSupervisor();
    const supervisor = await createSupervisor();
    const notReady = await supervisor.start(binding);
    await expect(notReady.ready).rejects.toMatchObject({ code: 'RUNNER_READY_TIMEOUT' });
    await expect(notReady.completion).resolves.toMatchObject({ code: null, signal: expect.any(String) });

    const noHeartbeatSupervisor = await createNoHeartbeatSupervisor();
    const heartbeatExpired = await noHeartbeatSupervisor.start({
      ...binding,
      runnerInstanceId: 'runner-2',
    });
    const readyRequest = await heartbeatExpired.nextRequest();
    heartbeatExpired.respond({
      kind: 'response',
      protocolVersion: 1,
      requestId: readyRequest.requestId,
      traceId: readyRequest.traceId,
      sessionId: readyRequest.sessionId,
      turnId: readyRequest.turnId,
      method: 'runner.ready',
      ok: true,
      result: { accepted: true },
    });
    await heartbeatExpired.ready;
    await expect(heartbeatExpired.completion).resolves.toMatchObject({
      code: null,
      signal: expect.any(String),
      reason: 'RUNNER_HEARTBEAT_TIMEOUT',
    });
  });

  it('treats channel EOF and child crash as completion only after the direct child is reaped', async () => {
    await loadSupervisor();
    const supervisor = await createSupervisor();
    const eof = await supervisor.start(binding);
    eof.closeDaemonInput();
    await expect(eof.completion).resolves.toMatchObject({
      reaped: true,
      reason: 'RUNNER_CHANNEL_EOF',
    });

    const crashed = await supervisor.start({ ...binding, runnerInstanceId: 'runner-crash' });
    crashed.kill('SIGKILL');
    await expect(crashed.completion).resolves.toMatchObject({
      reaped: true,
      signal: 'SIGKILL',
      reason: 'RUNNER_CRASHED',
    });
    for (const output of [crashed.stdout, crashed.stderr]) {
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      for (const secret of [capability, apiKey, prompt, toolArguments]) {
        expect(output).not.toContain(secret);
      }
    }
  });

  it('launches with a minimal environment even when the parent contains Runner secrets', async () => {
    await loadSupervisor();
    const { RunnerSupervisor } = await loadSupervisor();
    const poisoned = {
      QA_PARENT_API_KEY: apiKey,
      QA_PARENT_PROMPT: prompt,
      QA_PARENT_CAPABILITY: capability,
    };
    Object.assign(process.env, poisoned);
    const supervisor = new RunnerSupervisor({
      runnerEntryPoint: environmentProbeRunnerEntryPoint,
      readyTimeoutMs: 5_000,
      heartbeatIntervalMs: 5_000,
      heartbeatExpiryMs: 20_000,
      maxOutputBytes: 64 * 1024,
      secrets: [capability, apiKey, prompt],
    });

    try {
      const execution = await supervisor.start(binding);
      await execution.completion;
      const launchSurface = JSON.stringify(execution.launchEnvironment);
      expect(launchSurface).not.toContain(apiKey);
      expect(launchSurface).not.toContain(prompt);
      expect(launchSurface).not.toContain(capability);
      expect(JSON.parse(execution.stdout)).toEqual({
        apiKey: null,
        prompt: null,
        capability: null,
      });
    } finally {
      for (const key of Object.keys(poisoned)) delete process.env[key];
    }
  });

  it('reaps the spawned child when process identity inspection fails', async () => {
    await loadSupervisor();
    const { RunnerSupervisor } = await loadSupervisor();
    let childPid: number | undefined;
    const supervisor = new RunnerSupervisor({
      runnerEntryPoint: resistantRunnerEntryPoint,
      readyTimeoutMs: 5_000,
      heartbeatIntervalMs: 5_000,
      heartbeatExpiryMs: 20_000,
      readProcessStartIdentity: (pid: number) => {
        childPid = pid;
        throw new Error('identity probe failed');
      },
    });

    await expect(supervisor.start(binding)).rejects.toThrow('identity probe failed');
    expect(childPid).toBeDefined();
    expect(() => process.kill(childPid as number, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
  });

  it('escalates from SIGTERM to SIGKILL for a resistant Runner', async () => {
    await loadSupervisor();
    const { RunnerSupervisor } = await loadSupervisor();
    const supervisor = new RunnerSupervisor({
      runnerEntryPoint: resistantRunnerEntryPoint,
      readyTimeoutMs: 50,
      heartbeatIntervalMs: 5_000,
      heartbeatExpiryMs: 20_000,
      terminationGraceMs: 50,
    });
    const execution = await supervisor.start(binding);
    await execution.nextRequest();

    await expect(execution.ready).rejects.toMatchObject({ code: 'RUNNER_READY_TIMEOUT' });
    await expect(execution.completion).resolves.toMatchObject({
      code: null,
      signal: 'SIGKILL',
      reaped: true,
    });
  });

  it('does not trust a forged durable error code from child stderr', async () => {
    await loadSupervisor();
    const { RunnerSupervisor } = await loadSupervisor();
    const supervisor = new RunnerSupervisor({
      runnerEntryPoint: forgedErrorRunnerEntryPoint,
      readyTimeoutMs: 5_000,
      heartbeatIntervalMs: 5_000,
      heartbeatExpiryMs: 20_000,
    });
    const execution = await supervisor.start(binding);

    await expect(execution.completion).resolves.not.toMatchObject({
      errorCode: 'MODEL_AUTH_FAILED',
    });
  });
});
