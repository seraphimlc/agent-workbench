import { readSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';

import { configureDatabase } from '../../services/daemon/src/db/database.js';
import { Scheduler } from '../../services/daemon/src/runtime/scheduler.js';

const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

const [databasePath, daemonEpoch, mode] = process.argv.slice(2);
if (!databasePath || !daemonEpoch) {
  throw new Error('Scheduler contender requires a database path and daemon epoch');
}

const database = new Database(databasePath);
configureDatabase(database);
writeSync(1, `${JSON.stringify({ event: 'contender_ready' })}\n`);
const readBarrier = (): void => {
  const release = Buffer.alloc(1);
  if (readSync(0, release, 0, 1, null) !== 1) {
    throw new Error('Scheduler contender release barrier closed');
  }
};

readBarrier();

try {
  const scheduler = new Scheduler(database, { daemonEpoch });
  if (mode === 'barrier') {
    database.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      writeSync(1, `${JSON.stringify({ event: 'contender_locked' })}\n`);
      readBarrier();
      const claim = (
        scheduler as unknown as { claimWithinTransaction(): unknown }
      ).claimWithinTransaction();
      database.exec('COMMIT');
      committed = true;
      writeSync(1, `${JSON.stringify({ event: 'claim_result', claim })}\n`);
    } finally {
      if (!committed) {
        try {
          database.exec('ROLLBACK');
        } catch (rollbackError) {
          void rollbackError;
        }
      }
    }
  } else {
    writeSync(1, `${JSON.stringify({ event: 'contender_attempting' })}\n`);
    const claim = scheduler.claimNext();
    writeSync(1, `${JSON.stringify({ event: 'claim_result', claim })}\n`);
  }
} finally {
  database.close();
}
