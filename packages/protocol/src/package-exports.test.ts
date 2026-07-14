import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const distDirectory = fileURLToPath(new URL('../dist', import.meta.url));

describe('protocol package exports', () => {
  it('uses TypeScript source in development and built JavaScript in native Node', async () => {
    rmSync(distDirectory, { force: true, recursive: true });

    const developmentProtocol = await import('@agent-workbench/protocol');
    expect(typeof developmentProtocol.RpcEnvelopeSchema.safeParse).toBe('function');

    const build = spawnSync('pnpm', ['build'], {
      cwd: packageDirectory,
      encoding: 'utf8',
    });
    expect(build.status, build.stderr).toBe(0);

    const nativeImport = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const protocol = await import('@agent-workbench/protocol'); process.stdout.write(typeof protocol.RpcEnvelopeSchema?.safeParse);",
      ],
      {
        cwd: packageDirectory,
        encoding: 'utf8',
      },
    );

    expect(nativeImport.status, nativeImport.stderr).toBe(0);
    expect(nativeImport.stdout).toBe('function');
  });
});
