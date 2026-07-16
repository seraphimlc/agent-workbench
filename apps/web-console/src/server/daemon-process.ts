import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const MAX_CAPTURED_STDERR_BYTES = 64 * 1024;
const MAX_READY_LINE_BYTES = 64 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export type DaemonProcessErrorCode =
  | 'DAEMON_DIRECTORY_INVALID'
  | 'DAEMON_SOCKET_PATH_TOO_LONG'
  | 'DAEMON_SPAWN_FAILED'
  | 'DAEMON_READY_INVALID'
  | 'DAEMON_STARTUP_TIMEOUT'
  | 'DAEMON_EXITED_BEFORE_READY'
  | 'DAEMON_STOP_FAILED';

export class DaemonProcessError extends Error {
  readonly code: DaemonProcessErrorCode;

  constructor(code: DaemonProcessErrorCode, message: string) {
    super(message);
    this.name = 'DaemonProcessError';
    this.code = code;
  }
}

export type ResolvedProviderConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
};

export type DaemonProcessStartOptions = {
  readonly dataDir: string;
  readonly workspacePath: string;
  readonly provider: ResolvedProviderConfig;
};

export type DaemonProcessHandle = {
  readonly pid: number;
  readonly socketPath: string;
  readonly bootstrapSecret: Buffer;
  stop(): Promise<void>;
};

export type DaemonProcessManagerOptions = {
  readonly entryPoint?: string;
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
};

type ProcessExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

const isPositiveTimeout = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const currentUid = (): number => {
  if (typeof process.getuid !== 'function') {
    throw new DaemonProcessError(
      'DAEMON_DIRECTORY_INVALID',
      'Daemon process management requires Unix ownership checks',
    );
  }
  return process.getuid();
};

const modeBits = (mode: number): number => mode & 0o777;

const ensurePrivateDirectory = (path: string): string => {
  const resolvedPath = resolve(path);
  try {
    mkdirSync(resolvedPath, { mode: 0o700, recursive: true });
    const initialStatus = lstatSync(resolvedPath);
    if (
      !initialStatus.isDirectory() ||
      initialStatus.isSymbolicLink() ||
      initialStatus.uid !== currentUid()
    ) {
      throw new Error('invalid directory boundary');
    }
    chmodSync(resolvedPath, 0o700);
    const canonicalPath = realpathSync(resolvedPath);
    const finalStatus = lstatSync(canonicalPath);
    if (
      !finalStatus.isDirectory() ||
      finalStatus.isSymbolicLink() ||
      finalStatus.uid !== currentUid() ||
      modeBits(finalStatus.mode) !== 0o700
    ) {
      throw new Error('invalid directory mode');
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof DaemonProcessError) throw error;
    throw new DaemonProcessError(
      'DAEMON_DIRECTORY_INVALID',
      'Daemon data directory boundary is invalid',
    );
  }
};

const createRuntimeDirectory = (): string => {
  const runtimeRoot = realpathSync(tmpdir());
  const runtimeDir = mkdtempSync(join(runtimeRoot, 'awb-d-'));
  try {
    return ensurePrivateDirectory(runtimeDir);
  } catch (error) {
    rmSync(runtimeDir, { force: true, recursive: true });
    throw error;
  }
};

const isBootstrapSecretEnvironmentKey = (key: string): boolean => {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const bootstrapIndex = normalizedKey.indexOf('bootstrap');
  return (
    bootstrapIndex >= 0 &&
    normalizedKey.indexOf('secret', bootstrapIndex + 'bootstrap'.length) >= 0
  );
};

const controlledEnvironmentKeys = new Set(
  [
    'AGENT_WORKBENCH_PROVIDER_BASE_URL',
    'AGENT_WORKBENCH_PROVIDER_API_KEY',
    'AGENT_WORKBENCH_PROVIDER_MODEL',
    'AGENT_WORKBENCH_DEMO_WORKSPACE',
  ].map((key) => key.replace(/[^a-z0-9]/gi, '').toLowerCase()),
);

const controlledEnvironment = (
  provider: ResolvedProviderConfig,
  workspacePath: string,
): NodeJS.ProcessEnv => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      if (isBootstrapSecretEnvironmentKey(key)) return false;
      const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      return !controlledEnvironmentKeys.has(normalizedKey);
    }),
  );
  return {
    ...environment,
    AGENT_WORKBENCH_PROVIDER_BASE_URL: provider.baseUrl,
    AGENT_WORKBENCH_PROVIDER_API_KEY: provider.apiKey,
    AGENT_WORKBENCH_PROVIDER_MODEL: provider.modelId,
    AGENT_WORKBENCH_DEMO_WORKSPACE: workspacePath,
  };
};

const defaultEntryPoint = (): string =>
  fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts')
        ? './configured-daemon-entry.ts'
        : './configured-daemon-entry.js',
      import.meta.url,
    ),
  );

const appendBounded = (
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number },
): void => {
  const remaining = Math.max(0, MAX_CAPTURED_STDERR_BYTES - state.bytes);
  if (remaining === 0) return;
  const captured = chunk.subarray(0, remaining);
  chunks.push(captured);
  state.bytes += captured.byteLength;
};

const redact = (value: string, secrets: readonly string[]): string => {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
};

const waitWithTimeout = async <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<Value | undefined> =>
  await new Promise<Value | undefined>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => resolvePromise(undefined), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });

const processIsRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

const terminateAndReap = async (
  child: ChildProcess,
  completion: Promise<ProcessExit>,
  timeoutMs: number,
): Promise<void> => {
  if (!processIsRunning(child)) {
    if ((await waitWithTimeout(completion, timeoutMs)) === undefined) {
      throw new DaemonProcessError(
        'DAEMON_STOP_FAILED',
        'Daemon process close event did not arrive',
      );
    }
    return;
  }
  child.kill('SIGTERM');
  if ((await waitWithTimeout(completion, timeoutMs)) !== undefined) return;
  if (processIsRunning(child)) child.kill('SIGKILL');
  if ((await waitWithTimeout(completion, timeoutMs)) === undefined) {
    throw new DaemonProcessError(
      'DAEMON_STOP_FAILED',
      'Daemon process did not exit after forced termination',
    );
  }
};

const validateProvider = (provider: ResolvedProviderConfig): void => {
  if (
    provider.baseUrl.trim().length === 0 ||
    provider.apiKey.trim().length === 0 ||
    provider.modelId.trim().length === 0
  ) {
    throw new DaemonProcessError(
      'DAEMON_SPAWN_FAILED',
      'Configured daemon provider is invalid',
    );
  }
};

export class DaemonProcessManager {
  private readonly entryPoint: string;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private activeHandle: DaemonProcessHandle | undefined;

  constructor(options: DaemonProcessManagerOptions = {}) {
    this.entryPoint = resolve(options.entryPoint ?? defaultEntryPoint());
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    if (
      !isPositiveTimeout(this.startupTimeoutMs) ||
      !isPositiveTimeout(this.stopTimeoutMs)
    ) {
      throw new DaemonProcessError(
        'DAEMON_SPAWN_FAILED',
        'Daemon process timeout configuration is invalid',
      );
    }
  }

  async start(options: DaemonProcessStartOptions): Promise<DaemonProcessHandle> {
    if (this.activeHandle !== undefined) {
      throw new DaemonProcessError(
        'DAEMON_SPAWN_FAILED',
        'Daemon process manager already owns a child',
      );
    }
    validateProvider(options.provider);
    const dataDir = ensurePrivateDirectory(options.dataDir);
    const runtimeDir = createRuntimeDirectory();
    const socketPath = join(runtimeDir, 'd.sock');
    if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      rmSync(runtimeDir, { force: true, recursive: true });
      throw new DaemonProcessError(
        'DAEMON_SOCKET_PATH_TOO_LONG',
        'Daemon Unix socket path exceeds the portable byte limit',
      );
    }

    const bootstrapSecret = randomBytes(32);
    const handleSecret = Buffer.from(bootstrapSecret);
    const secretForms = [
      bootstrapSecret.toString('utf8'),
      bootstrapSecret.toString('hex'),
      bootstrapSecret.toString('base64'),
      options.provider.apiKey,
    ].filter((value) => value.length > 0);
    const launchArguments = [
      ...(this.entryPoint.endsWith('.ts')
        ? ['--conditions=development', '--import', 'tsx']
        : []),
      this.entryPoint,
      '--socket',
      socketPath,
      '--data-dir',
      dataDir,
    ];
    const launchEnvironment = controlledEnvironment(
      options.provider,
      resolve(options.workspacePath),
    );
    const child = spawn(process.execPath, launchArguments, {
      cwd: process.cwd(),
      env: launchEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    const stderrState = { bytes: 0 };
    child.stderr?.on('data', (chunk: Buffer) => {
      appendBounded(stderrChunks, chunk, stderrState);
    });

    let resolveCompletion!: (exit: ProcessExit) => void;
    const completion = new Promise<ProcessExit>((resolvePromise) => {
      resolveCompletion = resolvePromise;
    });
    child.once('close', (code, signal) => resolveCompletion({ code, signal }));

    let rejectReady!: (error: DaemonProcessError) => void;
    let resolveReady!: () => void;
    let readySettled = false;
    let readyCount = 0;
    let stdoutBuffer = '';
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise;
      rejectReady = rejectPromise;
    });
    void ready.catch(() => undefined);

    const startupError = (
      code: DaemonProcessErrorCode,
      message: string,
    ): DaemonProcessError => {
      const stderr = redact(Buffer.concat(stderrChunks).toString('utf8'), secretForms);
      return new DaemonProcessError(
        code,
        stderr.length > 0 ? `${message}. stderr=${JSON.stringify(stderr)}` : message,
      );
    };
    const failReady = (code: DaemonProcessErrorCode, message: string): void => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(startupError(code, message));
    };

    child.once('error', () => {
      failReady('DAEMON_SPAWN_FAILED', 'Daemon process could not be spawned');
    });
    child.once('close', (code, signal) => {
      failReady(
        'DAEMON_EXITED_BEFORE_READY',
        `Daemon exited before ready (code=${String(code)}, signal=${String(signal)})`,
      );
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (readySettled) return;
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer) > MAX_READY_LINE_BYTES) {
        failReady('DAEMON_READY_INVALID', 'Daemon ready output exceeded its bound');
        return;
      }
      while (stdoutBuffer.includes('\n')) {
        const newlineIndex = stdoutBuffer.indexOf('\n');
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          failReady('DAEMON_READY_INVALID', 'Daemon ready output is invalid');
          return;
        }
        const keys =
          typeof event === 'object' && event !== null ? Object.keys(event).sort() : [];
        if (
          typeof event !== 'object' ||
          event === null ||
          keys.join(',') !== 'event,pid,protocolVersion' ||
          !('event' in event) ||
          event.event !== 'ready' ||
          !('protocolVersion' in event) ||
          event.protocolVersion !== 1 ||
          !('pid' in event) ||
          event.pid !== child.pid
        ) {
          failReady('DAEMON_READY_INVALID', 'Daemon ready event is invalid');
          return;
        }
        readyCount += 1;
        if (readyCount !== 1) {
          failReady('DAEMON_READY_INVALID', 'Daemon emitted multiple ready events');
          return;
        }
        setImmediate(() => {
          if (readySettled || readyCount !== 1) return;
          readySettled = true;
          resolveReady();
        });
      }
    });

    const secretPipe = child.stdio[3] as Writable | null;
    const secretTransport = new Promise<void>((resolvePromise, rejectPromise) => {
      if (secretPipe === null || typeof secretPipe.end !== 'function') {
        rejectPromise(
          new DaemonProcessError(
            'DAEMON_SPAWN_FAILED',
            'Daemon bootstrap secret pipe is unavailable',
          ),
        );
        return;
      }
      secretPipe.once('error', rejectPromise);
      secretPipe.end(bootstrapSecret, resolvePromise);
    });
    const startupTimer = setTimeout(() => {
      failReady('DAEMON_STARTUP_TIMEOUT', 'Timed out waiting for daemon readiness');
    }, this.startupTimeoutMs);

    try {
      await Promise.all([ready, secretTransport]);
      if (child.pid === undefined || !processIsRunning(child)) {
        throw startupError(
          'DAEMON_EXITED_BEFORE_READY',
          'Daemon exited before the ready handle could be returned',
        );
      }
    } catch (error) {
      await terminateAndReap(child, completion, this.stopTimeoutMs).catch(() => undefined);
      rmSync(runtimeDir, { force: true, recursive: true });
      handleSecret.fill(0);
      if (error instanceof DaemonProcessError) throw error;
      throw startupError('DAEMON_SPAWN_FAILED', 'Daemon startup failed');
    } finally {
      clearTimeout(startupTimer);
      bootstrapSecret.fill(0);
    }

    let stopPromise: Promise<void> | undefined;
    const stop = async (): Promise<void> => {
      stopPromise ??= (async () => {
        try {
          await terminateAndReap(child, completion, this.stopTimeoutMs);
        } finally {
          rmSync(runtimeDir, { force: true, recursive: true });
          if (this.activeHandle === handle) this.activeHandle = undefined;
        }
      })();
      await stopPromise;
    };
    const handle: DaemonProcessHandle = Object.freeze({
      pid: child.pid,
      socketPath,
      bootstrapSecret: handleSecret,
      stop,
    });
    this.activeHandle = handle;
    void completion.then(() => {
      rmSync(runtimeDir, { force: true, recursive: true });
      if (this.activeHandle === handle) this.activeHandle = undefined;
    });
    return handle;
  }
}
