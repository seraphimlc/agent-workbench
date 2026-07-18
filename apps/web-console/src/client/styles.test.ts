import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const styles = readFileSync(
  resolve(process.cwd(), 'apps/web-console/src/client/styles.css'),
  'utf8',
);

it('keeps the workspace grid column shrinkable below its content width', () => {
  const workspaceRule = styles.match(/\.workspace-main\s*\{(?<body>[^}]*)\}/s);

  expect(workspaceRule?.groups?.body).toMatch(
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
  );
});
