import { join } from 'node:path';

import type Database from 'better-sqlite3';

import {
  initializeRuntimeDatabase,
  type OpenRuntimeDatabaseOptions,
} from '../../services/daemon/src/db/database.js';
import { runDaemon } from '../../services/daemon/src/index.js';

const initializeTestDatabase = async (
  database: Database.Database,
  options: OpenRuntimeDatabaseOptions,
): Promise<void> => {
  await initializeRuntimeDatabase(database, {
    ...options,
    migrationsDirectory: join(options.dataDir, 'test-migrations'),
  });
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.pragma('wal_autocheckpoint = 0');
  database
    .prepare("INSERT INTO wal_fact (value) VALUES ('committed-in-child-wal')")
    .run();
};

await runDaemon({ initializeDatabase: initializeTestDatabase });
