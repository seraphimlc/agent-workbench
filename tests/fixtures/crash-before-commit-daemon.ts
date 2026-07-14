import { writeSync } from 'node:fs';

import { runDaemon } from '../../services/daemon/src/index.js';

await runDaemon({
  sessionServiceHooks: {
    beforeCommit: ({ method }) => {
      if (method !== 'session.create') {
        return;
      }
      writeSync(
        1,
        `${JSON.stringify({ event: 'before_commit', method })}\n`,
      );
      process.kill(process.pid, 'SIGKILL');
    },
  },
});
