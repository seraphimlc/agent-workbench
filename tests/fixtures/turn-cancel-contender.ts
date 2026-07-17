import { readSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';

import { configureDatabase } from '../../services/daemon/src/db/database.js';
import { SessionService } from '../../services/daemon/src/runtime/session-service.js';

const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

const [databasePath, sessionId, turnId, mode] = process.argv.slice(2);
if (!databasePath || !sessionId || !turnId) {
  throw new Error('Turn cancel contender requires a database path, Session ID, and Turn ID');
}

const database = new Database(databasePath);
configureDatabase(database);
writeSync(1, `${JSON.stringify({ event: 'contender_ready' })}\n`);
const readBarrier = (): void => {
  const release = Buffer.alloc(1);
  if (readSync(0, release, 0, 1, null) !== 1) {
    throw new Error('Turn cancel contender release barrier closed');
  }
};

readBarrier();

try {
  writeSync(1, `${JSON.stringify({ event: 'contender_attempting' })}\n`);
  const result = new SessionService(database, {
    beforeCommit: ({ method }) => {
      if (mode === 'barrier' && method === 'turn.cancel') {
        writeSync(1, `${JSON.stringify({ event: 'contender_locked' })}\n`);
        readBarrier();
      }
    },
  }).cancelTurn(
    { sessionId, turnId },
    'turn-cancel-contender',
  );
  writeSync(1, `${JSON.stringify({ event: 'cancel_result', result: { ok: true, result } })}\n`);
} catch (error) {
  const code =
    typeof error === 'object' && error !== null && 'failure' in error
      ? (error.failure as { readonly code?: unknown }).code
      : undefined;
  if (typeof code !== 'string') {
    throw error;
  }
  writeSync(1, `${JSON.stringify({ event: 'cancel_result', result: { ok: false, code } })}\n`);
} finally {
  database.close();
}
