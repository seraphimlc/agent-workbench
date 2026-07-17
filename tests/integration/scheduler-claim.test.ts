import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  configureDatabase,
  openRuntimeDatabase,
} from '../../services/daemon/src/db/database.js';
import { Scheduler } from '../../services/daemon/src/runtime/scheduler.js';
import { SessionService } from '../../services/daemon/src/runtime/session-service.js';
import {
  createTempRuntime,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';

const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

const DAEMON_EPOCH = '018f0000-0000-7000-8000-000000000100';
const OTHER_DAEMON_EPOCH = '018f0000-0000-7000-8000-000000000200';
const NOW = '2026-07-14T08:00:00.000Z';
const LEASE_EXPIRES_AT = '2026-07-14T08:00:20.000Z';
const MAX_CONTENDER_OUTPUT_BYTES = 64 * 1024;
const claimContenderEntryPoint = fileURLToPath(
  new URL('../fixtures/scheduler-claim-contender.ts', import.meta.url),
);

type RuntimeDatabase = import('better-sqlite3').Database;

type CreatedSession = {
  readonly sessionId: string;
  readonly turnId: string;
};

const createSession = (
  runtime: TempRuntime,
  service: SessionService,
  suffix: string,
): CreatedSession => {
  const workspacePath = join(runtime.rootDir, `workspace-${suffix}`);
  mkdirSync(workspacePath);
  const workspace = service.registerWorkspace(
    { path: workspacePath },
    `workspace-${suffix}`,
  );
  return service.createSession(
    {
      workspaceId: workspace.workspaceId,
      title: `Session ${suffix}`,
      prompt: `Prompt ${suffix}-1`,
    },
    `session-${suffix}`,
  );
};

const createIdFactory = (...ids: string[]): (() => string) => {
  const pending = [...ids];
  return () => {
    const id = pending.shift();
    if (!id) {
      throw new Error('Test id factory exhausted');
    }
    return id;
  };
};

const createScheduler = (
  database: RuntimeDatabase,
  daemonEpoch = DAEMON_EPOCH,
  ids: readonly string[] = [
    '018f0000-0000-7000-8000-000000000101',
    '018f0000-0000-7000-8000-000000000102',
  ],
): Scheduler =>
  new Scheduler(database, {
    daemonEpoch,
    now: () => new Date(NOW),
    createId: createIdFactory(...ids),
  });

const captureFacts = (database: RuntimeDatabase): string =>
  JSON.stringify({
    sessions: database.prepare('SELECT * FROM sessions ORDER BY id').all(),
    messages: database.prepare('SELECT * FROM messages ORDER BY id').all(),
    turns: database.prepare('SELECT * FROM turns ORDER BY id').all(),
    events: database
      .prepare('SELECT * FROM session_events ORDER BY session_id, seq')
      .all(),
    slots: database.prepare('SELECT * FROM scheduler_slots ORDER BY slot_no').all(),
    leases: database.prepare('SELECT * FROM runner_leases ORDER BY id').all(),
  });

type ClaimContender = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly result: Promise<unknown>;
};

const spawnClaimContender = (
  databasePath: string,
  daemonEpoch: string,
): ClaimContender => {
  const child = spawn(
    process.execPath,
    [
      '--conditions=development',
      '--import',
      'tsx',
      claimContenderEntryPoint,
      databasePath,
      daemonEpoch,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  let becameReady = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  void ready.catch(() => undefined);
  const appendBoundedOutput = (current: string, chunk: string): string => {
    const next = current + chunk;
    if (Buffer.byteLength(next, 'utf8') > MAX_CONTENDER_OUTPUT_BYTES) {
      const error = new Error('Scheduler contender output exceeded its bound');
      rejectReady(error);
      child.kill('SIGKILL');
      return current;
    }
    return next;
  };
  child.stdout.on('data', (chunk: string) => {
    stdout = appendBoundedOutput(stdout, chunk);
    if (!becameReady && stdout.includes('"event":"contender_ready"')) {
      becameReady = true;
      resolveReady();
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr = appendBoundedOutput(stderr, chunk);
  });
  child.once('error', rejectReady);
  child.once('close', (code, signal) => {
    if (!becameReady) {
      rejectReady(
        new Error(
          `Scheduler contender exited before ready: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
        ),
      );
    }
  });
  const result = (async (): Promise<unknown> => {
    const [code, signal] = (await once(child, 'close')) as [
      number | null,
      NodeJS.Signals | null,
    ];
    if (code !== 0 || signal !== null) {
      throw new Error(
        `Scheduler contender failed: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
      );
    }
    const resultLine = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { readonly event?: string; readonly claim?: unknown })
      .find((event) => event.event === 'claim_result');
    if (!resultLine) {
      throw new Error('Scheduler contender did not publish a claim result');
    }
    return resultLine.claim;
  })();
  void result.catch(() => undefined);
  return { child, ready, result };
};

describe('two-slot Scheduler claim', () => {
  let runtime: TempRuntime | undefined;
  let database: RuntimeDatabase | undefined;

  afterEach(async () => {
    database?.close();
    database = undefined;
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('claims only the first queued Turn and writes the exact active tuple once', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    const created = createSession(runtime, service, 'exact');
    const second = service.enqueueTurn(
      { sessionId: created.sessionId, prompt: 'Prompt exact-2' },
      'enqueue-exact-2',
    );
    const beforeSession = database
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(created.sessionId) as Record<string, unknown>;
    const beforeFirstTurn = database
      .prepare('SELECT * FROM turns WHERE id = ?')
      .get(created.turnId) as Record<string, unknown>;
    const beforeSecondTurn = database
      .prepare('SELECT * FROM turns WHERE id = ?')
      .get(second.turnId) as Record<string, unknown>;
    const beforeMessages = database
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
      .all(created.sessionId);
    const leaseId = '018f0000-0000-7000-8000-000000000111';
    const eventId = '018f0000-0000-7000-8000-000000000112';
    const scheduler = createScheduler(database, DAEMON_EPOCH, [leaseId, eventId]);

    expect(scheduler.claimNext()).toEqual({
      slotNo: 1,
      sessionId: created.sessionId,
      turnId: created.turnId,
      leaseId,
      daemonEpoch: DAEMON_EPOCH,
      leaseEpoch: 1,
      executionFence: 1,
    });

    expect(
      database.prepare('SELECT * FROM turns WHERE id = ?').get(created.turnId),
    ).toEqual({
      ...beforeFirstTurn,
      status: 'running',
      started_at: NOW,
      execution_fence: Number(beforeFirstTurn.execution_fence) + 1,
    });
    expect(
      database.prepare('SELECT * FROM turns WHERE id = ?').get(second.turnId),
    ).toEqual(beforeSecondTurn);
    expect(
      database.prepare('SELECT * FROM sessions WHERE id = ?').get(created.sessionId),
    ).toEqual({
      ...beforeSession,
      current_turn_id: created.turnId,
      runtime_status: 'running',
      next_event_seq: Number(beforeSession.next_event_seq) + 1,
      revision: Number(beforeSession.revision) + 1,
      updated_at: NOW,
    });
    expect(database.prepare('SELECT * FROM scheduler_slots ORDER BY slot_no').all()).toEqual([
      {
        slot_no: 1,
        state: 'owned',
        owner_turn_id: created.turnId,
        updated_at: NOW,
      },
      {
        slot_no: 2,
        state: 'free',
        owner_turn_id: null,
        updated_at: expect.any(String),
      },
    ]);
    expect(database.prepare('SELECT * FROM runner_leases').all()).toEqual([
      {
        id: leaseId,
        daemon_epoch: DAEMON_EPOCH,
        lease_epoch: 1,
        session_id: created.sessionId,
        current_turn_id: created.turnId,
        status: 'active',
        heartbeat_at: NOW,
        lease_expires_at: LEASE_EXPIRES_AT,
        runner_instance_id: null,
        pid: null,
        process_start_identity: null,
      },
    ]);
    expect(
      database
        .prepare('SELECT * FROM session_events WHERE id = ?')
        .get(eventId),
    ).toEqual({
      id: eventId,
      session_id: created.sessionId,
      turn_id: created.turnId,
      tool_run_id: null,
      seq: beforeSession.next_event_seq,
      type: 'turn.started',
      actor: 'daemon',
      audience: 'both',
      payload_json: JSON.stringify({
        ordinal: 1,
        queueKind: 'normal',
        slotNo: 1,
      }),
      blob_id: null,
      created_at: NOW,
    });
    expect(
      database
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
        .all(created.sessionId),
    ).toEqual(beforeMessages);

    const afterFirstClaim = captureFacts(database);
    expect(scheduler.claimNext()).toBeNull();
    expect(captureFacts(database)).toBe(afterFirstClaim);
    expect(
      database.prepare('SELECT status FROM turns WHERE id = ?').get(second.turnId),
    ).toEqual({ status: 'queued' });
    expect(database.pragma('foreign_key_check')).toEqual([]);
  });

  it('claims two different Session heads in slots 1 and 2 and leaves a third queued', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    const firstSession = createSession(runtime, service, 'two-slot-first');
    const secondSession = createSession(runtime, service, 'two-slot-second');
    const thirdSession = createSession(runtime, service, 'two-slot-third');
    database
      .prepare('UPDATE turns SET queued_at = ? WHERE id = ?')
      .run('2026-07-14T07:00:00.000Z', firstSession.turnId);
    database
      .prepare('UPDATE turns SET queued_at = ? WHERE id = ?')
      .run('2026-07-14T07:01:00.000Z', secondSession.turnId);
    database
      .prepare('UPDATE turns SET queued_at = ? WHERE id = ?')
      .run('2026-07-14T07:02:00.000Z', thirdSession.turnId);
    const scheduler = createScheduler(database, DAEMON_EPOCH, [
      '018f0000-0000-7000-8000-000000000131',
      '018f0000-0000-7000-8000-000000000132',
      '018f0000-0000-7000-8000-000000000133',
      '018f0000-0000-7000-8000-000000000134',
    ]);

    const first = scheduler.claimNext();
    const second = scheduler.claimNext();
    const third = scheduler.claimNext();

    expect([first?.slotNo, second?.slotNo]).toEqual([1, 2]);
    expect(new Set([first?.sessionId, second?.sessionId]).size).toBe(2);
    expect([first?.sessionId, second?.sessionId]).toEqual(
      expect.arrayContaining([firstSession.sessionId, secondSession.sessionId]),
    );
    expect(third).toBeNull();
    expect(
      database
        .prepare(
          `SELECT status, started_at AS startedAt, execution_fence AS executionFence
           FROM turns WHERE id = ?`,
        )
        .get(thirdSession.turnId),
    ).toEqual({ status: 'queued', startedAt: null, executionFence: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM runner_leases WHERE status = 'active' AND current_turn_id = ?")
        .get(thirdSession.turnId),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM session_events WHERE turn_id = ? AND type = 'turn.started'")
        .get(thirdSession.turnId),
    ).toEqual({ count: 0 });
  });

  it('does not let a canceled ordinal block a later queued Session head', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    const created = createSession(runtime, service, 'canceled-head');
    const later = service.enqueueTurn(
      { sessionId: created.sessionId, prompt: 'Later prompt' },
      'enqueue-canceled-head-2',
    );
    database
      .prepare("UPDATE turns SET status = 'canceled', finished_at = ? WHERE id = ?")
      .run(NOW, created.turnId);

    expect(createScheduler(database).claimNext()?.turnId).toBe(later.turnId);
  });

  it.each([
    {
      name: 'an active Lease is missing',
      corrupt: (database: RuntimeDatabase, first: NonNullable<ReturnType<Scheduler['claimNext']>>) => {
        database.prepare('DELETE FROM runner_leases WHERE id = ?').run(first.leaseId);
      },
    },
    {
      name: 'an active Session is duplicated',
      corrupt: (database: RuntimeDatabase, first: NonNullable<ReturnType<Scheduler['claimNext']>>) => {
        const otherOwnedSession = database
          .prepare(
            `SELECT session_id AS sessionId
             FROM turns WHERE id IN (
               SELECT owner_turn_id FROM scheduler_slots WHERE state = 'owned'
             ) AND session_id != ? LIMIT 1`,
          )
          .get(first.sessionId) as { readonly sessionId: string };
        database
          .prepare(
            `UPDATE sessions
             SET current_turn_id = ?, runtime_status = 'running'
             WHERE id NOT IN (?, ?)
             LIMIT 1`,
          )
          .run(first.turnId, first.sessionId, otherOwnedSession.sessionId);
      },
    },
    {
      name: 'an active Lease cross-links another Session',
      corrupt: (
        database: RuntimeDatabase,
        first: NonNullable<ReturnType<Scheduler['claimNext']>>,
        second: NonNullable<ReturnType<Scheduler['claimNext']>>,
      ) => {
        database
          .prepare('UPDATE runner_leases SET session_id = ? WHERE id = ?')
          .run(second.sessionId, first.leaseId);
      },
    },
  ])('fails closed before writes when $name', async ({ corrupt }) => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    createSession(runtime, service, 'corrupt-first');
    createSession(runtime, service, 'corrupt-second');
    createSession(runtime, service, 'corrupt-third');
    const scheduler = createScheduler(database, DAEMON_EPOCH, [
      '018f0000-0000-7000-8000-000000000136',
      '018f0000-0000-7000-8000-000000000137',
      '018f0000-0000-7000-8000-000000000138',
      '018f0000-0000-7000-8000-000000000139',
    ]);
    const first = scheduler.claimNext();
    const second = scheduler.claimNext();
    if (!first || !second) {
      throw new Error('Fixture did not establish two active Claims');
    }
    corrupt(database, first, second);
    const before = captureFacts(database);

    expect(() => scheduler.claimNext()).toThrow(/invariant/i);
    expect(captureFacts(database)).toBe(before);
  });

  it('skips a blocked Session and still claims an archived eligible Session', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    const blocked = createSession(runtime, service, 'blocked');
    const eligible = createSession(runtime, service, 'eligible');
    database
      .prepare(
        `UPDATE sessions
         SET runtime_status = 'recovering', queue_block_reason = 'recovery_review'
         WHERE id = ?`,
      )
      .run(blocked.sessionId);
    database
      .prepare("UPDATE sessions SET lifecycle_status = 'archived' WHERE id = ?")
      .run(eligible.sessionId);
    database
      .prepare("UPDATE turns SET queued_at = '2026-07-14T07:00:00.000Z' WHERE id = ?")
      .run(blocked.turnId);
    database
      .prepare("UPDATE turns SET queued_at = '2026-07-14T07:01:00.000Z' WHERE id = ?")
      .run(eligible.turnId);

    const claim = createScheduler(database).claimNext();

    expect(claim?.sessionId).toBe(eligible.sessionId);
    expect(claim?.turnId).toBe(eligible.turnId);
    expect(
      database.prepare('SELECT status FROM turns WHERE id = ?').get(blocked.turnId),
    ).toEqual({ status: 'queued' });
  });

  it('uses only each Session head before deterministic cross-Session ordering', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    const firstSession = createSession(runtime, service, 'head-a');
    const laterInFirst = service.enqueueTurn(
      { sessionId: firstSession.sessionId, prompt: 'Earlier timestamp but later ordinal' },
      'enqueue-head-a-2',
    );
    const secondSession = createSession(runtime, service, 'head-b');
    database
      .prepare('UPDATE turns SET queued_at = ? WHERE id = ?')
      .run('2026-07-14T07:03:00.000Z', firstSession.turnId);
    database
      .prepare('UPDATE turns SET queued_at = ? WHERE id = ?')
      .run('2026-07-14T07:00:00.000Z', laterInFirst.turnId);
    database
      .prepare('UPDATE turns SET queued_at = ? WHERE id = ?')
      .run('2026-07-14T07:01:00.000Z', secondSession.turnId);

    const claim = createScheduler(database).claimNext();

    expect(claim?.turnId).toBe(secondSession.turnId);
    expect(
      database.prepare('SELECT status FROM turns WHERE id = ?').get(laterInFirst.turnId),
    ).toEqual({ status: 'queued' });
  });

  it('does not skip a lower queued non-normal Turn to claim a later normal Turn', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    const created = createSession(runtime, service, 'non-normal-head');
    const later = service.enqueueTurn(
      { sessionId: created.sessionId, prompt: 'Later normal Turn' },
      'enqueue-non-normal-head-2',
    );
    database
      .prepare("UPDATE turns SET queue_kind = 'recovery' WHERE id = ?")
      .run(created.turnId);
    const before = captureFacts(database);

    expect(createScheduler(database).claimNext()).toBeNull();
    expect(captureFacts(database)).toBe(before);
    expect(
      database.prepare('SELECT status FROM turns WHERE id = ?').get(later.turnId),
    ).toEqual({ status: 'queued' });
  });

  it('breaks equal queued timestamps by session id deterministically', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    const left = createSession(runtime, service, 'tie-left');
    const right = createSession(runtime, service, 'tie-right');
    database
      .prepare('UPDATE turns SET queued_at = ? WHERE id IN (?, ?)')
      .run('2026-07-14T07:00:00.000Z', left.turnId, right.turnId);
    const expected = [left, right].sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId),
    )[0] as CreatedSession;

    expect(createScheduler(database).claimNext()?.turnId).toBe(expected.turnId);
  });

  it('increments the lease epoch across active and expired history for this daemon only', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    const created = createSession(runtime, service, 'lease-epoch');
    database
      .prepare(
        `INSERT INTO runner_leases (
          id, daemon_epoch, lease_epoch, session_id, current_turn_id, status,
          heartbeat_at, lease_expires_at
        ) VALUES (?, ?, ?, ?, ?, 'expired', ?, ?)`,
      )
      .run(
        '018f0000-0000-7000-8000-000000000121',
        DAEMON_EPOCH,
        4,
        created.sessionId,
        created.turnId,
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO runner_leases (
          id, daemon_epoch, lease_epoch, session_id, current_turn_id, status,
          heartbeat_at, lease_expires_at
        ) VALUES (?, ?, ?, ?, ?, 'expired', ?, ?)`,
      )
      .run(
        '018f0000-0000-7000-8000-000000000122',
        OTHER_DAEMON_EPOCH,
        99,
        created.sessionId,
        created.turnId,
        NOW,
        NOW,
      );

    expect(createScheduler(database).claimNext()?.leaseEpoch).toBe(5);
  });

  it.each([
    { column: 'started_at', valueSql: `'2026-07-14T06:00:00.000Z'` },
    { column: 'finished_at', valueSql: `'2026-07-14T06:00:00.000Z'` },
    { column: 'error_code', valueSql: `'STALE_ERROR'` },
    { column: 'error_message', valueSql: `'stale error'` },
    { column: 'result_message_id', valueSql: 'input_message_id' },
  ])(
    'fails closed instead of claiming a queued Turn with non-null $column',
    async ({ column, valueSql }) => {
      runtime = createTempRuntime();
      database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
      const service = new SessionService(database);
      const created = createSession(runtime, service, `dirty-${column}`);
      database
        .prepare(`UPDATE turns SET ${column} = ${valueSql} WHERE id = ?`)
        .run(created.turnId);
      const before = captureFacts(database);

      expect(() => createScheduler(database as RuntimeDatabase).claimNext()).toThrow(
        /invariant/i,
      );
      expect(captureFacts(database)).toBe(before);
    },
  );

  it.each([
    {
      operation: 'slot update',
      trigger: `
        CREATE TRIGGER ignore_scheduler_slot_claim
        BEFORE UPDATE OF state ON scheduler_slots
        WHEN NEW.state = 'owned'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
    {
      operation: 'Turn update',
      trigger: `
        CREATE TRIGGER ignore_scheduler_turn_claim
        BEFORE UPDATE OF status ON turns
        WHEN NEW.status = 'running'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
    {
      operation: 'Session update',
      trigger: `
        CREATE TRIGGER ignore_scheduler_session_claim
        BEFORE UPDATE OF current_turn_id ON sessions
        WHEN NEW.runtime_status = 'running'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
    {
      operation: 'Lease insert',
      trigger: `
        CREATE TRIGGER ignore_scheduler_lease_insert
        BEFORE INSERT ON runner_leases
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
    {
      operation: 'Event insert',
      trigger: `
        CREATE TRIGGER ignore_scheduler_event_insert
        BEFORE INSERT ON session_events
        WHEN NEW.type = 'turn.started'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
  ])(
    'rolls back every staged fact when the $operation affects zero rows',
    async ({ operation, trigger }) => {
      runtime = createTempRuntime();
      database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
      const service = new SessionService(database);
      createSession(runtime, service, `cas-${operation.replace(' ', '-')}`);
      database.exec(trigger);
      const before = captureFacts(database);

      expect(() => createScheduler(database as RuntimeDatabase).claimNext()).toThrow(
        /invariant/i,
      );
      expect(captureFacts(database)).toBe(before);
    },
  );

  it('serializes three concurrent default-timeout connections to two distinct winners and one null result', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    createSession(runtime, service, 'three-connections-first');
    createSession(runtime, service, 'three-connections-second');
    createSession(runtime, service, 'three-connections-third');
    database.close();
    database = undefined;
    const databasePath = join(runtime.dataDir, 'runtime.sqlite3');
    const contenders = [
      spawnClaimContender(databasePath, DAEMON_EPOCH),
      spawnClaimContender(databasePath, DAEMON_EPOCH),
      spawnClaimContender(databasePath, DAEMON_EPOCH),
    ];
    try {
      await Promise.all(contenders.map(async (contender) => await contender.ready));
      for (const contender of contenders) {
        contender.child.stdin.end(Buffer.from([1]));
      }
      const results = await Promise.all(
        contenders.map(async (contender) => await contender.result),
      );

      expect(results.filter((result) => result !== null)).toHaveLength(2);
      expect(results.filter((result) => result === null)).toHaveLength(1);
      const claims = results.filter(
        (result): result is { readonly slotNo: number; readonly turnId: string } =>
          result !== null,
      );
      expect(new Set(claims.map((claim) => claim.slotNo))).toEqual(new Set([1, 2]));
      expect(new Set(claims.map((claim) => claim.turnId)).size).toBe(2);
      database = new Database(databasePath);
      configureDatabase(database);
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM runner_leases').get(),
      ).toEqual({ count: 2 });
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM turns WHERE execution_fence = 1',
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM session_events WHERE type = 'turn.started'")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      for (const contender of contenders) {
        contender.child.stdin.destroy();
        if (contender.child.exitCode === null && contender.child.signalCode === null) {
          contender.child.kill('SIGKILL');
        }
      }
      await Promise.allSettled(
        contenders.map(async (contender) => await contender.result),
      );
    }
  }, 10_000);

  it('surfaces SQLITE_BUSY from a zero-timeout contender without writing facts', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    createSession(runtime, service, 'busy');
    const contender = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(contender);
    contender.pragma('busy_timeout = 0');
    const before = captureFacts(database);
    database.exec('BEGIN IMMEDIATE');
    try {
      let failure: unknown;
      try {
        createScheduler(contender).claimNext();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) });
    } finally {
      database.exec('ROLLBACK');
      contender.close();
    }
    expect(captureFacts(database)).toBe(before);
  });

  it('throws on an owned tuple from another epoch and does not reinterpret it as busy', async () => {
    runtime = createTempRuntime();
    database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    const service = new SessionService(database);
    createSession(runtime, service, 'wrong-epoch');
    createScheduler(database, OTHER_DAEMON_EPOCH).claimNext();
    const before = captureFacts(database);

    expect(() => createScheduler(database as RuntimeDatabase).claimNext()).toThrow(
      /invariant/i,
    );
    expect(captureFacts(database)).toBe(before);
  });
});
