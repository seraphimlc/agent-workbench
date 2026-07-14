import { readSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';

import { configureDatabase } from '../../services/daemon/src/db/database.js';
import { Scheduler } from '../../services/daemon/src/runtime/scheduler.js';

const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

const [databasePath, daemonEpoch] = process.argv.slice(2);
if (!databasePath || !daemonEpoch) {
  throw new Error('Scheduler contender requires a database path and daemon epoch');
}

const database = new Database(databasePath);
configureDatabase(database);
writeSync(1, `${JSON.stringify({ event: 'contender_ready' })}\n`);
const release = Buffer.alloc(1);
if (readSync(0, release, 0, 1, null) !== 1) {
  throw new Error('Scheduler contender release barrier closed');
}

try {
  const claim = new Scheduler(database, { daemonEpoch }).claimNext();
  writeSync(1, `${JSON.stringify({ event: 'claim_result', claim })}\n`);
} finally {
  database.close();
}
