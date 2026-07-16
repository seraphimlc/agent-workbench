import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

type WorkspaceReadHandler = (input: {
  readonly toolRunId: string;
  readonly toolId: string;
  readonly input: unknown;
}) => Promise<{ readonly content: string }>;

type WorkspaceReadToolModule = {
  createWorkspaceReadHandler(options: {
    readonly workspacePath: string;
    readonly controlPlanePaths: readonly string[];
    readonly hooks?: {
      readonly afterOpen?: () => void | Promise<void>;
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
    await writeFile(join(fixture.workspacePath, 'README.md'), '# Workspace\n');
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    await expect(executeRead(handler, { path: 'README.md' })).resolves.toEqual({
      content: '# Workspace\n',
    });
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
    await writeFile(join(fixture.workspacePath, 'large.txt'), Buffer.alloc(MAX_BYTES + 1, 0x61));
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
    });

    await expectCode(executeRead(handler, { path: 'large.txt' }), 'WORKSPACE_FILE_TOO_LARGE');
  });

  it('rejects malformed UTF-8', async () => {
    const { createWorkspaceReadHandler } = await loadWorkspaceReadTool();
    const fixture = await createFixture();
    await writeFile(join(fixture.workspacePath, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
    const handler = createWorkspaceReadHandler({
      workspacePath: fixture.workspacePath,
      controlPlanePaths: [fixture.controlPlanePath],
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
