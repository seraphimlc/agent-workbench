import { closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runDaemon } from '../../services/daemon/src/index.js';

const optionValue = (name: '--data-dir' | '--socket'): string => {
  const argumentIndex = process.argv.indexOf(name);
  const value = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
  if (value === undefined || value.length === 0) {
    throw new Error('Fixture daemon option is missing');
  }
  return value;
};

const dataDir = optionValue('--data-dir');
const fixtureModePrefix = 'fixture-mode-';
const configuredModel = process.env.AGENT_WORKBENCH_PROVIDER_MODEL ?? '';
const mode = configuredModel.startsWith(fixtureModePrefix)
  ? configuredModel.slice(fixtureModePrefix.length)
  : 'ready';
writeFileSync(
  join(dataDir, 'web-console-daemon-launch.json'),
  JSON.stringify({
    pid: process.pid,
    argv: process.argv,
    environment: process.env,
  }),
  { mode: 0o600 },
);

if (mode === 'hang') {
  setInterval(() => undefined, 1_000);
} else if (mode === 'early-exit') {
  closeSync(3);
  const providerKey = process.env.AGENT_WORKBENCH_PROVIDER_API_KEY ?? '';
  process.stderr.write(`${providerKey}:${'failure-output-'.repeat(8_192)}\n`);
  process.exitCode = 17;
} else {
  await runDaemon({ executionDriver: null });
  if (mode === 'duplicate-ready') {
    process.stdout.write(
      `${JSON.stringify({ event: 'ready', protocolVersion: 1, pid: process.pid })}\n`,
    );
  }
  if (mode === 'late-duplicate-ready') {
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({ event: 'ready', protocolVersion: 1, pid: process.pid })}\n`,
      );
    }, 150);
  }
  if (mode === 'late-exit') {
    setTimeout(() => process.exit(23), 150);
  }
  if (mode === 'ignore-sigterm') {
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {
      writeFileSync(join(dataDir, 'sigterm-observed'), 'ignored', { mode: 0o600 });
    });
  }
}
