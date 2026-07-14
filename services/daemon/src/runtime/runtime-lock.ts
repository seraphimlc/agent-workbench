import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const LOCK_FILE_NAME = '.daemon.lock';
const OWNER_FILE_NAME = '.daemon-owner.json';
const OWNER_TEMP_PREFIX = 'owner-';
const OWNER_TEMP_SUFFIX = '.tmp';
const OWNER_TEMP_PATTERN =
  /^owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const MAX_OWNER_BYTES = 64 * 1024;
const MAX_PREDECESSORS = 64;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const LOCK_RELEASE_TIMEOUT_MS = 5_000;
const MACOS_LOCK_BUSY_EXIT = 75;
const LINUX_FLOCK_BUSY_EXIT = 1;
const LEGACY_OWNER_PATTERN = /^owner-.*\.json$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const DaemonEpochSchema = z.string().regex(UUID_V7_PATTERN);

const OwnerIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1).max(512),
    daemonEpoch: DaemonEpochSchema,
    socketPath: z.string().min(1).refine(isAbsolute),
  })
  .strict();

const LegacyOwnerRecordSchema = OwnerIdentitySchema.extend({
  predecessor: z.array(OwnerIdentitySchema).max(MAX_PREDECESSORS),
})
  .strict()
  .superRefine((owner, context) => {
    const epochs = new Set<string>([owner.daemonEpoch]);
    owner.predecessor.forEach((predecessor, index) => {
      if (epochs.has(predecessor.daemonEpoch)) {
        context.addIssue({
          code: 'custom',
          message: 'Runtime predecessor epochs must be unique',
          path: ['predecessor', index, 'daemonEpoch'],
        });
      }
      epochs.add(predecessor.daemonEpoch);
    });
  });

const OwnerRecordSchema = OwnerIdentitySchema.extend({
  state: z.literal('active'),
  predecessor: z.array(OwnerIdentitySchema).max(MAX_PREDECESSORS),
})
  .strict()
  .superRefine((owner, context) => {
    const epochs = new Set<string>([owner.daemonEpoch]);
    owner.predecessor.forEach((predecessor, index) => {
      if (epochs.has(predecessor.daemonEpoch)) {
        context.addIssue({
          code: 'custom',
          message: 'Runtime predecessor epochs must be unique',
          path: ['predecessor', index, 'daemonEpoch'],
        });
      }
      epochs.add(predecessor.daemonEpoch);
    });
  });

const ReleasedOwnerRecordSchema = z
  .object({
    state: z.literal('released'),
    predecessor: z.array(OwnerIdentitySchema).max(MAX_PREDECESSORS),
  })
  .strict()
  .superRefine((owner, context) => {
    const epochs = new Set<string>();
    owner.predecessor.forEach((predecessor, index) => {
      if (epochs.has(predecessor.daemonEpoch)) {
        context.addIssue({
          code: 'custom',
          message: 'Runtime predecessor epochs must be unique',
          path: ['predecessor', index, 'daemonEpoch'],
        });
      }
      epochs.add(predecessor.daemonEpoch);
    });
  });

const PersistedOwnerRecordSchema = z.union([
  OwnerRecordSchema,
  ReleasedOwnerRecordSchema,
  LegacyOwnerRecordSchema,
]);

const LockAckSchema = z
  .object({
    event: z.literal('LOCKED'),
    daemonEpoch: DaemonEpochSchema,
    predecessor: z.array(OwnerIdentitySchema).max(MAX_PREDECESSORS),
  })
  .strict();

export type OwnerIdentity = z.infer<typeof OwnerIdentitySchema>;
export type OwnerRecord = z.infer<typeof OwnerRecordSchema>;
type ReleasedOwnerRecord = z.infer<typeof ReleasedOwnerRecordSchema>;
type PersistedOwnerRecord = OwnerRecord | ReleasedOwnerRecord;
type LockAck = z.infer<typeof LockAckSchema>;

export class SingleInstanceError extends Error {
  readonly code = 'DAEMON_ALREADY_RUNNING';

  constructor() {
    super('A daemon instance already owns this data directory');
    this.name = 'SingleInstanceError';
  }
}

export class RuntimeLockError extends Error {
  readonly code = 'DAEMON_RUNTIME_LOCK_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeLockError';
  }
}

type ProcessProbe = 'live' | 'stale' | 'ambiguous';

const currentUid = (): number => {
  if (typeof process.getuid !== 'function') {
    throw new RuntimeLockError('Runtime locking requires Unix ownership checks');
  }

  return process.getuid();
};

const modeBits = (mode: number): number => mode & 0o777;
const pathExistsNoFollow = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};
const normalizeProcessStartIdentity = (identity: string): string =>
  identity.trim().replace(/\s+/g, ' ');

export const getProcessStartIdentity = (pid: number): string => {
  const psExecutable = ['/bin/ps', '/usr/bin/ps'].find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!psExecutable) {
    throw new RuntimeLockError('No supported absolute ps executable is available');
  }

  const result = spawnSync(psExecutable, ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    shell: false,
    timeout: 2_000,
  });
  const identity = normalizeProcessStartIdentity(result.stdout ?? '');

  if (result.error || result.status !== 0 || identity.length === 0) {
    throw new RuntimeLockError('Unable to determine process start identity');
  }

  return identity;
};

const probeProcess = (owner: OwnerIdentity): ProcessProbe => {
  try {
    process.kill(owner.pid, 0);
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
    return getProcessStartIdentity(owner.pid) === owner.processStartIdentity
      ? 'live'
      : 'stale';
  } catch {
    return 'ambiguous';
  }
};

const ensureOwnedDirectory = (dataDir: string): string => {
  const resolvedDataDir = resolve(dataDir);
  mkdirSync(resolvedDataDir, { mode: 0o700, recursive: true });
  const initialStatus = lstatSync(resolvedDataDir);

  if (
    !initialStatus.isDirectory() ||
    initialStatus.isSymbolicLink() ||
    initialStatus.uid !== currentUid()
  ) {
    throw new RuntimeLockError('Data directory ownership boundary is invalid');
  }

  chmodSync(resolvedDataDir, 0o700);
  const finalStatus = lstatSync(resolvedDataDir);
  if (modeBits(finalStatus.mode) !== 0o700) {
    throw new RuntimeLockError('Data directory must have mode 0700');
  }

  return resolvedDataDir;
};

const ensureLockFile = (dataDir: string): string => {
  const lockPath = join(dataDir, LOCK_FILE_NAME);
  const descriptor = openSync(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );

  try {
    fchmodSync(descriptor, 0o600);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.uid !== currentUid() ||
      modeBits(status.mode) !== 0o600
    ) {
      throw new RuntimeLockError('Runtime lock file ownership boundary is invalid');
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  return lockPath;
};

const ownerFilePath = (dataDir: string): string => join(dataDir, OWNER_FILE_NAME);

const readOwnerRecord = (dataDir: string): PersistedOwnerRecord => {
  const path = ownerFilePath(dataDir);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.uid !== currentUid() ||
      modeBits(status.mode) !== 0o600 ||
      status.size <= 0 ||
      status.size > MAX_OWNER_BYTES
    ) {
      throw new RuntimeLockError('Runtime owner metadata boundary is invalid');
    }

    const parsed = PersistedOwnerRecordSchema.safeParse(
      JSON.parse(readFileSync(descriptor, 'utf8')),
    );
    if (!parsed.success) {
      throw new RuntimeLockError('Runtime owner metadata is invalid');
    }

    if ('state' in parsed.data) {
      return parsed.data;
    }

    return OwnerRecordSchema.parse({
      ...parsed.data,
      state: 'active',
    });
  } catch (error) {
    if (error instanceof RuntimeLockError) {
      throw error;
    }
    throw new RuntimeLockError('Runtime owner metadata is invalid');
  } finally {
    closeSync(descriptor);
  }
};

const writeAll = (descriptor: number, bytes: Uint8Array): void => {
  let offset = 0;

  while (offset < bytes.byteLength) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (written <= 0) {
      throw new RuntimeLockError('Runtime metadata write made no progress');
    }
    offset += written;
  }
};

const replaceOwnerRecordAtomically = (
  dataDir: string,
  owner: PersistedOwnerRecord,
): void => {
  const path = ownerFilePath(dataDir);
  const temporaryPath = join(
    dataDir,
    `${OWNER_TEMP_PREFIX}${randomUUID()}${OWNER_TEMP_SUFFIX}`,
  );
  const descriptor = openSync(
    temporaryPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );

  try {
    fchmodSync(descriptor, 0o600);
    writeAll(descriptor, Buffer.from(JSON.stringify(owner), 'utf8'));
    fsyncSync(descriptor);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A leftover bounded temp file is cleaned under the next kernel lock.
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }

  renameSync(temporaryPath, path);
  fsyncDirectory(dataDir);
};

const cleanOwnerTempFiles = (dataDir: string): void => {
  const tempFiles = readdirSync(dataDir).filter(
    (entry) => OWNER_TEMP_PATTERN.test(entry),
  );

  for (const fileName of tempFiles) {
    const path = join(dataDir, fileName);
    const status = lstatSync(path);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.uid !== currentUid()
    ) {
      throw new RuntimeLockError('Unsafe runtime owner temp file is present');
    }
    unlinkSync(path);
  }

  if (tempFiles.length > 0) {
    fsyncDirectory(dataDir);
  }
};

const fsyncDirectory = (directory: string): void => {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const stripPredecessor = (owner: OwnerRecord): OwnerIdentity => ({
  pid: owner.pid,
  processStartIdentity: owner.processStartIdentity,
  daemonEpoch: owner.daemonEpoch,
  socketPath: owner.socketPath,
});

const encodeOwnerRecord = (owner: OwnerRecord): string =>
  Buffer.from(JSON.stringify(owner), 'utf8').toString('base64url');

const decodeOwnerRecord = (encoded: string): OwnerRecord => {
  if (encoded.length === 0 || encoded.length > MAX_OWNER_BYTES * 2) {
    throw new RuntimeLockError('Lock helper owner input is invalid');
  }

  try {
    return OwnerRecordSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
  } catch {
    throw new RuntimeLockError('Lock helper owner input is invalid');
  }
};

const helperNodeArguments = (
  modulePath: string,
  dataDir: string,
  owner: OwnerRecord,
): string[] => {
  const helperArguments = [
    modulePath,
    '--lock-helper',
    dataDir,
    encodeOwnerRecord(owner),
  ];

  return modulePath.endsWith('.ts')
    ? ['--conditions=development', '--import', 'tsx', ...helperArguments]
    : helperArguments;
};

const findExecutable = (candidates: readonly string[]): string | undefined => {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next supported kernel-lock utility.
    }
  }
  return undefined;
};

const spawnLockHelper = (
  lockPath: string,
  dataDir: string,
  owner: OwnerRecord,
): ChildProcess => {
  const modulePath = fileURLToPath(import.meta.url);
  const nodeArguments = helperNodeArguments(modulePath, dataDir, owner);
  const lockf = findExecutable(['/usr/bin/lockf']);

  if (lockf) {
    return spawn(
      lockf,
      ['-s', '-t', '0', '-k', lockPath, process.execPath, ...nodeArguments],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }

  const flock = findExecutable(['/usr/bin/flock', '/bin/flock']);
  if (flock) {
    return spawn(
      flock,
      ['-n', lockPath, process.execPath, ...nodeArguments],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  }

  throw new RuntimeLockError('No supported kernel advisory-lock utility is available');
};

const appendBounded = (current: string, chunk: string): string => {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') > MAX_HELPER_OUTPUT_BYTES) {
    throw new RuntimeLockError('Lock helper output exceeded its bounded limit');
  }
  return combined;
};

const waitForLockAck = async (
  child: ChildProcess,
  expectedEpoch: string,
): Promise<LockAck> =>
  await new Promise<LockAck>((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      action();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => rejectPromise(new RuntimeLockError('Timed out acquiring runtime lock')));
    }, LOCK_ACQUIRE_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      try {
        stdout = appendBounded(stdout, chunk);
        const newlineIndex = stdout.indexOf('\n');
        if (newlineIndex < 0) {
          return;
        }

        if (newlineIndex !== stdout.length - 1) {
          throw new RuntimeLockError('Lock helper emitted unexpected output');
        }

        const ack = LockAckSchema.parse(JSON.parse(stdout.slice(0, -1)));
        if (ack.daemonEpoch !== expectedEpoch) {
          throw new RuntimeLockError('Lock helper acknowledged a different daemon epoch');
        }

        finish(() => resolvePromise(ack));
      } catch (error) {
        child.kill('SIGKILL');
        finish(() =>
          rejectPromise(
            error instanceof RuntimeLockError
              ? error
              : new RuntimeLockError('Lock helper acknowledgment is invalid'),
          ),
        );
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      try {
        stderr = appendBounded(stderr, chunk);
      } catch (error) {
        child.kill('SIGKILL');
        finish(() => rejectPromise(error as Error));
      }
    });
    child.once('error', (error) => {
      finish(() => rejectPromise(error));
    });
    child.once('close', (code) => {
      finish(() => {
        if (
          code === MACOS_LOCK_BUSY_EXIT ||
          code === LINUX_FLOCK_BUSY_EXIT ||
          stderr.includes('OWNER_STILL_LIVE')
        ) {
          rejectPromise(new SingleInstanceError());
          return;
        }
        rejectPromise(new RuntimeLockError('Kernel lock helper exited before acknowledgment'));
      });
    });
  });

const ownerRecordsMatch = (
  current: PersistedOwnerRecord,
  expected: OwnerRecord,
): boolean =>
  current.state === 'active' &&
  current.daemonEpoch === expected.daemonEpoch &&
  current.pid === expected.pid &&
  current.processStartIdentity === expected.processStartIdentity &&
  current.socketPath === expected.socketPath &&
  JSON.stringify(current.predecessor) === JSON.stringify(expected.predecessor);

const releaseOwnOwnerRecord = (dataDir: string, expected: OwnerRecord): void => {
  const current = readOwnerRecord(dataDir);
  if (!ownerRecordsMatch(current, expected)) {
    throw new RuntimeLockError('Runtime owner metadata no longer belongs to this daemon');
  }

  if (expected.predecessor.length === 0) {
    unlinkSync(ownerFilePath(dataDir));
    fsyncDirectory(dataDir);
    return;
  }

  replaceOwnerRecordAtomically(
    dataDir,
    ReleasedOwnerRecordSchema.parse({
      state: 'released',
      predecessor: expected.predecessor,
    }),
  );
};

export interface AcquireRuntimeLockOptions {
  readonly dataDir: string;
  readonly socketPath: string;
  readonly daemonEpoch: string;
  readonly onLost: (error: RuntimeLockError) => void;
}

export class RuntimeLock {
  private readonly dataDir: string;
  private readonly child: ChildProcess;
  private readonly onLost: (error: RuntimeLockError) => void;
  private readonly closePromise: Promise<void>;
  private lost = false;
  private releasing = false;
  private releasePromise: Promise<void> | undefined;
  private currentOwner: OwnerRecord;

  constructor(
    dataDir: string,
    child: ChildProcess,
    owner: OwnerRecord,
    predecessor: readonly OwnerIdentity[],
    onLost: (error: RuntimeLockError) => void,
  ) {
    this.dataDir = dataDir;
    this.child = child;
    this.currentOwner = { ...owner, predecessor: [...predecessor] };
    this.onLost = onLost;
    let handledClose = false;
    let resolveClose!: () => void;
    this.closePromise = new Promise((resolvePromise) => {
      resolveClose = resolvePromise;
    });
    const handleClose = (): void => {
      if (handledClose) {
        return;
      }
      handledClose = true;
      resolveClose();
      if (!this.releasing) {
        this.lost = true;
        this.onLost(new RuntimeLockError('Kernel runtime lock was lost'));
      }
    };
    child.once('close', handleClose);
    if (child.exitCode !== null || child.signalCode !== null) {
      queueMicrotask(handleClose);
    }
  }

  get owner(): OwnerRecord {
    return this.currentOwner;
  }

  get predecessor(): readonly OwnerIdentity[] {
    return this.currentOwner.predecessor;
  }

  get helperPid(): number {
    if (this.child.pid === undefined) {
      throw new RuntimeLockError('Kernel runtime lock helper has no process id');
    }
    return this.child.pid;
  }

  assertHeld(): void {
    if (
      this.lost ||
      this.releasing ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    ) {
      throw new RuntimeLockError('Kernel runtime lock is not held');
    }

    const current = readOwnerRecord(this.dataDir);
    if (!ownerRecordsMatch(current, this.currentOwner)) {
      throw new RuntimeLockError('Runtime owner metadata changed unexpectedly');
    }
  }

  assertPredecessorStaleForSocket(socketPath: string): OwnerIdentity {
    this.assertHeld();
    const resolvedSocketPath = resolve(socketPath);
    let responsibleOwner: OwnerIdentity | undefined;

    for (let index = this.currentOwner.predecessor.length - 1; index >= 0; index -= 1) {
      const predecessor = this.currentOwner.predecessor[index];
      if (predecessor && resolve(predecessor.socketPath) === resolvedSocketPath) {
        responsibleOwner = predecessor;
        break;
      }
    }

    if (!responsibleOwner) {
      throw new RuntimeLockError('No predecessor owns the pre-existing socket path');
    }

    const processState = probeProcess(responsibleOwner);
    if (processState === 'live') {
      throw new RuntimeLockError('Socket predecessor is still live');
    }
    if (processState === 'ambiguous') {
      throw new RuntimeLockError('Socket predecessor liveness is ambiguous');
    }

    this.assertHeld();
    return responsibleOwner;
  }

  markPredecessorResolved(socketPath: string): void {
    const resolvedSocketPath = resolve(socketPath);
    const remainingPredecessor = this.currentOwner.predecessor.filter(
      (owner) => resolve(owner.socketPath) !== resolvedSocketPath,
    );

    if (remainingPredecessor.length === this.currentOwner.predecessor.length) {
      return;
    }

    this.assertHeld();
    const updatedOwner = OwnerRecordSchema.parse({
      ...this.currentOwner,
      predecessor: remainingPredecessor,
    });
    replaceOwnerRecordAtomically(this.dataDir, updatedOwner);
    this.currentOwner = updatedOwner;
    this.assertHeld();
  }

  async release(): Promise<void> {
    this.releasePromise ??= this.performRelease();
    await this.releasePromise;
  }

  private async performRelease(): Promise<void> {
    this.releasing = true;
    let metadataError: unknown;

    if (
      !this.lost &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      try {
        releaseOwnOwnerRecord(this.dataDir, this.currentOwner);
      } catch (error) {
        metadataError = error;
      }
    }

    this.child.stdin?.end();

    let helperReleaseError: unknown;
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          this.child.kill('SIGKILL');
          rejectPromise(new RuntimeLockError('Timed out releasing runtime lock'));
        }, LOCK_RELEASE_TIMEOUT_MS);
        this.closePromise.then(() => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    } catch (error) {
      helperReleaseError = error;
    }

    if (metadataError && helperReleaseError) {
      throw new AggregateError(
        [metadataError, helperReleaseError],
        'Runtime lock metadata and helper release both failed',
      );
    }
    if (metadataError) {
      throw metadataError;
    }
    if (helperReleaseError) {
      throw helperReleaseError;
    }
  }
}

export const acquireRuntimeLock = async (
  options: AcquireRuntimeLockOptions,
): Promise<RuntimeLock> => {
  const dataDir = ensureOwnedDirectory(options.dataDir);
  const lockPath = ensureLockFile(dataDir);
  const requestedOwner = OwnerRecordSchema.parse({
    state: 'active',
    pid: process.pid,
    processStartIdentity: getProcessStartIdentity(process.pid),
    daemonEpoch: options.daemonEpoch,
    socketPath: resolve(options.socketPath),
    predecessor: [],
  });
  const child = spawnLockHelper(lockPath, dataDir, requestedOwner);
  const ack = await waitForLockAck(child, requestedOwner.daemonEpoch);
  const lock = new RuntimeLock(
    dataDir,
    child,
    requestedOwner,
    ack.predecessor,
    options.onLost,
  );
  lock.assertHeld();
  return lock;
};

const runLockHelper = async (dataDirInput: string, encodedOwner: string): Promise<void> => {
  const dataDir = ensureOwnedDirectory(dataDirInput);
  const requestedOwner = decodeOwnerRecord(encodedOwner);
  cleanOwnerTempFiles(dataDir);
  if (readdirSync(dataDir).some((entry) => LEGACY_OWNER_PATTERN.test(entry))) {
    throw new RuntimeLockError('Unexpected runtime owner files are present');
  }

  let predecessor: OwnerIdentity[] = [];
  if (pathExistsNoFollow(ownerFilePath(dataDir))) {
    const persistedOwner = readOwnerRecord(dataDir);
    if (persistedOwner.state === 'released') {
      predecessor = [...persistedOwner.predecessor];
    } else {
      const processState = probeProcess(persistedOwner);

      if (processState === 'live') {
        throw new SingleInstanceError();
      }
      if (processState === 'ambiguous') {
        throw new RuntimeLockError('Runtime owner liveness is ambiguous');
      }

      predecessor = [
        ...persistedOwner.predecessor,
        stripPredecessor(persistedOwner),
      ];
    }
  }

  if (predecessor.length > MAX_PREDECESSORS) {
    throw new RuntimeLockError('Runtime predecessor evidence exceeds its bound');
  }

  const publishedOwner = OwnerRecordSchema.parse({
    ...requestedOwner,
    predecessor,
  });
  replaceOwnerRecordAtomically(dataDir, publishedOwner);
  const ack: LockAck = {
    event: 'LOCKED',
    daemonEpoch: publishedOwner.daemonEpoch,
    predecessor,
  };
  writeAll(1, Buffer.from(`${JSON.stringify(ack)}\n`, 'utf8'));

  await new Promise<void>((resolvePromise) => {
    process.stdin.resume();
    process.stdin.once('end', resolvePromise);
    process.stdin.once('close', resolvePromise);
  });
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution && process.argv[2] === '--lock-helper') {
  const dataDir = process.argv[3];
  const encodedOwner = process.argv[4];

  if (!dataDir || !encodedOwner) {
    writeSync(2, 'LOCK_HELPER_INVALID_INPUT\n');
    process.exitCode = 64;
  } else {
    void runLockHelper(dataDir, encodedOwner).catch((error: unknown) => {
      writeSync(
        2,
        error instanceof SingleInstanceError
          ? 'OWNER_STILL_LIVE\n'
          : 'LOCK_HELPER_FAILED\n',
      );
      process.exitCode = error instanceof SingleInstanceError ? 75 : 70;
    });
  }
}
