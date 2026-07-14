import { fileURLToPath } from 'node:url';

import {
  runRuntimeSmokeCli,
  type RuntimeSmokeDependencies,
} from '../../scripts/runtime-smoke.js';
import { runDaemon } from '../../services/daemon/src/index.js';

const arguments_ = process.argv.slice(2);
const isDaemonInvocation = arguments_.some(
  (argument) => argument === '--socket' || argument.startsWith('--socket='),
);

if (isDaemonInvocation) {
  process.once('beforeExit', () => {
    process.exitCode = 1;
  });
  void runDaemon().catch(() => {
    process.stderr.write(
      `${JSON.stringify({ event: 'startup_error', code: 'DAEMON_STARTUP_FAILED' })}\n`,
    );
    process.exitCode = 1;
  });
} else {
  const entryPoint = fileURLToPath(import.meta.url);
  const dependencies: RuntimeSmokeDependencies = {
    spawnSecondDaemon: (runtime, bootstrapSecret) =>
      runtime.spawnDaemon({ bootstrapSecret, entryPoint }),
  };
  await runRuntimeSmokeCli(arguments_, dependencies);
}
