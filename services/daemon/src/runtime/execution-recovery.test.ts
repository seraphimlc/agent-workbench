import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openRuntimeDatabase } from '../db/database.js';
import { ExecutionRecovery } from './execution-recovery.js';
import { Scheduler } from './scheduler.js';
import { SessionService } from './session-service.js';

const NOW = '2026-07-15T02:00:00.000Z';

type TempRuntime = {
  readonly rootDir: string;
  readonly dataDir: string;
  cleanup(): void;
};

const createTempRuntime = (): TempRuntime => {
  const rootDir = mkdtempSync(join(tmpdir(), 'awb-execution-recovery-'));
  const dataDir = join(rootDir, 'data');
  chmodSync(rootDir, 0o700);
  mkdirSync(dataDir, { mode: 0o700 });
  return {
    rootDir,
    dataDir,
    cleanup: () => rmSync(rootDir, { force: true, recursive: true }),
  };
};

const seedActiveExecution = async (
  runtime: TempRuntime,
): Promise<{
  readonly database: Database.Database;
  readonly sessionId: string;
  readonly turnId: string;
}> => {
  const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
  const sessions = new SessionService(database);
  const workspacePath = join(runtime.rootDir, 'workspace');
  mkdirSync(workspacePath);
  const workspace = sessions.registerWorkspace(
    { path: workspacePath },
    'execution-recovery-workspace',
  );
  const created = sessions.createSession(
    {
      workspaceId: workspace.workspaceId,
      title: 'Execution recovery',
      prompt: 'Recover this execution',
    },
    'execution-recovery-session',
  );
  const claim = new Scheduler(database, {
    daemonEpoch: '018f0000-0000-7000-8000-000000002000',
    now: () => new Date(NOW),
    createId: (() => {
      let next = 0;
      return () => `recovery-claim-${String(++next)}`;
    })(),
  }).claimNext();
  if (!claim) {
    throw new Error('Fixture Turn was not claimed');
  }
  database
    .prepare(
      `INSERT INTO model_calls (
        id, session_id, turn_id, ordinal, kind, status,
        profile_snapshot_json, input_json, result_json,
        successful_attempt_id, error_code, error_message,
        created_at, started_at, finished_at
      ) VALUES ('recovery-call', ?, ?, 1, 'craft', 'running', '{}', '{}',
        NULL, NULL, NULL, NULL, ?, ?, NULL)`,
    )
    .run(created.sessionId, created.turnId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO model_attempts (
        id, model_call_id, attempt, status, provider_request_id,
        partial_output_json, result_json, finish_reason,
        input_tokens, output_tokens, cached_tokens, latency_ms,
        error_code, error_message, retryable, started_at, finished_at
      ) VALUES ('recovery-attempt', 'recovery-call', 1, 'running', NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
    )
    .run(NOW);
  return { database, sessionId: created.sessionId, turnId: created.turnId };
};

describe('ExecutionRecovery transaction participation', () => {
  let runtime: TempRuntime | undefined;

  afterEach(() => {
    runtime?.cleanup();
    runtime = undefined;
  });

  it('refuses to close child execution rows outside a caller-owned transaction', async () => {
    runtime = createTempRuntime();
    const fixture = await seedActiveExecution(runtime);
    const recovery = new ExecutionRecovery(fixture.database);

    try {
      expect(() =>
        recovery.fail({
          sessionId: fixture.sessionId,
          turnId: fixture.turnId,
          errorCode: 'RUNNER_START_FAILED',
          errorMessage: 'Runner failed to start',
          now: NOW,
        }),
      ).toThrow(/caller-owned transaction/i);
      expect(
        fixture.database.prepare('SELECT status FROM model_calls').all(),
      ).toEqual([{ status: 'running' }]);
      expect(
        fixture.database.prepare('SELECT status FROM model_attempts').all(),
      ).toEqual([{ status: 'running' }]);
    } finally {
      fixture.database.close();
    }
  });

  it('lets the caller roll back every child transition and returned Event draft', async () => {
    runtime = createTempRuntime();
    const fixture = await seedActiveExecution(runtime);
    const recovery = new ExecutionRecovery(fixture.database);
    const injected = new Error('rollback after recovery participant');
    const transaction = fixture.database.transaction(() => {
      const events = recovery.fail({
        sessionId: fixture.sessionId,
        turnId: fixture.turnId,
        errorCode: 'RUNNER_START_FAILED',
        errorMessage: 'Runner failed to start',
        now: NOW,
      });
      expect(events.map((event) => event.type)).toEqual([
        'model.attempt_failed',
        'model.failed',
      ]);
      throw injected;
    });

    try {
      expect(() => transaction.immediate()).toThrow(injected);
      expect(
        fixture.database.prepare('SELECT status, finished_at FROM model_calls').all(),
      ).toEqual([{ status: 'running', finished_at: null }]);
      expect(
        fixture.database.prepare('SELECT status, finished_at FROM model_attempts').all(),
      ).toEqual([{ status: 'running', finished_at: null }]);
      expect(
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM session_events WHERE type LIKE 'model.%failed'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    {
      name: 'a running ModelAttempt under a terminal ModelCall',
      corrupt: (database: Database.Database, fixture: Awaited<ReturnType<typeof seedActiveExecution>>) => {
        database
          .prepare(
            "UPDATE model_calls SET status = 'failed', finished_at = ? WHERE id = 'recovery-call' AND turn_id = ?",
          )
          .run(NOW, fixture.turnId);
      },
    },
    {
      name: 'a running ModelAttempt under a ModelCall for another Session',
      corrupt: (database: Database.Database, fixture: Awaited<ReturnType<typeof seedActiveExecution>>) => {
        const workspace = database
          .prepare('SELECT workspace_id AS workspaceId FROM sessions WHERE id = ?')
          .get(fixture.sessionId) as { readonly workspaceId: string };
        const foreign = new SessionService(database).createSession(
          {
            workspaceId: workspace.workspaceId,
            title: 'Foreign execution ownership',
            prompt: 'Foreign prompt',
          },
          'foreign-execution-ownership',
        );
        database
          .prepare("UPDATE model_calls SET session_id = ? WHERE id = 'recovery-call'")
          .run(foreign.sessionId);
      },
    },
  ])('rejects $name without changing persisted subexecutions', async ({ corrupt }) => {
    runtime = createTempRuntime();
    const fixture = await seedActiveExecution(runtime);
    const recovery = new ExecutionRecovery(fixture.database);
    corrupt(fixture.database, fixture);
    const before = JSON.stringify({
      calls: fixture.database.prepare('SELECT * FROM model_calls ORDER BY id').all(),
      attempts: fixture.database.prepare('SELECT * FROM model_attempts ORDER BY id').all(),
      tools: fixture.database.prepare('SELECT * FROM tool_runs ORDER BY id').all(),
    });
    const validate = fixture.database.transaction(() =>
      recovery.assertSubexecutionsValid(fixture.sessionId, fixture.turnId),
    );

    try {
      expect(() => validate.immediate()).toThrow(/invariant/i);
      expect(
        JSON.stringify({
          calls: fixture.database.prepare('SELECT * FROM model_calls ORDER BY id').all(),
          attempts: fixture.database.prepare('SELECT * FROM model_attempts ORDER BY id').all(),
          tools: fixture.database.prepare('SELECT * FROM tool_runs ORDER BY id').all(),
        }),
      ).toBe(before);
    } finally {
      fixture.database.close();
    }
  });
});
