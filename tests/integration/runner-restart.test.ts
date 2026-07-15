import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { RunnerBinding } from '../../packages/protocol/src/runner.js';
import { openRuntimeDatabase } from '../../services/daemon/src/db/database.js';
import {
  recoverStartupState,
  type StartupRecoveryOptions,
} from '../../services/daemon/src/runtime/startup-recovery.js';
import { Scheduler, type Claim } from '../../services/daemon/src/runtime/scheduler.js';
import { SessionService } from '../../services/daemon/src/runtime/session-service.js';
import {
  createTempRuntime,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';

type ProcessIdentity = {
  readonly pid: number;
  readonly processStartIdentity: string;
};

type RunnerExecution = {
  readonly identity: ProcessIdentity;
  readonly completion: Promise<unknown>;
  kill(signal?: NodeJS.Signals): void;
};

type RunnerSupervisor = {
  start(binding: RunnerBinding): Promise<RunnerExecution>;
  inspectPersistedExecutor(identity: ProcessIdentity): 'live' | 'exited' | 'ambiguous';
};

type RunnerSupervisorModule = {
  RunnerSupervisor: new (options: {
    readonly runnerEntryPoint: string;
    readonly readyTimeoutMs: number;
    readonly heartbeatIntervalMs: number;
    readonly heartbeatExpiryMs: number;
  }) => RunnerSupervisor;
};

type RecoveryOptionsWithExecutor = StartupRecoveryOptions & {
  readonly inspectExecutor: (identity: ProcessIdentity) => 'live' | 'exited' | 'ambiguous';
};

type RestartFixture = {
  readonly database: Database.Database;
  readonly sessionId: string;
  readonly turnId: string;
  readonly claim: Claim;
  readonly toolRunId: string;
};

const MODULE_PATH = '../../services/daemon/src/runtime/runner-supervisor.js';
const runnerEntryPoint = fileURLToPath(
  new URL('../../runtimes/session-runner/src/index.ts', import.meta.url),
);
const OLD_EPOCH = '018f0000-0000-7000-8000-000000004000';
const NEW_EPOCH = '018f0000-0000-7000-8000-000000004100';
const LATER_EPOCH = '018f0000-0000-7000-8000-000000004200';
const CLAIM_TIME = '2026-07-15T04:00:00.000Z';
const RECOVERY_TIME = '2026-07-15T04:01:00.000Z';

const loadSupervisor = async (): Promise<RunnerSupervisorModule> =>
  (await import(MODULE_PATH)) as unknown as RunnerSupervisorModule;

const createIdFactory = (prefix: string): (() => string) => {
  let ordinal = 0;
  return () => `${prefix}-${String(++ordinal)}`;
};

const createSupervisor = async (): Promise<RunnerSupervisor> => {
  const { RunnerSupervisor } = await loadSupervisor();
  return new RunnerSupervisor({
    runnerEntryPoint,
    readyTimeoutMs: 5_000,
    heartbeatIntervalMs: 5_000,
    heartbeatExpiryMs: 20_000,
  });
};

const createFixture = async (runtime: TempRuntime): Promise<RestartFixture> => {
  const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
  const service = new SessionService(database);
  const workspacePath = join(runtime.rootDir, 'workspace');
  mkdirSync(workspacePath);
  const workspace = service.registerWorkspace(
    { path: workspacePath },
    'runner-restart-workspace',
  );
  const created = service.createSession(
    {
      workspaceId: workspace.workspaceId,
      title: 'Runner restart',
      prompt: 'Recover the active Runner',
    },
    'runner-restart-session',
  );
  const claim = new Scheduler(database, {
    daemonEpoch: OLD_EPOCH,
    now: () => new Date(CLAIM_TIME),
    createId: createIdFactory('runner-restart-claim'),
  }).claimNext();
  if (!claim) {
    throw new Error('Expected a claimed Turn');
  }
  const callId = 'restart-model-call';
  const attemptId = 'restart-model-attempt';
  const toolRunId = 'restart-tool-run';
  database
    .prepare(
      `INSERT INTO model_calls (
        id, session_id, turn_id, ordinal, kind, status,
        profile_snapshot_json, input_json, result_json,
        successful_attempt_id, error_code, error_message,
        created_at, started_at, finished_at
      ) VALUES (?, ?, ?, 1, 'craft', 'running', '{}', '{}', NULL,
        NULL, NULL, NULL, ?, ?, NULL)`,
    )
    .run(callId, created.sessionId, created.turnId, CLAIM_TIME, CLAIM_TIME);
  database
    .prepare(
      `INSERT INTO model_attempts (
        id, model_call_id, attempt, status, provider_request_id,
        partial_output_json, result_json, finish_reason,
        input_tokens, output_tokens, cached_tokens, latency_ms,
        error_code, error_message, retryable, started_at, finished_at
      ) VALUES (?, ?, 1, 'running', NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
    )
    .run(attemptId, callId, CLAIM_TIME);
  database
    .prepare(
      `INSERT INTO tool_runs (
        id, session_id, turn_id, ordinal, logical_call_id,
        source_model_call_id, source_model_attempt_id, attempt,
        operation_id, idempotency_key, source_handle, tool_id, tool_version,
        execution_mode, side_effect_class, status, dispatch_state,
        dispatch_nonce, normalized_input_hash, input_json, result_json,
        effect_state, pid, process_start_identity, error_code, error_message,
        queued_at, started_at, finished_at
      ) VALUES (?, ?, ?, 1, 'restart-logical', ?, ?, 1,
        'restart-operation', 'restart-idempotency', NULL, 'fs.write_text', '1',
        'worker', 'local_write', 'queued', 'prepared', 'restart-dispatch',
        'restart-hash', '{}', NULL, 'unknown', NULL, NULL, NULL, NULL,
        ?, NULL, NULL)`,
    )
    .run(toolRunId, created.sessionId, created.turnId, callId, attemptId, CLAIM_TIME);
  return {
    database,
    sessionId: created.sessionId,
    turnId: created.turnId,
    claim,
    toolRunId,
  };
};

const bindingFor = (claim: Claim): RunnerBinding => ({
  runnerInstanceId: 'runner-restart-instance',
  capability: 'runner-restart-capability',
  daemonEpoch: claim.daemonEpoch,
  sessionId: claim.sessionId,
  turnId: claim.turnId,
  leaseId: claim.leaseId,
  leaseEpoch: claim.leaseEpoch,
  executionFence: claim.executionFence,
});

const persistIdentity = (
  fixture: RestartFixture,
  identity: ProcessIdentity,
): void => {
  fixture.database
    .prepare(
      `UPDATE runner_leases
       SET runner_instance_id = ?, pid = ?, process_start_identity = ?
       WHERE id = ?`,
    )
    .run(
      'runner-restart-instance',
      identity.pid,
      identity.processStartIdentity,
      fixture.claim.leaseId,
    );
};

const captureFacts = (database: Database.Database): string =>
  JSON.stringify({
    sessions: database.prepare('SELECT * FROM sessions ORDER BY id').all(),
    turns: database.prepare('SELECT * FROM turns ORDER BY id').all(),
    leases: database.prepare('SELECT * FROM runner_leases ORDER BY id').all(),
    slots: database.prepare('SELECT * FROM scheduler_slots ORDER BY slot_no').all(),
    calls: database.prepare('SELECT * FROM model_calls ORDER BY id').all(),
    attempts: database.prepare('SELECT * FROM model_attempts ORDER BY id').all(),
    tools: database.prepare('SELECT * FROM tool_runs ORDER BY id').all(),
    events: database
      .prepare('SELECT * FROM session_events ORDER BY session_id, seq')
      .all(),
  });

const recover = (
  database: Database.Database,
  options: RecoveryOptionsWithExecutor,
): void => {
  const recovery = recoverStartupState as unknown as (
    target: Database.Database,
    recoveryOptions: RecoveryOptionsWithExecutor,
  ) => void;
  recovery(database, options);
};

describe('Runner restart recovery', () => {
  let runtime: TempRuntime | undefined;
  let execution: RunnerExecution | undefined;

  afterEach(async () => {
    execution?.kill('SIGKILL');
    await execution?.completion.catch(() => undefined);
    execution = undefined;
    await runtime?.cleanup();
    runtime = undefined;
  });

  it('interrupts Model/Tool/Turn facts atomically only after the old direct child is reaped', async () => {
    await loadSupervisor();
    const supervisor = await createSupervisor();
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    execution = await supervisor.start(bindingFor(fixture.claim));
    persistIdentity(fixture, execution.identity);
    execution.kill('SIGKILL');
    await execution.completion;

    try {
      recover(fixture.database, {
        daemonEpoch: NEW_EPOCH,
        now: () => new Date(RECOVERY_TIME),
        createId: createIdFactory('restart-recovery'),
        inspectExecutor: (identity) => supervisor.inspectPersistedExecutor(identity),
      });
      expect(
        fixture.database
          .prepare('SELECT status FROM model_attempts WHERE id = ?')
          .get('restart-model-attempt'),
      ).toEqual({ status: 'interrupted' });
      expect(
        fixture.database.prepare('SELECT status FROM model_calls WHERE id = ?').get(
          'restart-model-call',
        ),
      ).toEqual({ status: 'interrupted' });
      expect(
        fixture.database
          .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
          .get(fixture.toolRunId),
      ).toEqual({ status: 'canceled', effect_state: 'not_applied' });
      expect(
        fixture.database
          .prepare(
            `SELECT type FROM session_events
             WHERE turn_id = ? AND (
               type LIKE 'model.%' OR type LIKE 'tool.%'
               OR type IN ('turn.interrupted', 'recovery.detected')
             ) ORDER BY seq`,
          )
          .all(fixture.turnId),
      ).toEqual([
        { type: 'model.attempt_interrupted' },
        { type: 'model.interrupted' },
        { type: 'tool.canceled' },
        { type: 'turn.interrupted' },
        { type: 'recovery.detected' },
      ]);
      expect(
        fixture.database.prepare('SELECT status FROM turns WHERE id = ?').get(fixture.turnId),
      ).toEqual({ status: 'interrupted' });
      expect(fixture.database.prepare('SELECT state FROM scheduler_slots').get()).toEqual({
        state: 'free',
      });
      const recovered = captureFacts(fixture.database);
      recover(fixture.database, {
        daemonEpoch: LATER_EPOCH,
        inspectExecutor: (identity) => supervisor.inspectPersistedExecutor(identity),
      });
      expect(captureFacts(fixture.database)).toBe(recovered);
    } finally {
      fixture.database.close();
    }
  });

  it.each(['live', 'ambiguous'] as const)(
    'returns ORPHAN_EXECUTOR_SUSPECTED with zero writes for a %s persisted identity',
    async (state) => {
      await loadSupervisor();
      const supervisor = await createSupervisor();
      runtime = createTempRuntime();
      const fixture = await createFixture(runtime);
      execution = await supervisor.start(bindingFor(fixture.claim));
      const identity =
        state === 'live'
          ? execution.identity
          : {
              pid: execution.identity.pid,
              processStartIdentity: `${execution.identity.processStartIdentity}-mismatch`,
            };
      persistIdentity(fixture, identity);
      const before = captureFacts(fixture.database);

      try {
        expect(() =>
          recover(fixture.database, {
            daemonEpoch: NEW_EPOCH,
            inspectExecutor: (persisted) =>
              supervisor.inspectPersistedExecutor(persisted),
          }),
        ).toThrow(expect.objectContaining({ code: 'ORPHAN_EXECUTOR_SUSPECTED' }));
        expect(captureFacts(fixture.database)).toBe(before);
      } finally {
        fixture.database.close();
      }
    },
  );

  it('returns ORPHAN_EXECUTOR_SUSPECTED with zero writes for an incomplete launch marker', async () => {
    runtime = createTempRuntime();
    const fixture = await createFixture(runtime);
    fixture.database
      .prepare(
        `UPDATE runner_leases
         SET runner_instance_id = 'runner-launch-marker'
         WHERE id = ?`,
      )
      .run(fixture.claim.leaseId);
    const before = captureFacts(fixture.database);
    let inspected = false;

    try {
      expect(() =>
        recover(fixture.database, {
          daemonEpoch: NEW_EPOCH,
          inspectExecutor: () => {
            inspected = true;
            return 'exited';
          },
        }),
      ).toThrow(expect.objectContaining({ code: 'ORPHAN_EXECUTOR_SUSPECTED' }));
      expect(inspected).toBe(false);
      expect(captureFacts(fixture.database)).toBe(before);
    } finally {
      fixture.database.close();
    }
  });
});
