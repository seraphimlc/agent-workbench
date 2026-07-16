import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import {
  createRunnerResponseSchema,
  RunnerBindingSchema,
  type RunnerBinding,
  type RunnerModelMessage,
  type RunnerRequest,
} from '@agent-workbench/protocol';
import type Database from 'better-sqlite3';

import { openRuntimeDatabase } from '../db/database.js';
import { ModelGateway, type ModelAdapter } from '../model/model-gateway.js';
import { redactAndLimit } from '../security/secret-redactor.js';
import { ToolGateway } from '../tools/tool-gateway.js';
import type { ExecutionDriver, ExecutionRun } from './execution-coordinator.js';
import { RunnerChannel } from './runner-channel.js';
import type { Claim } from './scheduler.js';
import { TurnTerminalizer } from './turn-terminalizer.js';

type ProcessIdentity = {
  readonly pid: number;
  readonly processStartIdentity: string;
};

type RunnerCompletion = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly reaped?: true;
  readonly reason?: string;
  readonly errorCode?: string;
};

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
};

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

class AsyncQueue<Value> {
  private readonly values: Value[] = [];
  private readonly waiters: Array<Deferred<Value>> = [];
  private failure: unknown;

  push(value: Value): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  next(): Promise<Value> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const waiter = deferred<Value>();
    this.waiters.push(waiter);
    return waiter.promise;
  }

  fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

const codedError = (code: string): Error & { readonly code: string } =>
  Object.assign(new Error(code), { code });

const defaultReadProcessStartIdentity = (pid: number): string => {
  const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (output.length === 0) throw new Error('Process start identity is unavailable');
  return output;
};

const minimalEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
};

const allowedRunnerErrorCodes = new Set([
  'RUNNER_MAX_CYCLES_EXCEEDED',
  'RUNNER_RESPONSE_MISMATCH',
]);

const appendBounded = (
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number },
  limit: number,
): void => {
  const remaining = Math.max(0, limit - state.bytes);
  if (remaining === 0) return;
  const captured = chunk.subarray(0, remaining);
  chunks.push(captured);
  state.bytes += captured.byteLength;
};

const outputText = (
  chunks: readonly Buffer[],
  secrets: readonly string[],
  limit: number,
): string => redactAndLimit(Buffer.concat(chunks).toString('utf8'), secrets, limit);

const runnerErrorCode = (stderr: string): string | undefined => {
  for (const line of stderr.trim().split('\n').reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (
        typeof value === 'object' && value !== null &&
        'errorCode' in value && typeof value.errorCode === 'string'
      ) {
        return allowedRunnerErrorCodes.has(value.errorCode) ? value.errorCode : undefined;
      }
    } catch {
      continue;
    }
  }
  return undefined;
};

export type RunnerExecution = {
  readonly child: ChildProcess;
  readonly identity: ProcessIdentity;
  readonly launchArguments: readonly string[];
  readonly launchEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly daemonFrames: readonly unknown[];
  readonly stdout: string;
  readonly stderr: string;
  readonly ready: Promise<void>;
  readonly completion: Promise<RunnerCompletion>;
  nextRequest(): Promise<RunnerRequest>;
  respond(response: unknown): void;
  fence(): void;
  closeDaemonInput(): void;
  kill(signal?: NodeJS.Signals): void;
};

export class RunnerSupervisor {
  private readonly runnerEntryPoint: string;
  private readonly readyTimeoutMs: number;
  private readonly heartbeatExpiryMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxCycles: number;
  private readonly maxOutputBytes: number;
  private readonly secrets: readonly string[];
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly onHeartbeat: (binding: RunnerBinding) => void;
  private readonly beforeBind: (
    binding: RunnerBinding,
    identity: ProcessIdentity,
  ) => void | Promise<void>;
  private readonly readProcessStartIdentity: (pid: number) => string;
  private readonly terminationGraceMs: number;

  constructor(options: {
    readonly runnerEntryPoint: string;
    readonly readyTimeoutMs: number;
    readonly heartbeatIntervalMs: number;
    readonly heartbeatExpiryMs: number;
    readonly maxCycles?: number;
    readonly maxOutputBytes?: number;
    readonly secrets?: readonly string[];
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly onHeartbeat?: (binding: RunnerBinding) => void;
    readonly beforeBind?: (
      binding: RunnerBinding,
      identity: ProcessIdentity,
    ) => void | Promise<void>;
    readonly readProcessStartIdentity?: (pid: number) => string;
    readonly terminationGraceMs?: number;
  }) {
    this.runnerEntryPoint = options.runnerEntryPoint;
    this.readyTimeoutMs = options.readyTimeoutMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.heartbeatExpiryMs = options.heartbeatExpiryMs;
    this.maxCycles = options.maxCycles ?? 64;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.secrets = options.secrets ?? [];
    this.environment = options.environment ?? minimalEnvironment(process.env);
    this.onHeartbeat = options.onHeartbeat ?? (() => undefined);
    this.beforeBind = options.beforeBind ?? (() => undefined);
    this.readProcessStartIdentity =
      options.readProcessStartIdentity ?? defaultReadProcessStartIdentity;
    this.terminationGraceMs = options.terminationGraceMs ?? 250;
  }

  async start(inputBinding: RunnerBinding): Promise<RunnerExecution> {
    const binding = RunnerBindingSchema.parse(inputBinding);
    const launchArguments = [
      '--conditions=development',
      '--import',
      'tsx',
      this.runnerEntryPoint,
    ];
    const launchEnvironment: NodeJS.ProcessEnv = {
      ...this.environment,
      AGENT_WORKBENCH_RUNNER_MAX_CYCLES: String(this.maxCycles),
      AGENT_WORKBENCH_RUNNER_HEARTBEAT_INTERVAL_MS: String(this.heartbeatIntervalMs),
    };
    const child = spawn(process.execPath, launchArguments, {
      cwd: process.cwd(),
      env: launchEnvironment,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    const childClosed = deferred<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>();
    child.once('close', (code, signal) => childClosed.resolve({ code, signal }));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };

    child.stdout?.on('data', (chunk: Buffer) => {
      appendBounded(stdoutChunks, chunk, stdoutState, this.maxOutputBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendBounded(stderrChunks, chunk, stderrState, this.maxOutputBytes);
    });

    const reapSpawnFailure = async (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const graceful = await Promise.race([
        childClosed.promise.then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), this.terminationGraceMs);
        }),
      ]);
      if (!graceful && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await childClosed.promise;
    };

    let identity: ProcessIdentity;
    try {
      if (child.pid === undefined) throw new Error('Runner child has no pid');
      identity = {
        pid: child.pid,
        processStartIdentity: this.readProcessStartIdentity(child.pid),
      };
      await this.beforeBind(binding, identity);
    } catch (error) {
      await reapSpawnFailure();
      throw error;
    }
    const daemonInput = child.stdio[3] as Writable;
    const daemonOutput = child.stdio[4] as Readable;
    const requests = new AsyncQueue<RunnerRequest>();
    const pending = new Map<string, RunnerRequest>();
    const ready = deferred<void>();
    const daemonFrames: unknown[] = [];
    const allSecrets = [...this.secrets, binding.capability];
    const maxOutputBytes = this.maxOutputBytes;
    let readySettled = false;
    let completionSettled = false;
    let terminationReason: string | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let readyTimer: NodeJS.Timeout | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;

    const terminate = (reason: string, signal: NodeJS.Signals = 'SIGTERM'): void => {
      terminationReason ??= reason;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      if (signal !== 'SIGKILL' && !escalationTimer) {
        escalationTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, this.terminationGraceMs);
      }
    };
    const armReadyTimeout = (timeoutMs: number): void => {
      if (readyTimer) clearTimeout(readyTimer);
      readyTimer = setTimeout(() => {
        if (readySettled) return;
        readySettled = true;
        ready.reject(codedError('RUNNER_READY_TIMEOUT'));
        terminate('RUNNER_READY_TIMEOUT');
      }, timeoutMs);
    };
    armReadyTimeout(Math.max(this.readyTimeoutMs, 5_000));

    const armHeartbeat = (): void => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        terminate('RUNNER_HEARTBEAT_TIMEOUT');
      }, this.heartbeatExpiryMs);
    };

    const channel = new RunnerChannel({
      readable: daemonOutput,
      writable: daemonInput,
      binding,
      onAuthorizedRequest: (request) => {
        if (pending.has(request.requestId)) {
          terminate('RUNNER_PROTOCOL_ERROR');
          return;
        }
        pending.set(request.requestId, request);
        if (request.method === 'runner.ready' && !readySettled) {
          armReadyTimeout(this.readyTimeoutMs);
        }
        if (request.method === 'runner.heartbeat') {
          try {
            this.onHeartbeat(binding);
          } catch {
            terminate('RUNNER_HEARTBEAT_REJECTED');
            return;
          }
          armHeartbeat();
          const response = {
            kind: 'response',
            protocolVersion: 1,
            requestId: request.requestId,
            traceId: request.traceId,
            sessionId: request.sessionId,
            turnId: request.turnId,
            method: request.method,
            ok: true,
            result: { accepted: true },
          };
          pending.delete(request.requestId);
          daemonFrames.push(response);
          channel.write(response);
          return;
        }
        requests.push(request);
      },
    });
    channel.start();
    const bindFrame = {
      kind: 'notification',
      protocolVersion: 1,
      traceId: randomUUID(),
      sessionId: binding.sessionId,
      turnId: binding.turnId,
      method: 'runner.bind',
      payload: binding,
    };
    daemonFrames.push(bindFrame);
    channel.write(bindFrame);

    const completion = new Promise<RunnerCompletion>((resolve) => {
      void childClosed.promise.then(({ code, signal }) => {
        completionSettled = true;
        if (readyTimer) clearTimeout(readyTimer);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (escalationTimer) clearTimeout(escalationTimer);
        if (!readySettled) {
          readySettled = true;
          ready.reject(codedError('RUNNER_EXITED_BEFORE_READY'));
        }
        const closedError = codedError('RUNNER_EXECUTION_CLOSED');
        requests.fail(closedError);
        for (const request of pending.values()) pending.delete(request.requestId);
        if (code === 0 && signal === null && terminationReason === undefined) {
          resolve({ code, signal });
          return;
        }
        const stderr = outputText(stderrChunks, allSecrets, this.maxOutputBytes);
        const errorCode = runnerErrorCode(stderr);
        resolve({
          code,
          signal,
          reaped: true,
          reason: terminationReason ?? 'RUNNER_CRASHED',
          ...(errorCode ? { errorCode } : {}),
        });
      });
    });

    void channel.closed.then(() => {
      setTimeout(() => {
        if (
          !completionSettled && child.exitCode === null && child.signalCode === null &&
          terminationReason === undefined
        ) {
          terminate('RUNNER_CHANNEL_EOF');
        }
      }, 100);
    });

    return {
      child,
      identity,
      launchArguments,
      launchEnvironment,
      daemonFrames,
      get stdout() {
        return outputText(stdoutChunks, allSecrets, maxOutputBytes);
      },
      get stderr() {
        return outputText(stderrChunks, allSecrets, maxOutputBytes);
      },
      ready: ready.promise,
      completion,
      nextRequest: async () => await requests.next(),
      respond: (response: unknown) => {
        if (typeof response !== 'object' || response === null || !('requestId' in response)) {
          terminate('RUNNER_RESPONSE_MISMATCH');
          throw codedError('RUNNER_RESPONSE_MISMATCH');
        }
        const requestId = response.requestId;
        const request = typeof requestId === 'string' ? pending.get(requestId) : undefined;
        if (!request) {
          terminate('RUNNER_RESPONSE_MISMATCH');
          throw codedError('RUNNER_RESPONSE_MISMATCH');
        }
        const parsed = createRunnerResponseSchema(request).safeParse(response);
        if (!parsed.success) {
          terminate('RUNNER_RESPONSE_MISMATCH');
          throw codedError('RUNNER_RESPONSE_MISMATCH');
        }
        pending.delete(request.requestId);
        daemonFrames.push(parsed.data);
        channel.write(parsed.data);
        if (request.method === 'runner.ready') {
          if (readyTimer) clearTimeout(readyTimer);
          if (!parsed.data.ok) {
            if (!readySettled) {
              readySettled = true;
              ready.reject(codedError(parsed.data.error.code));
            }
            terminate('RUNNER_READY_REJECTED');
          } else if (!readySettled) {
            readySettled = true;
            ready.resolve(undefined);
            armHeartbeat();
          }
        }
      },
      fence: () => channel.fence(),
      closeDaemonInput: () => {
        terminationReason = 'RUNNER_CHANNEL_EOF';
        daemonInput.end();
        terminate('RUNNER_CHANNEL_EOF');
      },
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        terminate('RUNNER_CRASHED', signal);
      },
    };
  }

  inspectPersistedExecutor(
    identity: ProcessIdentity,
  ): 'live' | 'exited' | 'ambiguous' {
    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      return code === 'ESRCH' ? 'exited' : 'ambiguous';
    }
    try {
      return defaultReadProcessStartIdentity(identity.pid) === identity.processStartIdentity
        ? 'live'
        : 'ambiguous';
    } catch {
      return 'ambiguous';
    }
  }

  createBinding(input: {
    readonly daemonEpoch: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly leaseId: string;
    readonly leaseEpoch: number;
    readonly executionFence: number;
  }): RunnerBinding {
    return {
      runnerInstanceId: randomUUID(),
      capability: randomBytes(32).toString('base64url'),
      daemonEpoch: input.daemonEpoch,
      sessionId: input.sessionId,
      turnId: input.turnId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      executionFence: input.executionFence,
    };
  }
}

type DriverHooks = {
  readonly onPhase?: (phase: string) => void;
};

type DriverActiveRun = {
  readonly claim: Claim;
  readonly binding: RunnerBinding;
  readonly execution: RunnerExecution;
  readonly completion: Deferred<void>;
  loop: Promise<void>;
  modelAbort: AbortController | undefined;
  fenced: boolean;
  terminalCommitted: boolean;
};

type DriverPendingStart = {
  readonly claim: Claim;
  readonly completion: Deferred<void>;
  promise?: Promise<ExecutionRun>;
  execution?: RunnerExecution;
  terminalCommitted: boolean;
};

const successResponse = (request: RunnerRequest, result: unknown): unknown => ({
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

const errorCodeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : 'RUNNER_EXECUTION_FAILED';

class RunnerExecutionDriver implements ExecutionDriver {
  private readonly supervisor: RunnerSupervisor;
  private readonly hooks: DriverHooks;
  private databasePromise: Promise<Database.Database> | undefined;
  private database: Database.Database | undefined;
  private pendingStart: DriverPendingStart | undefined;
  private active: DriverActiveRun | undefined;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly options: {
      readonly dataDir: string;
      readonly runnerEntryPoint: string;
      readonly modelAdapter: ModelAdapter;
      readonly provider: {
        readonly endpoint: string;
        readonly modelId: string;
        readonly apiKey: string;
      };
      readonly toolHandlers: Readonly<
        Record<
          string,
          (input: {
            readonly toolRunId: string;
            readonly toolId: string;
            readonly input: unknown;
          }) => Promise<{ readonly content: string }>
        >
      >;
      readonly hooks: DriverHooks;
    },
  ) {
    this.hooks = options.hooks;
    this.supervisor = new RunnerSupervisor({
      runnerEntryPoint: options.runnerEntryPoint,
      readyTimeoutMs: 5_000,
      heartbeatIntervalMs: 5_000,
      heartbeatExpiryMs: 20_000,
      maxCycles: 64,
      secrets: [options.provider.apiKey],
      onHeartbeat: (binding) => this.persistHeartbeat(binding),
      beforeBind: async (binding, identity) => {
        await this.persistExecutorIdentity(binding, identity);
      },
    });
  }

  start(claim: Claim): Promise<ExecutionRun> {
    if (this.shuttingDown || this.pendingStart || this.active) {
      return Promise.reject(codedError('RUNNER_START_REJECTED'));
    }
    const pending: DriverPendingStart = {
      claim,
      completion: deferred<void>(),
      terminalCommitted: false,
    };
    this.pendingStart = pending;
    const promise = this.performStart(pending);
    pending.promise = promise;
    return promise;
  }

  private async performStart(pending: DriverPendingStart): Promise<ExecutionRun> {
    const { claim } = pending;
    try {
    const database = await this.getDatabase();
    if (this.shuttingDown) {
      return await this.cancelPendingStart(pending, database);
    }
    const binding = this.supervisor.createBinding(claim);
    const launchMarker = database
      .prepare(
        `UPDATE runner_leases
         SET runner_instance_id = ?
         WHERE id = ? AND daemon_epoch = ? AND lease_epoch = ?
           AND session_id = ? AND current_turn_id = ? AND status = 'active'
           AND runner_instance_id IS NULL AND pid IS NULL
           AND process_start_identity IS NULL`,
      )
      .run(
        binding.runnerInstanceId,
        binding.leaseId,
        binding.daemonEpoch,
        binding.leaseEpoch,
        binding.sessionId,
        binding.turnId,
      );
    if (launchMarker.changes !== 1) throw codedError('RUNNER_LAUNCH_MARKER_PERSIST_FAILED');
    if (this.shuttingDown) {
      return await this.cancelPendingStart(pending, database);
    }
    try {
      pending.execution = await this.supervisor.start(binding);
    } catch (error) {
      if (this.shuttingDown) {
        return await this.cancelPendingStart(pending, database);
      }
      throw error;
    }
    if (this.shuttingDown) {
      return await this.cancelPendingStart(pending, database);
    }
    const active: DriverActiveRun = {
      claim,
      binding,
      execution: pending.execution,
      completion: pending.completion,
      loop: Promise.resolve(),
      modelAbort: undefined,
      fenced: false,
      terminalCommitted: false,
    };
    this.active = active;
    active.loop = this.run(active);
    return { completion: active.completion.promise };
    } catch (error) {
      pending.completion.reject(error);
      throw error;
    } finally {
      if (this.pendingStart === pending) this.pendingStart = undefined;
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  inspectPersistedExecutor(
    identity: ProcessIdentity,
  ): 'live' | 'exited' | 'ambiguous' {
    return this.supervisor.inspectPersistedExecutor(identity);
  }

  onDaemonPhase(phase: 'coordinator.quiesced' | 'runtime_lock.released'): void {
    this.hooks.onPhase?.(phase);
  }

  private async run(active: DriverActiveRun): Promise<void> {
    let terminalError: unknown;
    try {
      const ready = await active.execution.nextRequest();
      if (ready.method !== 'runner.ready') throw codedError('RUNNER_READY_REQUIRED');
      active.execution.respond(successResponse(ready, { accepted: true }));
      await active.execution.ready;

      while (!active.fenced) {
        const request = await active.execution.nextRequest();
        if (active.fenced) break;
        if (request.method === 'turn.context.get') {
          active.execution.respond(
            successResponse(request, { messages: await this.readContext(active.claim) }),
          );
          continue;
        }
        if (request.method === 'model.call') {
          const abort = new AbortController();
          active.modelAbort = abort;
          try {
            const database = await this.getDatabase();
            const gateway = new ModelGateway(database, {
              adapter: this.options.modelAdapter,
              provider: this.options.provider,
            });
            const result = await gateway.call({
              binding: active.claim,
              messages: request.payload.messages as unknown as never,
              signal: abort.signal,
              abortDisposition: 'external_interrupt',
            });
            if (!active.fenced) active.execution.respond(successResponse(request, result));
          } finally {
            if (active.modelAbort === abort) active.modelAbort = undefined;
          }
          continue;
        }
        if (request.method === 'tool.execute') {
          const database = await this.getDatabase();
          const gateway = new ToolGateway(database, {
            handlers: this.options.toolHandlers,
          });
          const result = await gateway.execute({
            binding: active.claim,
            modelAttemptId: request.payload.modelAttemptId,
            logicalCallId: request.payload.logicalCallId,
          });
          if (!active.fenced) {
            active.execution.respond(
              successResponse(request, {
                logicalCallId: request.payload.logicalCallId,
                content: result.content,
              }),
            );
          }
          continue;
        }
        if (request.method === 'turn.complete') {
          const database = await this.getDatabase();
          const result = new TurnTerminalizer(database).succeed({
            binding: active.claim,
            modelAttemptId: request.payload.modelAttemptId,
          });
          active.terminalCommitted = true;
          active.execution.respond(
            successResponse(request, {
              terminalStatus: result.status,
              resultMessageId: result.resultMessageId,
            }),
          );
          await active.execution.completion;
          break;
        }
        throw codedError('RUNNER_REQUEST_UNEXPECTED');
      }
    } catch (error) {
      terminalError = error;
      if (!this.shuttingDown && !active.fenced && !active.terminalCommitted) {
        active.execution.kill('SIGTERM');
        const processCompletion = await active.execution.completion;
        const database = await this.getDatabase();
        new TurnTerminalizer(database).fail({
          binding: active.claim,
          errorCode: processCompletion.errorCode ?? errorCodeOf(error),
          errorMessage: 'Runner execution failed',
        });
        active.terminalCommitted = true;
      }
    } finally {
      if (!this.shuttingDown) {
        if (active.terminalCommitted) active.completion.resolve(undefined);
        else active.completion.reject(terminalError ?? codedError('RUNNER_EXECUTION_FAILED'));
        if (this.active === active) this.active = undefined;
      }
    }
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending = this.pendingStart;
    let pendingError: unknown;
    if (pending?.promise) {
      try {
        await pending.promise;
      } catch (error) {
        pendingError = error;
      }
    }
    const active = this.active;
    if (active) {
      active.fenced = true;
      active.execution.fence();
      this.hooks.onPhase?.('runner.fenced');
      active.modelAbort?.abort();
      this.hooks.onPhase?.('model.abort_requested');
      active.execution.kill('SIGTERM');
      await active.execution.completion;
      this.hooks.onPhase?.('runner.reaped');
      await active.loop.catch(() => undefined);
      if (!active.terminalCommitted) {
        const database = await this.getDatabase();
        new TurnTerminalizer(database).interrupt({
          binding: active.claim,
          reason: 'daemon_shutdown',
          executorExited: true,
        });
        active.terminalCommitted = true;
      }
      this.hooks.onPhase?.('turn.interrupted_committed');
      active.completion.resolve(undefined);
      this.active = undefined;
    }
    if (this.database) {
      this.database.close();
      this.database = undefined;
    }
    if (pendingError !== undefined) throw pendingError;
  }

  private async cancelPendingStart(
    pending: DriverPendingStart,
    database: Database.Database,
  ): Promise<ExecutionRun> {
    const execution = pending.execution;
    if (execution) {
      execution.fence();
      this.hooks.onPhase?.('runner.fenced');
      execution.kill('SIGTERM');
      await execution.completion;
      this.hooks.onPhase?.('runner.reaped');
    }
    if (!pending.terminalCommitted) {
      new TurnTerminalizer(database).interrupt({
        binding: pending.claim,
        reason: 'daemon_shutdown',
        executorExited: true,
      });
      pending.terminalCommitted = true;
    }
    this.hooks.onPhase?.('turn.interrupted_committed');
    pending.completion.resolve(undefined);
    return { completion: pending.completion.promise };
  }

  private async getDatabase(): Promise<Database.Database> {
    this.databasePromise ??= openRuntimeDatabase({ dataDir: this.options.dataDir });
    this.database ??= await this.databasePromise;
    return this.database;
  }

  private async readContext(claim: Claim): Promise<RunnerModelMessage[]> {
    const database = await this.getDatabase();
    const rows = database
      .prepare(
        `SELECT messages.role, messages.content
         FROM messages
         JOIN turns ON turns.id = messages.turn_id
         WHERE messages.session_id = ? AND messages.status = 'completed'
           AND turns.ordinal <= (
             SELECT ordinal FROM turns WHERE id = ? AND session_id = ?
           )
         ORDER BY turns.ordinal, messages.created_at, messages.id`,
      )
      .all(claim.sessionId, claim.turnId, claim.sessionId) as Array<{
      readonly role: string;
      readonly content: string;
    }>;
    return rows.map((row) =>
      row.role === 'assistant'
        ? { role: 'assistant', content: row.content, toolCalls: [] }
        : { role: 'user', content: row.content },
    );
  }

  private persistHeartbeat(binding: RunnerBinding): void {
    const database = this.database;
    if (!database) return;
    const now = new Date();
    const expires = new Date(now.getTime() + 30_000);
    const result = database
      .prepare(
        `UPDATE runner_leases
         SET heartbeat_at = ?, lease_expires_at = ?
         WHERE id = ? AND daemon_epoch = ? AND lease_epoch = ?
           AND session_id = ? AND current_turn_id = ? AND status = 'active'
           AND runner_instance_id = ?`,
      )
      .run(
        now.toISOString(),
        expires.toISOString(),
        binding.leaseId,
        binding.daemonEpoch,
        binding.leaseEpoch,
        binding.sessionId,
        binding.turnId,
        binding.runnerInstanceId,
      );
    if (result.changes !== 1) throw codedError('RUNNER_HEARTBEAT_REJECTED');
  }

  private async persistExecutorIdentity(
    binding: RunnerBinding,
    identity: ProcessIdentity,
  ): Promise<void> {
    const database = await this.getDatabase();
    const result = database
      .prepare(
        `UPDATE runner_leases
         SET pid = ?, process_start_identity = ?
         WHERE id = ? AND daemon_epoch = ? AND lease_epoch = ?
           AND session_id = ? AND current_turn_id = ? AND status = 'active'
           AND runner_instance_id = ? AND pid IS NULL
           AND process_start_identity IS NULL`,
      )
      .run(
        identity.pid,
        identity.processStartIdentity,
        binding.leaseId,
        binding.daemonEpoch,
        binding.leaseEpoch,
        binding.sessionId,
        binding.turnId,
        binding.runnerInstanceId,
      );
    if (result.changes !== 1) throw codedError('RUNNER_IDENTITY_PERSIST_FAILED');
  }
}

export const createRunnerExecutionDriver = (options: {
  readonly dataDir: string;
  readonly runnerEntryPoint: string;
  readonly modelAdapter: ModelAdapter;
  readonly provider: {
    readonly endpoint: string;
    readonly modelId: string;
    readonly apiKey: string;
  };
  readonly toolHandlers?: Readonly<
    Record<
      string,
      (input: {
        readonly toolRunId: string;
        readonly toolId: string;
        readonly input: unknown;
      }) => Promise<{ readonly content: string }>
    >
  >;
  readonly hooks?: DriverHooks;
}): ExecutionDriver =>
  new RunnerExecutionDriver({
    dataDir: options.dataDir,
    runnerEntryPoint: options.runnerEntryPoint,
    modelAdapter: options.modelAdapter,
    provider: options.provider,
    toolHandlers: options.toolHandlers ?? {},
    hooks: options.hooks ?? {},
  });
