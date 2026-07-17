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

it('uses a full-width Session drawer at 390px without horizontal overflow', () => {
  expect(styles).toMatch(
    /@media \(max-width: 479px\)[\s\S]*\.session-drawer\s*\{[^}]*width:\s*100vw/s,
  );
  expect(styles).toMatch(/\.session-drawer\s*\{[^}]*max-width:\s*100vw/s);
});

const ruleBody = (source: string, selector: string, offset = 0): string => {
  const selectorIndex = source.indexOf(selector, offset);
  const openBrace = source.indexOf('{', selectorIndex);
  let depth = 1;
  let index = openBrace + 1;
  while (depth > 0 && index < source.length) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    index += 1;
  }
  return source.slice(openBrace + 1, index - 1);
};

it('places the four mobile top-bar items in one explicit grid row', () => {
  const mobileOffset = styles.indexOf('@media (max-width: 819px)');
  const navigationRule = ruleBody(styles, '.navigation-rail {', mobileOffset);
  const columns = navigationRule
    .match(/grid-template-columns:\s*([^;]+);/)?.[1]
    ?.trim()
    .replace(/\s+/g, ' ');

  expect(columns).toBe('minmax(0, 1fr) auto auto auto');
  expect(navigationRule).toMatch(/min-height:\s*64px;/);
  expect(navigationRule).not.toMatch(/grid-template-rows/);
});
