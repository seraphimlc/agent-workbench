import { execFile } from 'node:child_process';
import { constants, realpathSync, statSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';

const MAX_BYTES = 256 * 1024;
const LSOF_PATH = '/usr/sbin/lsof';
const LSOF_MAX_OUTPUT_BYTES = 64 * 1024;

export type WorkspaceReadErrorCode =
  | 'WORKSPACE_PATH_INVALID'
  | 'WORKSPACE_PATH_ESCAPE'
  | 'WORKSPACE_FILE_CHANGED'
  | 'WORKSPACE_FILE_TOO_LARGE'
  | 'WORKSPACE_FILE_NOT_UTF8';

export class WorkspaceReadError extends Error {
  readonly code: WorkspaceReadErrorCode;

  constructor(code: WorkspaceReadErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceReadError';
    this.code = code;
  }
}

export type WorkspaceReadHandler = (input: {
  readonly toolRunId: string;
  readonly toolId: string;
  readonly input: unknown;
}) => Promise<{ readonly content: string }>;

export type DescriptorPathResolver = (fd: number) => unknown | Promise<unknown>;

export type WorkspaceReadBoundary = {
  readonly workspacePath: string;
  readonly controlPlanePaths: readonly string[];
  readonly descriptorPathResolver?: DescriptorPathResolver;
  readonly hooks?: {
    readonly afterOpen?: () => void | Promise<void>;
    readonly afterRealpath?: () => void | Promise<void>;
    readonly afterLstat?: () => void | Promise<void>;
  };
};

const codedError = (code: WorkspaceReadErrorCode): WorkspaceReadError => {
  switch (code) {
    case 'WORKSPACE_PATH_INVALID':
      return new WorkspaceReadError(code, 'Workspace path is invalid');
    case 'WORKSPACE_PATH_ESCAPE':
      return new WorkspaceReadError(code, 'Workspace path is outside the allowed boundary');
    case 'WORKSPACE_FILE_CHANGED':
      return new WorkspaceReadError(code, 'Workspace file changed during access');
    case 'WORKSPACE_FILE_TOO_LARGE':
      return new WorkspaceReadError(code, 'Workspace file exceeds the read limit');
    case 'WORKSPACE_FILE_NOT_UTF8':
      return new WorkspaceReadError(code, 'Workspace file is not valid UTF-8');
  }
};

const canonicalizeStartupPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    throw codedError('WORKSPACE_PATH_INVALID');
  }
};

const isWithin = (parentPath: string, candidatePath: string): boolean => {
  const relativePath = relative(parentPath, candidatePath);
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  );
};

const isStrictlyWithin = (parentPath: string, candidatePath: string): boolean =>
  parentPath !== candidatePath && isWithin(parentPath, candidatePath);

const pathsOverlap = (firstPath: string, secondPath: string): boolean =>
  isWithin(firstPath, secondPath) || isWithin(secondPath, firstPath);

const containsParentSegment = (path: string): boolean => path.split(/[\\/]+/).includes('..');

const parseCandidatePath = (input: unknown, workspacePath: string): string => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw codedError('WORKSPACE_PATH_INVALID');
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'path') {
    throw codedError('WORKSPACE_PATH_INVALID');
  }
  const path = (input as { readonly path?: unknown }).path;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\0') ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[a-z]:/i.test(path)
  ) {
    throw codedError('WORKSPACE_PATH_INVALID');
  }
  if (containsParentSegment(path)) {
    throw codedError('WORKSPACE_PATH_ESCAPE');
  }

  const candidatePath = resolve(workspacePath, path);
  if (!isWithin(workspacePath, candidatePath)) {
    throw codedError('WORKSPACE_PATH_ESCAPE');
  }
  return candidatePath;
};

const readAtMost = async (descriptor: FileHandle, limit: number): Promise<Buffer> => {
  const bytes = Buffer.allocUnsafe(limit);
  let offset = 0;
  while (offset < limit) {
    const result = await descriptor.read(bytes, offset, limit - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return bytes.subarray(0, offset);
};

const openNoFollow = async (candidatePath: string): Promise<FileHandle> => {
  try {
    return await open(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw codedError('WORKSPACE_PATH_ESCAPE');
    }
    throw codedError('WORKSPACE_PATH_INVALID');
  }
};

const descriptorResolutionError = (): Error => new Error('Descriptor path resolution failed');

export const parseLsofDescriptorPath = (output: Uint8Array): string => {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch {
    throw descriptorResolutionError();
  }

  const paths = decoded
    .split('\0')
    .filter((field) => field.startsWith('n'))
    .map((field) => field.slice(1));
  const [descriptorPath] = paths;
  if (paths.length !== 1 || descriptorPath === undefined || descriptorPath.length === 0) {
    throw descriptorResolutionError();
  }
  return descriptorPath;
};

const runLsofForDescriptor = async (fd: number): Promise<Uint8Array> =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      LSOF_PATH,
      ['-a', '-p', String(process.pid), '-d', String(fd), '-F0n'],
      {
        encoding: 'buffer',
        maxBuffer: LSOF_MAX_OUTPUT_BYTES,
        shell: false,
      },
      (error, stdout) => {
        if (error || !Buffer.isBuffer(stdout)) {
          rejectPromise(descriptorResolutionError());
          return;
        }
        resolvePromise(stdout);
      },
    );
  });

const resolveDarwinDescriptorPath = async (fd: number): Promise<string> => {
  if (process.platform !== 'darwin') {
    throw descriptorResolutionError();
  }
  return parseLsofDescriptorPath(await runLsofForDescriptor(fd));
};

export const createWorkspaceReadHandler = (boundary: WorkspaceReadBoundary): WorkspaceReadHandler => {
  const workspacePath = canonicalizeStartupPath(boundary.workspacePath);
  const descriptorPathResolver =
    boundary.descriptorPathResolver ?? resolveDarwinDescriptorPath;
  try {
    if (!statSync(workspacePath).isDirectory()) {
      throw codedError('WORKSPACE_PATH_INVALID');
    }
  } catch (error) {
    if (error instanceof WorkspaceReadError) throw error;
    throw codedError('WORKSPACE_PATH_INVALID');
  }

  for (const path of boundary.controlPlanePaths) {
    const controlPlanePath = canonicalizeStartupPath(path);
    if (pathsOverlap(workspacePath, controlPlanePath)) {
      throw codedError('WORKSPACE_PATH_ESCAPE');
    }
  }

  return async ({ input }) => {
    const candidatePath = parseCandidatePath(input, workspacePath);
    const descriptor = await openNoFollow(candidatePath);

    try {
      try {
        await boundary.hooks?.afterOpen?.();
      } catch {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }

      let opened;
      try {
        opened = await descriptor.stat({ bigint: true });
      } catch {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }
      if (!opened.isFile() || opened.nlink !== 1n) {
        throw codedError('WORKSPACE_PATH_INVALID');
      }

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(candidatePath);
      } catch {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }
      if (!isWithin(workspacePath, canonicalPath)) {
        throw codedError('WORKSPACE_PATH_ESCAPE');
      }

      try {
        await boundary.hooks?.afterRealpath?.();
      } catch {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }

      let pathIdentity;
      try {
        pathIdentity = await lstat(candidatePath, { bigint: true });
      } catch {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }
      if (
        !pathIdentity.isFile() ||
        pathIdentity.dev !== opened.dev ||
        pathIdentity.ino !== opened.ino
      ) {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }

      try {
        await boundary.hooks?.afterLstat?.();
      } catch {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }

      let verifiedCanonicalPath: string;
      try {
        verifiedCanonicalPath = await realpath(candidatePath);
      } catch {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }
      if (verifiedCanonicalPath !== canonicalPath || !isWithin(workspacePath, verifiedCanonicalPath)) {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }

      let descriptorPath: unknown;
      try {
        descriptorPath = await descriptorPathResolver(descriptor.fd);
      } catch {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }
      if (
        typeof descriptorPath !== 'string' ||
        descriptorPath.length === 0 ||
        descriptorPath.includes('\0') ||
        !isAbsolute(descriptorPath)
      ) {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }

      let canonicalDescriptorPath: string;
      try {
        canonicalDescriptorPath = await realpath(descriptorPath);
      } catch {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }
      if (
        !isStrictlyWithin(workspacePath, canonicalDescriptorPath) ||
        canonicalDescriptorPath !== verifiedCanonicalPath
      ) {
        throw codedError('WORKSPACE_FILE_CHANGED');
      }

      let bytes: Buffer;
      try {
        bytes = await readAtMost(descriptor, MAX_BYTES + 1);
      } catch {
        throw codedError('WORKSPACE_PATH_INVALID');
      }
      if (bytes.byteLength > MAX_BYTES) {
        throw codedError('WORKSPACE_FILE_TOO_LARGE');
      }

      try {
        return {
          content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        };
      } catch {
        throw codedError('WORKSPACE_FILE_NOT_UTF8');
      }
    } finally {
      await descriptor.close().catch(() => undefined);
    }
  };
};
