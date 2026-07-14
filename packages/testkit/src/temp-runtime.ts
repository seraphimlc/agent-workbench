import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type StdioOptions,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';

const DEFAULT_PROCESS_TIMEOUT_MS = 5_000;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const HELPER_EXIT_GRACE_MS = 750;
const HELPER_SIGNAL_GRACE_MS = 750;
const PROCESS_POLL_INTERVAL_MS = 25;
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const daemonEntryPoint = fileURLToPath(
  new URL('../../../services/daemon/src/index.ts', import.meta.url),
);

const isBootstrapSecretEnvironmentKey = (key: string): boolean => {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const bootstrapIndex = normalizedKey.indexOf('bootstrap');
  return (
    bootstrapIndex >= 0 &&
    normalizedKey.indexOf('secret', bootstrapIndex + 'bootstrap'.length) >= 0
  );
};

const isStrictlyWithin = (parent: string, child: string): boolean => {
  const relation = relative(parent, child);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
};

const assertFixtureBoundary = (fixtureRoot: string): void => {
  const tempRoot = realpathSync(tmpdir());
  const resolvedFixtureRoot = realpathSync(fixtureRoot);

  if (!isStrictlyWithin(tempRoot, resolvedFixtureRoot)) {
    throw new Error('Test fixture must remain inside the operating-system temp directory');
  }
};

export interface TempRuntime {
  readonly rootDir: string;
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly alternateSocketPath: string;
  spawnDaemon(options?: SpawnDaemonOptions): DaemonProcess;
  cleanup(): Promise<void>;
}

export interface SpawnDaemonOptions {
  readonly bootstrapSecret?: Buffer;
  readonly bootstrapSecretChunks?: readonly Uint8Array[];
  readonly socketPath?: string;
  readonly dataDir?: string;
  readonly additionalArguments?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly omitBootstrapFd?: boolean;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const withFailureGuard = async <T>(
  promise: Promise<T>,
  description: string | (() => string),
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
): Promise<T> =>
  await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      const currentDescription =
        typeof description === 'function' ? description() : description;
      rejectPromise(new Error(`Timed out waiting for ${currentDescription}`));
    }, timeoutMs);

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

type ProcessIdentity = {
  readonly pid: number;
  readonly processStartIdentity: string;
};

type ProcessState = 'live' | 'stale' | 'ambiguous';

const normalizeProcessStartIdentity = (identity: string): string =>
  identity.trim().replace(/\s+/g, ' ');

const runPs = (arguments_: readonly string[]): string => {
  for (const executable of ['/bin/ps', '/usr/bin/ps']) {
    const result = spawnSync(executable, [...arguments_], {
      encoding: 'utf8',
      shell: false,
      timeout: 2_000,
    });
    if (!result.error && result.status === 0) {
      return result.stdout;
    }
  }

  throw new Error('Unable to inspect child process identities');
};

const readProcessStartIdentity = (pid: number): string => {
  const identity = normalizeProcessStartIdentity(
    runPs(['-o', 'lstart=', '-p', String(pid)]),
  );
  if (identity.length === 0) {
    throw new Error('Unable to determine child process start identity');
  }
  return identity;
};

const captureDescendantIdentities = (parentPid: number): ProcessIdentity[] => {
  const processes = runPs(['-axo', 'pid=,ppid=,lstart='])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) {
        throw new Error('Unable to parse child process identity');
      }
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processStartIdentity: normalizeProcessStartIdentity(match[3] as string),
      };
    });
  const descendants: ProcessIdentity[] = [];
  const pendingParents = [parentPid];

  while (pendingParents.length > 0) {
    const currentParent = pendingParents.shift() as number;
    for (const processEntry of processes) {
      if (processEntry.parentPid !== currentParent) {
        continue;
      }
      descendants.push({
        pid: processEntry.pid,
        processStartIdentity: processEntry.processStartIdentity,
      });
      pendingParents.push(processEntry.pid);
    }
  }

  return descendants;
};

const probeProcessIdentity = (identity: ProcessIdentity): ProcessState => {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ESRCH') {
      return 'stale';
    }
    if (code !== 'EPERM') {
      return 'ambiguous';
    }
  }

  try {
    return readProcessStartIdentity(identity.pid) === identity.processStartIdentity
      ? 'live'
      : 'stale';
  } catch {
    return 'ambiguous';
  }
};

const unresolvedProcessIdentities = (
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] =>
  identities.filter((identity) => probeProcessIdentity(identity) !== 'stale');

const waitForProcessIdentitiesToExit = async (
  identities: readonly ProcessIdentity[],
  timeoutMs: number,
): Promise<ProcessIdentity[]> => {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const unresolved = unresolvedProcessIdentities(identities);
    if (unresolved.length === 0 || Date.now() >= deadline) {
      return unresolved;
    }
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, PROCESS_POLL_INTERVAL_MS),
    );
  }
};

const signalMatchingProcessIdentities = (
  identities: readonly ProcessIdentity[],
  signal: NodeJS.Signals,
): void => {
  for (const identity of identities) {
    if (probeProcessIdentity(identity) !== 'live') {
      continue;
    }
    try {
      process.kill(identity.pid, signal);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      if (code !== 'ESRCH') {
        throw error;
      }
    }
  }
};

export class DaemonProcess {
  readonly child: ChildProcess;
  readonly bootstrapSecret: Buffer;
  readonly launchArguments: readonly string[];
  readonly launchEnvironment: Readonly<NodeJS.ProcessEnv>;

  private readonly completionPromise: Promise<ProcessExit>;
  private readonly readyPromise: Promise<void>;
  private readonly secretForms: readonly string[];
  private capturedDescendantIdentities: readonly ProcessIdentity[] = [];
  private stopPromise: Promise<ProcessExit> | undefined;
  private stdoutText = '';
  private stderrText = '';
  private stdoutLineBuffer = '';
  private stdoutLineBufferTruncated = false;

  constructor(
    child: ChildProcess,
    bootstrapSecret: Buffer,
    launchArguments: readonly string[],
    launchEnvironment: NodeJS.ProcessEnv,
  ) {
    this.child = child;
    this.bootstrapSecret = Buffer.from(bootstrapSecret);
    this.launchArguments = [...launchArguments];
    this.launchEnvironment = { ...launchEnvironment };
    this.secretForms = [
      this.bootstrapSecret.toString('utf8'),
      this.bootstrapSecret.toString('hex'),
      this.bootstrapSecret.toString('base64'),
    ].filter((value) => value.length > 0);

    child.stdout?.setEncoding('utf8');
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let ready = false;
    this.readyPromise = new Promise((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise;
      rejectReady = rejectPromise;
    });
    void this.readyPromise.catch(() => {
      // A process-scaffolding test may intentionally stop before readiness.
    });

    child.stdout?.on('data', (chunk: string) => {
      this.stdoutText = this.appendOutputTail(this.stdoutText, chunk).text;
      const lineCapture = this.appendOutputTail(this.stdoutLineBuffer, chunk);
      this.stdoutLineBuffer = lineCapture.text;
      this.stdoutLineBufferTruncated ||= lineCapture.truncated;

      while (this.stdoutLineBuffer.includes('\n')) {
        const newlineIndex = this.stdoutLineBuffer.indexOf('\n');
        const line = this.stdoutLineBuffer.slice(0, newlineIndex);
        this.stdoutLineBuffer = this.stdoutLineBuffer.slice(newlineIndex + 1);
        const lineWasTruncated = this.stdoutLineBufferTruncated;
        this.stdoutLineBufferTruncated = false;

        if (lineWasTruncated) {
          continue;
        }

        try {
          const event: unknown = JSON.parse(line);
          if (
            typeof event === 'object' &&
            event !== null &&
            'event' in event &&
            event.event === 'ready' &&
            !ready
          ) {
            ready = true;
            resolveReady();
          }
        } catch {
          // Non-JSON output is retained for diagnostics but is not a ready signal.
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrText = this.appendOutputTail(this.stderrText, chunk).text;
    });

    this.completionPromise = new Promise((resolvePromise, rejectPromise) => {
      child.once('error', (error) => {
        if (!ready) {
          rejectReady(error);
        }
        rejectPromise(error);
      });
      child.once('close', (code, signal) => {
        if (!ready) {
          rejectReady(new Error(`Daemon exited before ready. ${this.diagnostics()}`));
        }
        resolvePromise({ code, signal });
      });
    });
    void this.completionPromise.catch(() => {
      // The cached failure is observed by waitForExit/stop when the fixture is cleaned.
    });
  }

  get stdout(): string {
    return this.stdoutText;
  }

  get stderr(): string {
    return this.stderrText;
  }

  async waitForExit(timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS): Promise<ProcessExit> {
    return await withFailureGuard(
      this.completionPromise,
      () => `daemon exit. ${this.diagnostics()}`,
      timeoutMs,
    );
  }

  async waitForReady(timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS): Promise<void> {
    await withFailureGuard(
      this.readyPromise,
      () => `daemon readiness. ${this.diagnostics()}`,
      timeoutMs,
    );
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<ProcessExit> {
    this.stopPromise ??= this.performStop(signal);
    return await this.stopPromise;
  }

  private async performStop(signal: NodeJS.Signals): Promise<ProcessExit> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      if (this.child.pid === undefined) {
        throw new Error('Daemon child has no process id');
      }
      this.capturedDescendantIdentities = captureDescendantIdentities(
        this.child.pid,
      );
      this.child.kill(signal);
    }

    let exit: ProcessExit;
    try {
      exit = await this.waitForExit();
    } catch (error) {
      if (signal === 'SIGKILL') {
        await this.ensureCapturedDescendantsExited();
        throw error;
      }

      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill('SIGKILL');
      }
      exit = await this.waitForExit();
    }

    await this.ensureCapturedDescendantsExited();
    return exit;
  }

  private async ensureCapturedDescendantsExited(): Promise<void> {
    let unresolved = await waitForProcessIdentitiesToExit(
      this.capturedDescendantIdentities,
      HELPER_EXIT_GRACE_MS,
    );
    if (unresolved.length === 0) {
      return;
    }

    signalMatchingProcessIdentities(unresolved, 'SIGTERM');
    unresolved = await waitForProcessIdentitiesToExit(
      unresolved,
      HELPER_SIGNAL_GRACE_MS,
    );
    if (unresolved.length === 0) {
      return;
    }

    signalMatchingProcessIdentities(unresolved, 'SIGKILL');
    unresolved = await waitForProcessIdentitiesToExit(
      unresolved,
      HELPER_SIGNAL_GRACE_MS,
    );
    if (unresolved.length > 0) {
      throw new Error('Daemon lock helper did not exit after forced cleanup');
    }
  }

  private appendOutputTail(
    current: string,
    chunk: string,
  ): { readonly text: string; readonly truncated: boolean } {
    const combined = this.redactOutput(current + chunk);
    const combinedBytes = Buffer.from(combined, 'utf8');

    if (combinedBytes.byteLength <= MAX_CAPTURED_OUTPUT_BYTES) {
      return { text: combined, truncated: false };
    }

    let start = combinedBytes.byteLength - MAX_CAPTURED_OUTPUT_BYTES;
    while (
      start < combinedBytes.byteLength &&
      ((combinedBytes[start] as number) & 0xc0) === 0x80
    ) {
      start += 1;
    }

    return {
      text: combinedBytes.subarray(start).toString('utf8'),
      truncated: true,
    };
  }

  private redactOutput(value: string): string {
    let redacted = value;
    for (const secret of this.secretForms) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
  }

  private diagnostics(): string {
    let stdout = this.stdoutText;
    let stderr = this.stderrText;

    for (const secret of this.secretForms) {
      stdout = stdout.split(secret).join('[REDACTED]');
      stderr = stderr.split(secret).join('[REDACTED]');
    }

    return `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
  }
}

const requireSecretPipe = (child: ChildProcess): Writable => {
  const secretPipe = child.stdio[3];

  if (secretPipe === null || typeof (secretPipe as Writable).end !== 'function') {
    child.kill('SIGKILL');
    throw new Error('Daemon child fd 3 pipe was not created');
  }

  return secretPipe as Writable;
};

export const createTempRuntime = (): TempRuntime => {
  const tempRoot = realpathSync(tmpdir());
  const rootDir = mkdtempSync(join(tempRoot, 'awb-'));
  const dataDir = join(rootDir, 'd');
  const runtimeDir = join(rootDir, 'r');
  const socketPath = join(runtimeDir, 'd.sock');
  const alternateSocketPath = join(runtimeDir, 'x.sock');

  if (
    Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES ||
    Buffer.byteLength(alternateSocketPath) > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    rmSync(rootDir, { force: true, recursive: true });
    throw new Error('Test fixture Unix socket path exceeds the portable byte limit');
  }

  chmodSync(rootDir, 0o700);
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(runtimeDir, { mode: 0o700 });
  assertFixtureBoundary(rootDir);

  let cleaned = false;
  const daemons = new Set<DaemonProcess>();

  return {
    rootDir,
    dataDir,
    runtimeDir,
    socketPath,
    alternateSocketPath,
    spawnDaemon(options: SpawnDaemonOptions = {}): DaemonProcess {
      if (cleaned) {
        throw new Error('Cannot spawn a daemon from a cleaned test fixture');
      }

      assertFixtureBoundary(rootDir);
      const secretChunks = options.bootstrapSecretChunks?.map((chunk) =>
        Buffer.from(chunk),
      );
      const chunkedSecret = secretChunks ? Buffer.concat(secretChunks) : undefined;
      if (
        options.bootstrapSecret &&
        chunkedSecret &&
        !options.bootstrapSecret.equals(chunkedSecret)
      ) {
        throw new Error('Explicit and chunked bootstrap secrets must match');
      }
      const bootstrapSecret =
        options.bootstrapSecret ?? chunkedSecret ?? randomBytes(32);
      const launchArguments = [
        '--conditions=development',
        '--import',
        'tsx',
        daemonEntryPoint,
        '--socket',
        options.socketPath ?? socketPath,
        '--data-dir',
        options.dataDir ?? dataDir,
        ...(options.additionalArguments ?? []),
      ];
      const inheritedEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !isBootstrapSecretEnvironmentKey(key),
        ),
      );
      const launchEnvironment = {
        ...inheritedEnvironment,
        ...options.environment,
      };
      const stdio: StdioOptions = options.omitBootstrapFd
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe', 'pipe'];
      const child = spawn(process.execPath, launchArguments, {
        cwd: repositoryRoot,
        env: launchEnvironment,
        shell: false,
        stdio,
      });
      const daemon = new DaemonProcess(
        child,
        bootstrapSecret,
        launchArguments,
        launchEnvironment,
      );
      daemons.add(daemon);

      if (!options.omitBootstrapFd) {
        const secretPipe = requireSecretPipe(child);
        secretPipe.on('error', () => {
          // A startup failure may close fd 3 before the parent finishes the bounded write.
        });
        if (!secretChunks) {
          secretPipe.end(bootstrapSecret);
        } else {
          let chunkIndex = 0;
          const writeNextChunk = (): void => {
            const chunk = secretChunks[chunkIndex];
            if (!chunk) {
              secretPipe.end();
              return;
            }

            chunkIndex += 1;
            const canContinue = secretPipe.write(chunk);
            if (canContinue) {
              setImmediate(writeNextChunk);
            } else {
              secretPipe.once('drain', () => setImmediate(writeNextChunk));
            }
          };
          writeNextChunk();
        }
      }

      return daemon;
    },
    async cleanup(): Promise<void> {
      if (cleaned) {
        return;
      }

      const stopResults = await Promise.allSettled(
        [...daemons].map(async (daemon) => await daemon.stop()),
      );
      const failures = stopResults.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          'One or more daemon children failed to stop during test cleanup',
        );
      }

      assertFixtureBoundary(rootDir);
      rmSync(rootDir, { force: true, recursive: true });
      cleaned = true;
    },
  };
};
