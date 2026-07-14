import { writeSync } from 'node:fs';

import { runDaemon } from '../../services/daemon/src/index.js';

await runDaemon({
  startupRecoveryHooks: {
    beforeCommit: () => {
      writeSync(
        1,
        `${JSON.stringify({ event: 'before_recovery_commit' })}\n`,
      );
      process.kill(process.pid, 'SIGKILL');
    },
  },
});
