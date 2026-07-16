import { link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

type WorkspaceReadHandler = (input: {
  readonly toolRunId: string;
  readonly toolId: string;
  readonly input: unknown;
}) => Promise<{ readonly content: string }>;

type WorkspaceReadToolModule = {
  parseLsofDescriptorPath(output: Uint8Array): string;
  createWorkspaceReadHandler(options: {
    readonly workspacePath: string;
    readonly controlPlanePaths: readonly string[];
    readonly descriptorPathResolver?: (fd: number) => unknown | Promise<unknown>;
    readonly hooks?: {
      readonly afterOpen?: () => void | Promise<void>;
      readonly afterRealpath?: () => void | Promise<void>;
      readonly afterLstat?: () => void | Promise<void>;
      readonly afterDescriptorLstat?: () => void | Promise<void>;
    };
  }): WorkspaceReadHandler;
};

const MODULE_PATH = './workspace-read-tool.js';
const MAX_BYTES = 256 * 1024;
const temporaryPaths: string[] = [];

const loadWorkspaceReadTool = async (): Promise<WorkspaceReadToolModule> =>
  (await import(MODULE_PATH)) as unknown as WorkspaceReadToolModule;

const createFixture = async (): Promise<{
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly controlPlanePath: string;
}> => {
  const rootPath = await mkdtemp(join(tmpdir(), 'agent-workbench-read-tool-'));
  temporaryPaths.push(rootPath);
  const workspacePath = join(rootPath, 'workspace');
  const controlPlanePath = join(rootPath, 'control-plane');
  await mkdir(workspacePath);
  await mkdir(controlPlanePath);
  return { rootPath, workspacePath, controlPlanePath };
};

const executeRead = (
  handler: WorkspaceReadHandler,
  input: unknown,
): Promise<{ readonly content: string }> =>
  handler({
    toolRunId: 'tool-run-1',
    toolId: 'fs.read_text',
    input,
  });

const expectCode = async (operation: Promise<unknown>, code: string): Promise<Error> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return error as Error;
  }
  throw new Error(`Expected operation to reject with ${code}`);
};

const expectSyncCode = (operation: () => unknown, code: string): Error => {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return error as Error;
  }
  throw new Error(`Expected operation to throw ${code}`);
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('createWorkspaceReadHandler', () => {
  it('reads a valid UTF-8 file from the workspace', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const filePath = join(fixture.workspacePath, 'README.md');
    await writeFile(filePath, '# Workspace\n');
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
      descriptorPathResolver: async () => filePath,
    });

    await expect(executeRead(handler, { path: 'README.md' })).resolves.toEqual({
      content: '# Workspace\n',
    });
  });

  it.runIf(process.platform === 'darwin')('uses the Darwin descriptor resolver by default', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    await writeFile(join(fixture.workspacePath, 'README.md'), '# Workspace\n');
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    await expect(executeRead(handler, { path: 'README.md' })).resolves.toEqual({
      content: '# Workspace\n',
    });
  });

  it.runIf(process.platform !== 'darwin')('fails closed without an injected resolver outside Darwin', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    await writeFile(join(fixture.workspacePath, 'README.md'), '# Workspace\n');
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    await expectCode(executeRead(handler, { path: 'README.md' }), 'WORKSPACE_FILE_CHANGED');
  });

  it('parses exactly one NUL-delimited lsof name field', async () => {
    const { parseLsofDescriptorPath } = await loadWorkspaceReadTool();
    const output = new TextEncoder().encode('p123\0\nf9\0n/workspace/README.md\0\n');

    expect(parseLsofDescriptorPath(output)).toBe('/workspace/README.md');
  });

  it.each(['/etc/passwd', String.raw`C:\Windows\system.ini`])(
    'rejects absolute path %s',
    async (path) => {
      const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
      const fixture = await createFixture();
      const handler = createWorkspaceReadHandler({
        workspacePath: fixture.workspacePath,
        controlPlanePaths: [fixture.controlPlanePath],
      });

      await expectCode(executeRead(handler, { path }), 'WORKSPACE_PATH_INVALID');
    },
  );

  it.each([
    {},
    { path: '' },
    { path: 1 },
    { path: 'README.md', extra: true },
  ])('rejects input that is not exactly { path: string }', async (input) => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    await expectCode(executeRead(handler, input), 'WORKSPACE_PATH_INVALID');
  });

  it('rejects parent traversal that escapes the workspace', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    await expectCode(executeRead(handler, { path: '../outside.md' }), 'WORKSPACE_PATH_ESCAPE');
  });

  it('rejects any parent path segment even when normalization stays in the workspace', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    await mkdir(join(fixture.workspacePath, 'dir'));
    await writeFile(join(fixture.workspacePath, 'README.md'), '# Workspace\n');
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    await expectCode(
      executeRead(handler, { path: 'dir/../README.md' }),
      'WORKSPACE_PATH_ESCAPE',
    );
  });

  it('rejects a final-component symlink', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    await writeFile(join(fixture.workspacePath, 'README.md'), 'real file');
    await symlink('README.md', join(fixture.workspacePath, 'linked.md'));
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    await expectCode(executeRead(handler, { path: 'linked.md' }), 'WORKSPACE_PATH_ESCAPE');
  });

  it('rejects an intermediate symlink that escapes the workspace without leaking its target', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const outsidePath = join(fixture.rootPath, 'outside');
    await mkdir(outsidePath);
    await writeFile(join(outsidePath, 'secret.md'), 'outside secret');
    await symlink(outsidePath, join(fixture.workspacePath, 'linked-directory'));
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    const error = await expectCode(
      executeRead(handler, { path: 'linked-directory/secret.md' }),
      'WORKSPACE_PATH_ESCAPE',
    );
    expect(error.message).not.toContain(outsidePath);
  });

  it('rejects a workspace hardlink to a control-plane file', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const controlPlaneFile = join(fixture.controlPlanePath, 'secret.md');
    await writeFile(controlPlaneFile, 'control-plane secret');
    await link(controlPlaneFile, join(fixture.workspacePath, 'linked-secret.md'));
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    const error = await expectCode(
      executeRead(handler, { path: 'linked-secret.md' }),
      'WORKSPACE_PATH_INVALID',
    );
    expect(error.message).not.toContain(fixture.controlPlanePath);
  });

  it('rejects an intermediate symlink switched inside to outside to inside', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const workspaceDirectory = join(fixture.workspacePath, 'workspace-files');
    const workspaceFile = join(workspaceDirectory, 'README.md');
    const linkedDirectory = join(fixture.workspacePath, 'linked-directory');
    const outsideReplacementLink = join(fixture.workspacePath, 'outside-replacement-link');
    const insideReplacementLink = join(fixture.workspacePath, 'inside-replacement-link');
    const outsideFile = join(fixture.controlPlanePath, 'README.md');
    let resolvedDescriptor: number | undefined;
    await mkdir(workspaceDirectory);
    await writeFile(workspaceFile, 'workspace file');
    await symlink(workspaceDirectory, linkedDirectory);
    await symlink(fixture.controlPlanePath, outsideReplacementLink);
    await symlink(workspaceDirectory, insideReplacementLink);
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
      descriptorPathResolver: async (fd) => {
        resolvedDescriptor = fd;
        return outsideFile;
      },
      hooks: {
        afterRealpath: async () => {
          await rename(workspaceFile, outsideFile);
          await rename(outsideReplacementLink, linkedDirectory);
        },
        afterLstat: async () => {
          await rename(outsideFile, workspaceFile);
          await writeFile(outsideFile, 'outside resolver file');
          await rename(insideReplacementLink, linkedDirectory);
        },
      },
    });

    const error = await expectCode(
      executeRead(handler, { path: 'linked-directory/README.md' }),
      'WORKSPACE_FILE_CHANGED',
    );
    expect(resolvedDescriptor).toEqual(expect.any(Number));
    expect(error.message).not.toContain(fixture.controlPlanePath);
  });

  it('rejects a descriptor path replaced with a workspace symlink before realpath', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const workspaceDirectory = join(fixture.workspacePath, 'workspace-files');
    const workspaceFile = join(workspaceDirectory, 'README.md');
    const linkedDirectory = join(fixture.workspacePath, 'linked-directory');
    const outsideReplacementLink = join(fixture.workspacePath, 'outside-replacement-link');
    const insideReplacementLink = join(fixture.workspacePath, 'inside-replacement-link');
    const outsideFile = join(fixture.controlPlanePath, 'README.md');
    const outsideBackup = join(fixture.controlPlanePath, 'opened-backup.md');
    let hookCalls = 0;
    await mkdir(workspaceDirectory);
    await writeFile(workspaceFile, 'opened file');
    await symlink(workspaceDirectory, linkedDirectory);
    await symlink(fixture.controlPlanePath, outsideReplacementLink);
    await symlink(workspaceDirectory, insideReplacementLink);
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
      descriptorPathResolver: async () => outsideFile,
      hooks: {
        afterRealpath: async () => {
          await rename(workspaceFile, outsideFile);
          await rename(outsideReplacementLink, linkedDirectory);
        },
        afterLstat: async () => {
          await writeFile(workspaceFile, 'workspace replacement');
          await rename(insideReplacementLink, linkedDirectory);
        },
        afterDescriptorLstat: async () => {
          hookCalls += 1;
          await rename(outsideFile, outsideBackup);
          await symlink(workspaceFile, outsideFile);
        },
      },
    });

    const error = await expectCode(
      executeRead(handler, { path: 'linked-directory/README.md' }),
      'WORKSPACE_FILE_CHANGED',
    );
    expect(hookCalls).toBe(1);
    expect(error.message).not.toContain(fixture.controlPlanePath);
  });

  it('fails closed when descriptor resolution throws', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const filePath = join(fixture.workspacePath, 'README.md');
    await writeFile(filePath, 'workspace file');
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
      descriptorPathResolver: async () => {
        throw new Error(`resolver exposed ${fixture.controlPlanePath}`);
      },
    });

    const error = await expectCode(
      executeRead(handler, { path: 'README.md' }),
      'WORKSPACE_FILE_CHANGED',
    );
    expect(error.message).not.toContain(fixture.controlPlanePath);
  });

  it('fails closed when lsof reports multiple descriptor paths', async () => {
    const { createWorkspaceReadHandler, parseLsofDescriptorPath } =
      await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const filePath = join(fixture.workspacePath, 'README.md');
    await writeFile(filePath, 'workspace file');
    const output = new TextEncoder().encode(
      `n${filePath}\0n${join(fixture.controlPlanePath, 'README.md')}\0`,
    );
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
      descriptorPathResolver: async () => parseLsofDescriptorPath(output),
    });

    const error = await expectCode(
      executeRead(handler, { path: 'README.md' }),
      'WORKSPACE_FILE_CHANGED',
    );
    expect(error.message).not.toContain(fixture.controlPlanePath);
  });

  it('rejects a path identity swap after opening', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const filePath = join(fixture.workspacePath, 'README.md');
    await writeFile(filePath, 'original');
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
      hooks: {
        afterOpen: async () => {
          await rename(filePath, join(fixture.workspacePath, 'original.md'));
          await writeFile(filePath, 'replacement');
        },
      },
    });

    await expectCode(executeRead(handler, { path: 'README.md' }), 'WORKSPACE_FILE_CHANGED');
  });

  it('rejects directories', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    await expectCode(executeRead(handler, { path: '.' }), 'WORKSPACE_PATH_INVALID');
  });

  it('rejects files larger than 256 KiB', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const filePath = join(fixture.workspacePath, 'large.txt');
    await writeFile(filePath, Buffer.alloc(MAX_BYTES + 1, 0x61));
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
      descriptorPathResolver: async () => filePath,
    });

    await expectCode(executeRead(handler, { path: 'large.txt' }), 'WORKSPACE_FILE_TOO_LARGE');
  });

  it('rejects malformed UTF-8', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    const filePath = join(fixture.workspacePath, 'invalid.txt');
    await writeFile(filePath, Buffer.from([0xc3, 0x28]));
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
      descriptorPathResolver: async () => filePath,
    });

    await expectCode(executeRead(handler, { path: 'invalid.txt' }), 'WORKSPACE_FILE_NOT_UTF8');
  });

  it.each(['equal', 'workspace-contains-control-plane', 'control-plane-contains-workspace'])(
    'rejects %s startup overlap',
    async (relationship) => {
      const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
      const fixture = await createFixture();
      let workspacePath = fixture.workspacePath;
      let controlPlanePath = fixture.controlPlanePath;

      if (relationship === 'equal') {
        controlPlanePath = workspacePath;
      } else if (relationship === 'workspace-contains-control-plane') {
        controlPlanePath = join(workspacePath, 'runtime');
        await mkdir(controlPlanePath);
      } else {
        workspacePath = join(controlPlanePath, 'workspace');
        await mkdir(workspacePath);
      }

      const error = expectSyncCode(
        () => createWorkspaceReadHandler({ workspacePath, controlPlanePaths: [controlPlanePath] }),
        'WORKSPACE_PATH_ESCAPE',
      );
      expect(error.message).not.toContain(workspacePath);
      expect(error.message).not.toContain(controlPlanePath);
    },
  );
});
