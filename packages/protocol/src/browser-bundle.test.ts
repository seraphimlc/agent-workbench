import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

it('bundles shared protocol schemas for a browser without Node built-ins', () => {
  const temporaryDirectory = mkdtempSync(join(packageDirectory, '.browser-bundle-'));
  const entryPath = join(temporaryDirectory, 'entry.ts');
  const outputPath = join(temporaryDirectory, 'bundle.js');

  try {
    writeFileSync(
      entryPath,
      [
        "import { RpcEnvelopeSchema } from '@agent-workbench/protocol';",
        'globalThis.protocolBrowserSmoke = RpcEnvelopeSchema.safeParse({}).success;',
      ].join('\n'),
    );

    const bundle = spawnSync(
      'pnpm',
      [
        'exec',
        'esbuild',
        entryPath,
        '--bundle',
        '--platform=browser',
        '--format=esm',
        '--conditions=development',
        `--outfile=${outputPath}`,
      ],
      {
        cwd: packageDirectory,
        encoding: 'utf8',
      },
    );

    expect(bundle.status, `${bundle.stdout}${bundle.stderr}`).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).not.toContain('node:util');
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
