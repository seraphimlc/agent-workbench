import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SessionCreateResultSchema,
  SessionSnapshotSchema,
  WorkspaceRegisterResultSchema,
  type RpcRequestEnvelope,
} from '../../packages/protocol/src/index.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  configureDatabase,
  openRuntimeDatabase,
} from '../../services/daemon/src/db/database.js';
import { DaemonServer } from '../../services/daemon/src/server.js';
import { Scheduler } from '../../services/daemon/src/runtime/scheduler.js';
import { SessionService } from '../../services/daemon/src/runtime/session-service.js';
import {
  recoverStartupState,
  type StartupRecoveryOptions,
} from '../../services/daemon/src/runtime/startup-recovery.js';
import {
  createTempRuntime,
  type DaemonProcess,
  type TempRuntime,
} from '../../packages/testkit/src/temp-runtime.js';
import {
  connectRpcClient,
  type RpcClient,
} from '../../packages/testkit/src/rpc-client.js';

const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

const OLD_DAEMON_EPOCH = '018f0000-0000-7000-8000-000000000300';
const NEW_DAEMON_EPOCH = '018f0000-0000-7000-8000-000000000400';
const LATER_DAEMON_EPOCH = '018f0000-0000-7000-8000-000000000500';
const CLAIM_TIME = '2026-07-14T09:00:00.000Z';
const RECOVERY_TIME = '2026-07-14T09:05:00.000Z';
const crashBeforeRecoveryCommitEntryPoint = fileURLToPath(
  new URL('../fixtures/crash-before-recovery-commit-daemon.ts', import.meta.url),
);

type RuntimeDatabase = import('better-sqlite3').Database;

type ActiveFixture = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly queuedTurnId: string;
  readonly leaseId: string;
};

type ClaimedDaemonFixture = ActiveFixture & {
  readonly daemon: DaemonProcess;
  readonly daemonEpoch: string;
};

const mutationRequest = (
  client: RpcClient,
  method: 'workspace.register' | 'session.create' | 'turn.enqueue',
  payload: unknown,
  clientRequestId: string,
  sessionId: string | null = null,
): RpcRequestEnvelope => ({
  ...client.createRequest(method, payload),
  sessionId,
  clientRequestId,
});

const authenticatedClient = async (
  runtime: TempRuntime,
  daemon: DaemonProcess,
): Promise<RpcClient> => {
  const client = await connectRpcClient(runtime.socketPath);
  await client.waitForChallenge();
  const response = await client.authenticate(daemon.bootstrapSecret);
  if (!response.ok) {
    throw new Error('Daemon authentication failed');
  }
  return client;
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

const createDirectActiveFixture = async (
  runtime: TempRuntime,
  status: 'running' | 'cancel_requested' = 'running',
): Promise<{ readonly database: RuntimeDatabase; readonly fixture: ActiveFixture }> => {
  const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
  const service = new SessionService(database);
  const workspacePath = join(runtime.rootDir, `direct-workspace-${status}`);
  mkdirSync(workspacePath);
  const workspace = service.registerWorkspace(
    { path: workspacePath },
    `direct-workspace-${status}`,
  );
  const created = service.createSession(
    {
      workspaceId: workspace.workspaceId,
      title: `Direct ${status}`,
      prompt: 'First prompt',
    },
    `direct-session-${status}`,
  );
  const queued = service.enqueueTurn(
    { sessionId: created.sessionId, prompt: 'Queued follower' },
    `direct-enqueue-${status}`,
  );
  const leaseId = '018f0000-0000-7000-8000-000000000301';
  const scheduler = new Scheduler(database, {
    daemonEpoch: OLD_DAEMON_EPOCH,
    now: () => new Date(CLAIM_TIME),
    createId: createIdFactory(
      leaseId,
      '018f0000-0000-7000-8000-000000000302',
    ),
  });
  expect(scheduler.claimNext()?.turnId).toBe(created.turnId);
  if (status === 'cancel_requested') {
    database
      .prepare("UPDATE turns SET status = 'cancel_requested' WHERE id = ?")
      .run(created.turnId);
    database
      .prepare("UPDATE sessions SET runtime_status = 'canceling' WHERE id = ?")
      .run(created.sessionId);
  }
  return {
    database,
    fixture: {
      sessionId: created.sessionId,
      turnId: created.turnId,
      queuedTurnId: queued.turnId,
      leaseId,
    },
  };
};

const captureFacts = (database: RuntimeDatabase): string =>
  JSON.stringify({
    workspaces: database.prepare('SELECT * FROM workspaces ORDER BY id').all(),
    sessions: database.prepare('SELECT * FROM sessions ORDER BY id').all(),
    messages: database.prepare('SELECT * FROM messages ORDER BY id').all(),
    turns: database.prepare('SELECT * FROM turns ORDER BY id').all(),
    events: database
      .prepare('SELECT * FROM session_events ORDER BY session_id, seq')
      .all(),
    slots: database.prepare('SELECT * FROM scheduler_slots ORDER BY slot_no').all(),
    leases: database.prepare('SELECT * FROM runner_leases ORDER BY id').all(),
    modelCalls: database.prepare('SELECT * FROM model_calls ORDER BY id').all(),
    modelAttempts: database.prepare('SELECT * FROM model_attempts ORDER BY id').all(),
    modelToolCalls: database
      .prepare('SELECT * FROM model_tool_calls ORDER BY model_attempt_id, call_index')
      .all(),
    toolRuns: database.prepare('SELECT * FROM tool_runs ORDER BY id').all(),
    effectResolutions: database
      .prepare('SELECT * FROM effect_resolutions ORDER BY id')
      .all(),
    idempotency: database
      .prepare('SELECT * FROM rpc_idempotency ORDER BY method, client_request_id')
      .all(),
  });

const activeWorkerExpected = new Map<
  string,
  readonly ['canceled' | 'interrupted', 'not_applied' | 'unknown']
>([
  ['queued/prepared/unknown', ['canceled', 'not_applied']],
  ['queued/worker_ready/unknown', ['canceled', 'not_applied']],
  ['running/go_sent/unknown', ['interrupted', 'unknown']],
  ['running/acknowledged/unknown', ['interrupted', 'unknown']],
  ['cancel_requested/go_sent/unknown', ['interrupted', 'unknown']],
  ['cancel_requested/acknowledged/unknown', ['interrupted', 'unknown']],
]);

const terminalToolLegalTuples = new Set<string>([
  'succeeded/read_inline/null/not_applied',
  'failed/read_inline/null/not_applied',
  'canceled/read_inline/null/not_applied',
  'interrupted/read_inline/null/not_applied',
  'succeeded/transactional_intrinsic/null/not_applied',
  'failed/transactional_intrinsic/null/not_applied',
  'canceled/transactional_intrinsic/null/not_applied',
  'interrupted/transactional_intrinsic/null/not_applied',
  'succeeded/worker/acknowledged/applied',
  'failed/worker/prepared/not_applied',
  'failed/worker/worker_ready/not_applied',
  'failed/worker/go_sent/not_applied',
  'failed/worker/go_sent/applied',
  'failed/worker/go_sent/unknown',
  'failed/worker/acknowledged/not_applied',
  'failed/worker/acknowledged/applied',
  'failed/worker/acknowledged/unknown',
  'canceled/worker/prepared/not_applied',
  'canceled/worker/worker_ready/not_applied',
  'canceled/worker/go_sent/not_applied',
  'canceled/worker/acknowledged/not_applied',
  'interrupted/worker/go_sent/applied',
  'interrupted/worker/go_sent/unknown',
  'interrupted/worker/acknowledged/applied',
  'interrupted/worker/acknowledged/unknown',
]);

const workerActiveMatrixCases = (
  ['queued', 'running', 'cancel_requested'] as const
).flatMap((status) =>
  (['prepared', 'worker_ready', 'go_sent', 'acknowledged'] as const).flatMap(
    (dispatchState) =>
      (['not_applied', 'applied', 'unknown'] as const).map((effectState) => {
        const expected = activeWorkerExpected.get(
          `${status}/${dispatchState}/${effectState}`,
        );
        return {
          name: `${status} + ${dispatchState} + ${effectState}`,
          status,
          dispatchState,
          effectState,
          valid: expected !== undefined,
          expectedStatus: expected?.[0],
          expectedEffectState: expected?.[1],
        };
      }),
  ),
);

const terminalToolMatrixCases = (
  ['succeeded', 'failed', 'canceled', 'interrupted'] as const
).flatMap((status) => [
  {
    name: `${status} + read_inline + null + not_applied`,
    status,
    executionMode: 'read_inline' as const,
    dispatchState: null,
    effectState: 'not_applied' as const,
    valid: terminalToolLegalTuples.has(`${status}/read_inline/null/not_applied`),
  },
  ...(['not_applied', 'unknown'] as const).map((effectState) => ({
    name: `${status} + transactional_intrinsic + null + ${effectState}`,
    status,
    executionMode: 'transactional_intrinsic' as const,
    dispatchState: null,
    effectState,
    valid: terminalToolLegalTuples.has(
      `${status}/transactional_intrinsic/null/${effectState}`,
    ),
  })),
  ...(['prepared', 'worker_ready', 'go_sent', 'acknowledged'] as const).flatMap(
    (dispatchState) =>
      (['not_applied', 'applied', 'unknown'] as const).map((effectState) => {
        return {
          name: `${status} + worker + ${dispatchState} + ${effectState}`,
          status,
          executionMode: 'worker' as const,
          dispatchState,
          effectState,
          valid: terminalToolLegalTuples.has(
            `${status}/worker/${dispatchState}/${effectState}`,
          ),
        };
      }),
  ),
]);

const insertRecoveredTerminalCall = (
  database: RuntimeDatabase,
  fixture: Pick<ActiveFixture, 'sessionId' | 'turnId'>,
  options: {
    readonly callId?: string;
    readonly ordinal?: number;
    readonly finishedAt?: string | null;
  } = {},
): string => {
  const callId = options.callId ?? 'recovered-terminal-call';
  database
    .prepare(
      `INSERT INTO model_calls (
        id, session_id, turn_id, ordinal, kind, status,
        profile_snapshot_json, input_json, result_json,
        successful_attempt_id, error_code, error_message,
        created_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, 'craft', 'interrupted', '{}', '{}', NULL,
        NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      callId,
      fixture.sessionId,
      fixture.turnId,
      options.ordinal ?? 1,
      CLAIM_TIME,
      CLAIM_TIME,
      options.finishedAt === undefined ? RECOVERY_TIME : options.finishedAt,
    );
  return callId;
};

const insertRecoveredSucceededSource = (
  database: RuntimeDatabase,
  fixture: Pick<ActiveFixture, 'sessionId' | 'turnId'>,
  toolId: string,
  options: { readonly suffix?: string; readonly ordinal?: number } = {},
): { readonly callId: string; readonly attemptId: string } => {
  const suffix = options.suffix ?? 'recovered';
  const ordinal = options.ordinal ?? 1;
  const callId = `${suffix}-source-call`;
  const attemptId = `${suffix}-source-attempt`;
  const logicalCallId = `${suffix}-logical-call`;
  const result = JSON.stringify({
    finishReason: 'tool_calls',
    content: '',
    toolCalls: [{ logicalCallId, toolId }],
  });
  const transaction = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO model_calls (
          id, session_id, turn_id, ordinal, kind, status,
          profile_snapshot_json, input_json, result_json,
          successful_attempt_id, error_code, error_message,
          created_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, 'craft', 'succeeded', '{}', '{}', ?,
          NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        callId,
        fixture.sessionId,
        fixture.turnId,
        ordinal,
        result,
        CLAIM_TIME,
        CLAIM_TIME,
        CLAIM_TIME,
      );
    database
      .prepare(
        `INSERT INTO model_attempts (
          id, model_call_id, attempt, status, provider_request_id,
          partial_output_json, result_json, finish_reason,
          input_tokens, output_tokens, cached_tokens, latency_ms,
          error_code, error_message, retryable, started_at, finished_at
        ) VALUES (?, ?, 1, 'succeeded', NULL, NULL, ?, 'tool_calls',
          1, 1, 0, 1, NULL, NULL, 0, ?, ?)`,
      )
      .run(attemptId, callId, result, CLAIM_TIME, CLAIM_TIME);
    database
      .prepare('UPDATE model_calls SET successful_attempt_id = ? WHERE id = ?')
      .run(attemptId, callId);
    database
      .prepare(
        `INSERT INTO model_tool_calls (
          model_attempt_id, logical_call_id, call_index, tool_id,
          arguments_json, normalized_input_hash
        ) VALUES (?, ?, 0, ?, '{}', ?)`,
      )
      .run(attemptId, logicalCallId, toolId, `${suffix}-input`);
  });
  transaction.immediate();
  return { callId, attemptId };
};

const insertRecoveredToolRun = (
  database: RuntimeDatabase,
  fixture: Pick<ActiveFixture, 'sessionId' | 'turnId'>,
  options: {
    readonly status:
      | 'queued'
      | 'running'
      | 'cancel_requested'
      | 'succeeded'
      | 'failed'
      | 'canceled'
      | 'interrupted';
    readonly executionMode?: 'read_inline' | 'worker' | 'transactional_intrinsic';
    readonly dispatchState?: 'prepared' | 'worker_ready' | 'go_sent' | 'acknowledged' | null;
    readonly effectState?: 'not_applied' | 'applied' | 'unknown';
    readonly finishedAt?: string | null;
    readonly suffix?: string;
    readonly ordinal?: number;
  },
): string => {
  const suffix = options.suffix ?? 'recovered';
  const ordinal = options.ordinal ?? 1;
  const executionMode = options.executionMode ?? 'read_inline';
  const worker = executionMode === 'worker';
  const status = options.status;
  const toolRunId = `${suffix}-tool-run`;
  const logicalCallId = `${suffix}-logical-call`;
  const toolId = worker
    ? 'fs.write_text'
    : executionMode === 'read_inline'
      ? 'fs.read_text'
      : 'runtime.test';
  const source = insertRecoveredSucceededSource(database, fixture, toolId, {
    suffix,
    ordinal,
  });
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1,
        ?, ?, NULL, ?, '1', ?, ?, ?, ?, ?,
        ?, '{}', NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      toolRunId,
      fixture.sessionId,
      fixture.turnId,
      ordinal,
      logicalCallId,
      source.callId,
      source.attemptId,
      `${suffix}-operation`,
      worker ? `${suffix}-idempotency` : null,
      toolId,
      executionMode,
      executionMode === 'read_inline' ? 'read' : 'local_write',
      status,
      worker ? (options.dispatchState ?? 'prepared') : null,
      worker ? `${suffix}-dispatch` : null,
      `${suffix}-input`,
      options.effectState ?? (worker ? 'unknown' : 'not_applied'),
      CLAIM_TIME,
      status === 'queued' ? null : CLAIM_TIME,
      options.finishedAt ?? null,
    );
  return toolRunId;
};

const readOwnerEpoch = (runtime: TempRuntime): string => {
  const owner = JSON.parse(
    readFileSync(join(runtime.dataDir, '.daemon-owner.json'), 'utf8'),
  ) as { readonly daemonEpoch?: unknown };
  if (typeof owner.daemonEpoch !== 'string') {
    throw new Error('Daemon owner metadata did not contain an epoch');
  }
  return owner.daemonEpoch;
};

const createClaimedDaemonFixture = async (
  runtime: TempRuntime,
): Promise<ClaimedDaemonFixture> => {
  const workspacePath = join(runtime.rootDir, 'rpc-workspace');
  mkdirSync(workspacePath);
  const daemon = runtime.spawnDaemon();
  await daemon.waitForReady();
  const client = await authenticatedClient(runtime, daemon);
  try {
    const workspaceResponse = await client.sendRequest(
      mutationRequest(
        client,
        'workspace.register',
        { path: workspacePath },
        'restart-workspace',
      ),
    );
    if (!workspaceResponse.ok) {
      throw new Error('workspace.register failed');
    }
    const workspace = WorkspaceRegisterResultSchema.parse(workspaceResponse.result);
    const sessionResponse = await client.sendRequest(
      mutationRequest(
        client,
        'session.create',
        {
          workspaceId: workspace.workspaceId,
          title: 'Restart recovery',
          prompt: 'Run then crash',
        },
        'restart-session',
      ),
    );
    if (!sessionResponse.ok) {
      throw new Error('session.create failed');
    }
    const created = SessionCreateResultSchema.parse(sessionResponse.result);
    const enqueueResponse = await client.sendRequest(
      mutationRequest(
        client,
        'turn.enqueue',
        { sessionId: created.sessionId, prompt: 'Stay queued' },
        'restart-enqueue',
        created.sessionId,
      ),
    );
    if (!enqueueResponse.ok) {
      throw new Error('turn.enqueue failed');
    }
    const queuedTurnId = (enqueueResponse.result as { readonly turnId: string }).turnId;
    const daemonEpoch = readOwnerEpoch(runtime);
    const claimDatabase = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(claimDatabase);
    try {
      const claim = new Scheduler(claimDatabase, { daemonEpoch }).claimNext();
      if (!claim) {
        throw new Error('Scheduler did not claim the RPC-created Turn');
      }
      expect(claim.daemonEpoch).toBe(daemonEpoch);
      return {
        daemon,
        daemonEpoch,
        sessionId: created.sessionId,
        turnId: created.turnId,
        queuedTurnId,
        leaseId: claim.leaseId,
      };
    } finally {
      claimDatabase.close();
    }
  } finally {
    await client.close();
  }
};

const recoveryOptions = (
  hooks: StartupRecoveryOptions['hooks'] = {},
): StartupRecoveryOptions => ({
  daemonEpoch: NEW_DAEMON_EPOCH,
  now: () => new Date(RECOVERY_TIME),
  createId: createIdFactory(
    '018f0000-0000-7000-8000-000000000401',
    '018f0000-0000-7000-8000-000000000402',
    '018f0000-0000-7000-8000-000000000403',
  ),
  hooks,
});

describe('startup scheduler recovery', () => {
  let runtime: TempRuntime | undefined;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
  });

  it.each(['running', 'cancel_requested'] as const)(
    'recovers one complete old %s tuple exactly once',
    async (status) => {
      runtime = createTempRuntime();
      const { database, fixture } = await createDirectActiveFixture(runtime, status);
      try {
        const beforeSession = database
          .prepare('SELECT * FROM sessions WHERE id = ?')
          .get(fixture.sessionId) as Record<string, unknown>;
        const beforeTurn = database
          .prepare('SELECT * FROM turns WHERE id = ?')
          .get(fixture.turnId) as Record<string, unknown>;
        const beforeMessages = database
          .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
          .all(fixture.sessionId);
        const beforeQueued = database
          .prepare('SELECT * FROM turns WHERE id = ?')
          .get(fixture.queuedTurnId);

        recoverStartupState(database, recoveryOptions());

        expect(
          database.prepare('SELECT * FROM turns WHERE id = ?').get(fixture.turnId),
        ).toEqual({
          ...beforeTurn,
          status: 'interrupted',
          execution_fence: Number(beforeTurn.execution_fence) + 1,
          finished_at: RECOVERY_TIME,
          error_code: null,
          error_message: null,
          result_message_id: null,
        });
        expect(
          database.prepare('SELECT * FROM turns WHERE id = ?').get(fixture.queuedTurnId),
        ).toEqual(beforeQueued);
        expect(
          database.prepare('SELECT * FROM sessions WHERE id = ?').get(fixture.sessionId),
        ).toEqual({
          ...beforeSession,
          current_turn_id: null,
          queue_block_reason: 'recovery_review',
          recovery_episode: Number(beforeSession.recovery_episode) + 1,
          recovery_source_turn_id: fixture.turnId,
          runtime_status: 'recovering',
          next_event_seq: Number(beforeSession.next_event_seq) + 2,
          revision: Number(beforeSession.revision) + 1,
          updated_at: RECOVERY_TIME,
        });
        expect(database.prepare('SELECT * FROM scheduler_slots').all()).toEqual([
          {
            slot_no: 1,
            state: 'free',
            owner_turn_id: null,
            updated_at: RECOVERY_TIME,
          },
        ]);
        expect(
          database.prepare('SELECT * FROM runner_leases WHERE id = ?').get(fixture.leaseId),
        ).toEqual({
          id: fixture.leaseId,
          daemon_epoch: OLD_DAEMON_EPOCH,
          lease_epoch: 1,
          session_id: fixture.sessionId,
          current_turn_id: fixture.turnId,
          status: 'expired',
          heartbeat_at: CLAIM_TIME,
          lease_expires_at: RECOVERY_TIME,
          runner_instance_id: null,
          pid: null,
          process_start_identity: null,
        });
        expect(
          database
            .prepare(
              `SELECT seq, type, actor, audience, turn_id, tool_run_id,
                      payload_json, blob_id, created_at
               FROM session_events
               WHERE session_id = ? AND seq >= ?
               ORDER BY seq`,
            )
            .all(fixture.sessionId, beforeSession.next_event_seq),
        ).toEqual([
          {
            seq: beforeSession.next_event_seq,
            type: 'turn.interrupted',
            actor: 'daemon',
            audience: 'both',
            turn_id: fixture.turnId,
            tool_run_id: null,
            payload_json: JSON.stringify({ reason: 'daemon_restart' }),
            blob_id: null,
            created_at: RECOVERY_TIME,
          },
          {
            seq: Number(beforeSession.next_event_seq) + 1,
            type: 'recovery.detected',
            actor: 'daemon',
            audience: 'both',
            turn_id: fixture.turnId,
            tool_run_id: null,
            payload_json: JSON.stringify({
              reason: 'daemon_restart',
              recoveryEpisode: Number(beforeSession.recovery_episode) + 1,
              recoverySourceTurnId: fixture.turnId,
            }),
            blob_id: null,
            created_at: RECOVERY_TIME,
          },
        ]);
        expect(
          database
            .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
            .all(fixture.sessionId),
        ).toEqual(beforeMessages);

        const recoveredFacts = captureFacts(database);
        recoverStartupState(database, {
          daemonEpoch: LATER_DAEMON_EPOCH,
          createId: () => {
            throw new Error('No-op recovery allocated an id');
          },
          hooks: {
            beforeCommit: () => {
              throw new Error('No-op recovery invoked beforeCommit');
            },
          },
        });
        recoverStartupState(database, {
          daemonEpoch: '018f0000-0000-7000-8000-000000000600',
        });
        expect(captureFacts(database)).toBe(recoveredFacts);
        expect(
          new Scheduler(database, { daemonEpoch: NEW_DAEMON_EPOCH }).claimNext(),
        ).toBeNull();
        expect(database.pragma('foreign_key_check')).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it('rolls back all recovery writes when beforeCommit throws', async () => {
    runtime = createTempRuntime();
    const { database } = await createDirectActiveFixture(runtime);
    try {
      const before = captureFacts(database);
      const injectedFailure = new Error('injected recovery failure');

      expect(() =>
        recoverStartupState(
          database,
          recoveryOptions({
            beforeCommit: () => {
              throw injectedFailure;
            },
          }),
        ),
      ).toThrow(injectedFailure);
      expect(captureFacts(database)).toBe(before);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      operation: 'Turn update',
      trigger: `
        CREATE TRIGGER ignore_recovery_turn_update
        BEFORE UPDATE OF status ON turns
        WHEN NEW.status = 'interrupted'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
    {
      operation: 'Lease update',
      trigger: `
        CREATE TRIGGER ignore_recovery_lease_update
        BEFORE UPDATE OF status ON runner_leases
        WHEN NEW.status = 'expired'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
    {
      operation: 'slot update',
      trigger: `
        CREATE TRIGGER ignore_recovery_slot_update
        BEFORE UPDATE OF state ON scheduler_slots
        WHEN NEW.state = 'free'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
    {
      operation: 'Session update',
      trigger: `
        CREATE TRIGGER ignore_recovery_session_update
        BEFORE UPDATE OF runtime_status ON sessions
        WHEN NEW.runtime_status = 'recovering'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
    {
      operation: 'turn.interrupted Event insert',
      trigger: `
        CREATE TRIGGER ignore_recovery_interrupted_event
        BEFORE INSERT ON session_events
        WHEN NEW.type = 'turn.interrupted'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
    {
      operation: 'recovery.detected Event insert',
      trigger: `
        CREATE TRIGGER ignore_recovery_detected_event
        BEFORE INSERT ON session_events
        WHEN NEW.type = 'recovery.detected'
        BEGIN SELECT RAISE(IGNORE); END;
      `,
    },
  ])(
    'rolls back every staged recovery fact when the $operation affects zero rows',
    async ({ trigger }) => {
      runtime = createTempRuntime();
      const { database } = await createDirectActiveFixture(runtime);
      try {
        database.exec(trigger);
        const before = captureFacts(database);

        expect(() => recoverStartupState(database, recoveryOptions())).toThrow(
          /invariant/i,
        );
        expect(captureFacts(database)).toBe(before);
      } finally {
        database.close();
      }
    },
  );

  it('fails closed when an active Lease already uses the new daemon epoch', async () => {
    runtime = createTempRuntime();
    const { database, fixture } = await createDirectActiveFixture(runtime);
    try {
      database
        .prepare('UPDATE runner_leases SET daemon_epoch = ? WHERE id = ?')
        .run(NEW_DAEMON_EPOCH, fixture.leaseId);
      const before = captureFacts(database);

      expect(() => recoverStartupState(database, recoveryOptions())).toThrow(
        /invariant/i,
      );
      expect(captureFacts(database)).toBe(before);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: 'missing recovery block',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare('UPDATE sessions SET queue_block_reason = NULL WHERE id = ?')
          .run(fixture.sessionId);
      },
    },
    {
      name: 'zero recovery episode',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare('UPDATE sessions SET recovery_episode = 0 WHERE id = ?')
          .run(fixture.sessionId);
      },
    },
    {
      name: 'mismatched recovery source Turn',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare('UPDATE sessions SET recovery_source_turn_id = ? WHERE id = ?')
          .run(fixture.queuedTurnId, fixture.sessionId);
      },
    },
    {
      name: 'missing expired Lease',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database.prepare('DELETE FROM runner_leases WHERE id = ?').run(fixture.leaseId);
      },
    },
    {
      name: 'multiple expired Leases for the recovery Turn',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare(
            `INSERT INTO runner_leases (
              id, daemon_epoch, lease_epoch, session_id, current_turn_id,
              status, heartbeat_at, lease_expires_at
            ) VALUES (?, ?, 2, ?, ?, 'expired', ?, ?)`,
          )
          .run(
            '018f0000-0000-7000-8000-000000000499',
            OLD_DAEMON_EPOCH,
            fixture.sessionId,
            fixture.turnId,
            CLAIM_TIME,
            RECOVERY_TIME,
          );
      },
    },
    {
      name: 'missing recovery.detected Event',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare(
            "DELETE FROM session_events WHERE session_id = ? AND turn_id = ? AND type = 'recovery.detected'",
          )
          .run(fixture.sessionId, fixture.turnId);
      },
    },
    {
      name: 'mismatched recovery.detected payload',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare(
            `UPDATE session_events
             SET payload_json = ?
             WHERE session_id = ? AND turn_id = ? AND type = 'recovery.detected'`,
          )
          .run(
            JSON.stringify({
              reason: 'daemon_restart',
              recoveryEpisode: 99,
              recoverySourceTurnId: fixture.turnId,
            }),
            fixture.sessionId,
            fixture.turnId,
          );
      },
    },
    {
      name: 'whitespace-only recovery reason',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare(
            `UPDATE session_events
             SET payload_json = ?
             WHERE session_id = ? AND turn_id = ? AND type = 'turn.interrupted'`,
          )
          .run(
            JSON.stringify({ reason: '   ' }),
            fixture.sessionId,
            fixture.turnId,
          );
        database
          .prepare(
            `UPDATE session_events
             SET payload_json = ?
             WHERE session_id = ? AND turn_id = ? AND type = 'recovery.detected'`,
          )
          .run(
            JSON.stringify({
              reason: '   ',
              recoveryEpisode: 1,
              recoverySourceTurnId: fixture.turnId,
            }),
            fixture.sessionId,
            fixture.turnId,
          );
      },
    },
    {
      name: 'running ModelCall',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare(
            `INSERT INTO model_calls (
              id, session_id, turn_id, ordinal, kind, status,
              profile_snapshot_json, input_json, result_json,
              successful_attempt_id, error_code, error_message,
              created_at, started_at, finished_at
            ) VALUES ('recovered-running-call', ?, ?, 1, 'craft', 'running',
              '{}', '{}', NULL, NULL, NULL, NULL, ?, ?, NULL)`,
          )
          .run(fixture.sessionId, fixture.turnId, CLAIM_TIME, CLAIM_TIME);
      },
    },
    {
      name: 'running ModelAttempt',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        const callId = insertRecoveredTerminalCall(database, fixture);
        database
          .prepare(
            `INSERT INTO model_attempts (
              id, model_call_id, attempt, status, provider_request_id,
              partial_output_json, result_json, finish_reason,
              input_tokens, output_tokens, cached_tokens, latency_ms,
              error_code, error_message, retryable, started_at, finished_at
            ) VALUES ('recovered-running-attempt', ?, 1, 'running', NULL,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, ?, NULL)`,
          )
          .run(callId, CLAIM_TIME);
      },
    },
    ...(['queued', 'running', 'cancel_requested'] as const).map((status) => ({
      name: `${status} ToolRun`,
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        insertRecoveredToolRun(database, fixture, { status });
      },
    })),
    {
      name: 'Terminal ModelCall without finished_at',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        insertRecoveredTerminalCall(database, fixture, { finishedAt: null });
      },
    },
    {
      name: 'succeeded ModelAttempt without a successful Attempt pointer',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        const callId = insertRecoveredTerminalCall(database, fixture);
        database
          .prepare(
            `INSERT INTO model_attempts (
              id, model_call_id, attempt, status, provider_request_id,
              partial_output_json, result_json, finish_reason,
              input_tokens, output_tokens, cached_tokens, latency_ms,
              error_code, error_message, retryable, started_at, finished_at
            ) VALUES ('recovered-unowned-success', ?, 1, 'succeeded', NULL,
              NULL, '{}', 'stop', 1, 1, 0, 1,
              NULL, NULL, 0, ?, ?)`,
          )
          .run(callId, CLAIM_TIME, CLAIM_TIME);
      },
    },
    {
      name: 'canceled ToolRun with unknown effect',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        insertRecoveredToolRun(database, fixture, {
          status: 'canceled',
          executionMode: 'worker',
          dispatchState: 'prepared',
          effectState: 'unknown',
          finishedAt: RECOVERY_TIME,
        });
      },
    },
    {
      name: 'succeeded worker ToolRun with unknown effect',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        insertRecoveredToolRun(database, fixture, {
          status: 'succeeded',
          executionMode: 'worker',
          dispatchState: 'acknowledged',
          effectState: 'unknown',
          finishedAt: RECOVERY_TIME,
        });
      },
    },
    {
      name: 'interrupted worker ToolRun with not_applied effect',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        insertRecoveredToolRun(database, fixture, {
          status: 'interrupted',
          executionMode: 'worker',
          dispatchState: 'go_sent',
          effectState: 'not_applied',
          finishedAt: RECOVERY_TIME,
        });
      },
    },
  ])(
    'fails closed with zero writes for an already-recovered state with $name',
    async ({ corrupt }) => {
      runtime = createTempRuntime();
      const { database, fixture } = await createDirectActiveFixture(runtime);
      try {
        recoverStartupState(database, recoveryOptions());
        corrupt(database, fixture);
        const before = captureFacts(database);

        expect(() =>
          recoverStartupState(database, {
            daemonEpoch: LATER_DAEMON_EPOCH,
            createId: () => {
              throw new Error('Invalid no-op recovery allocated an id');
            },
          }),
        ).toThrow(/invariant/i);
        expect(captureFacts(database)).toBe(before);
      } finally {
        database.close();
      }
    },
  );

  it('rejects an invalid Terminal ToolRun before first-startup recovery writes', async () => {
    runtime = createTempRuntime();
    const { database, fixture } = await createDirectActiveFixture(runtime);
    const toolRunId = insertRecoveredToolRun(database, fixture, {
      status: 'succeeded',
      executionMode: 'worker',
      dispatchState: 'prepared',
      effectState: 'not_applied',
      finishedAt: CLAIM_TIME,
    });
    expect(
      database
        .prepare(
          `SELECT status, execution_mode AS executionMode,
                  dispatch_state AS dispatchState, effect_state AS effectState
           FROM tool_runs WHERE id = ?`,
        )
        .get(toolRunId),
    ).toEqual({
      status: 'succeeded',
      executionMode: 'worker',
      dispatchState: 'prepared',
      effectState: 'not_applied',
    });
    const before = captureFacts(database);
    let allocations = 0;
    let hooks = 0;
    try {
      expect(() =>
        recoverStartupState(database, {
          ...recoveryOptions({
            beforeCommit: () => {
              hooks += 1;
            },
          }),
          createId: () => `invalid-terminal-startup-${String(++allocations)}`,
        }),
      ).toThrow(/startup recovery invariant/i);
      expect(captureFacts(database)).toBe(before);
      expect(allocations).toBe(0);
      expect(hooks).toBe(0);
    } finally {
      database.close();
    }
  });

  it('recovers a legal active ToolRun while preserving a legal Terminal ToolRun', async () => {
    runtime = createTempRuntime();
    const { database, fixture } = await createDirectActiveFixture(runtime);
    const activeToolRunId = insertRecoveredToolRun(database, fixture, {
      suffix: 'active-mixed',
      ordinal: 1,
      status: 'queued',
      executionMode: 'worker',
      dispatchState: 'prepared',
      effectState: 'unknown',
    });
    const terminalToolRunId = insertRecoveredToolRun(database, fixture, {
      suffix: 'terminal-mixed',
      ordinal: 2,
      status: 'succeeded',
      executionMode: 'worker',
      dispatchState: 'acknowledged',
      effectState: 'applied',
      finishedAt: CLAIM_TIME,
    });
    const terminalBefore = database
      .prepare('SELECT * FROM tool_runs WHERE id = ?')
      .get(terminalToolRunId);
    try {
      recoverStartupState(database, recoveryOptions());
      expect(
        database
          .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
          .get(activeToolRunId),
      ).toEqual({ status: 'canceled', effect_state: 'not_applied' });
      expect(
        database.prepare('SELECT * FROM tool_runs WHERE id = ?').get(terminalToolRunId),
      ).toEqual(terminalBefore);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: 'worker prepared unknown',
      status: 'queued' as const,
      executionMode: 'worker' as const,
      dispatchState: 'prepared' as const,
      effectState: 'unknown' as const,
      expectedStatus: 'canceled',
      expectedEffectState: 'not_applied',
      expectedEvent: 'tool.canceled',
    },
    {
      name: 'worker ready unknown',
      status: 'queued' as const,
      executionMode: 'worker' as const,
      dispatchState: 'worker_ready' as const,
      effectState: 'unknown' as const,
      expectedStatus: 'canceled',
      expectedEffectState: 'not_applied',
      expectedEvent: 'tool.canceled',
    },
    {
      name: 'queued read_inline',
      status: 'queued' as const,
      executionMode: 'read_inline' as const,
      dispatchState: null,
      effectState: 'not_applied' as const,
      expectedStatus: 'canceled',
      expectedEffectState: 'not_applied',
      expectedEvent: 'tool.canceled',
    },
    {
      name: 'queued transactional intrinsic',
      status: 'queued' as const,
      executionMode: 'transactional_intrinsic' as const,
      dispatchState: null,
      effectState: 'unknown' as const,
      expectedStatus: 'canceled',
      expectedEffectState: 'not_applied',
      expectedEvent: 'tool.canceled',
    },
    {
      name: 'worker GO-sent unknown',
      status: 'running' as const,
      executionMode: 'worker' as const,
      dispatchState: 'go_sent' as const,
      effectState: 'unknown' as const,
      expectedStatus: 'interrupted',
      expectedEffectState: 'unknown',
      expectedEvent: 'tool.interrupted',
    },
    {
      name: 'worker acknowledged unknown',
      status: 'cancel_requested' as const,
      executionMode: 'worker' as const,
      dispatchState: 'acknowledged' as const,
      effectState: 'unknown' as const,
      expectedStatus: 'interrupted',
      expectedEffectState: 'unknown',
      expectedEvent: 'tool.interrupted',
    },
  ])(
    'uses the interrupt Tool recovery truth table for first startup: $name',
    async ({
      status,
      executionMode,
      dispatchState,
      effectState,
      expectedStatus,
      expectedEffectState,
      expectedEvent,
    }) => {
      runtime = createTempRuntime();
      const { database, fixture } = await createDirectActiveFixture(runtime);
      const toolRunId = insertRecoveredToolRun(database, fixture, {
        status,
        executionMode,
        dispatchState,
        effectState,
      });
      try {
        recoverStartupState(database, recoveryOptions());
        expect(
          database
            .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
            .get(toolRunId),
        ).toEqual({ status: expectedStatus, effect_state: expectedEffectState });
        expect(
          database
            .prepare(
              `SELECT type FROM session_events
               WHERE turn_id = ?
                 AND (type LIKE 'tool.%' OR type IN ('turn.interrupted', 'recovery.detected'))
               ORDER BY seq`,
            )
            .all(fixture.turnId),
        ).toEqual([
          { type: expectedEvent },
          { type: 'turn.interrupted' },
          { type: 'recovery.detected' },
        ]);
        const recoveredFacts = captureFacts(database);

        recoverStartupState(database, {
          daemonEpoch: LATER_DAEMON_EPOCH,
          createId: () => {
            throw new Error('Idempotent Tool recovery allocated an id');
          },
        });
        expect(captureFacts(database)).toBe(recoveredFacts);
      } finally {
        database.close();
      }
    },
  );

  it.each(workerActiveMatrixCases)(
    'enforces the active worker status matrix before first-startup writes: $name',
    async ({
      status,
      dispatchState,
      effectState,
      valid,
      expectedStatus,
      expectedEffectState,
    }) => {
      runtime = createTempRuntime();
      const { database, fixture } = await createDirectActiveFixture(runtime);
      const toolRunId = insertRecoveredToolRun(database, fixture, {
        status,
        executionMode: 'worker',
        dispatchState,
        effectState,
      });
      expect(
        database
          .prepare(
            `SELECT status, execution_mode AS executionMode,
                    dispatch_state AS dispatchState, effect_state AS effectState
             FROM tool_runs WHERE id = ?`,
          )
          .get(toolRunId),
      ).toEqual({ status, executionMode: 'worker', dispatchState, effectState });
      const before = captureFacts(database);
      let allocations = 0;
      try {
        if (!valid) {
          expect(() =>
            recoverStartupState(database, {
              ...recoveryOptions(),
              createId: () => `invalid-active-${String(++allocations)}`,
            }),
          ).toThrow(/invariant/i);
          expect(captureFacts(database)).toBe(before);
          expect(allocations).toBe(0);
          return;
        }

        recoverStartupState(database, recoveryOptions());
        expect(
          database
            .prepare('SELECT status, effect_state FROM tool_runs WHERE id = ?')
            .get(toolRunId),
        ).toEqual({ status: expectedStatus, effect_state: expectedEffectState });
      } finally {
        database.close();
      }
    },
  );

  it.each(terminalToolMatrixCases)(
    'validates the already-recovered terminal ToolRun matrix without writes: $name',
    async ({ status, executionMode, dispatchState, effectState, valid }) => {
      runtime = createTempRuntime();
      const { database, fixture } = await createDirectActiveFixture(runtime);
      try {
        recoverStartupState(database, recoveryOptions());
        insertRecoveredToolRun(database, fixture, {
          status,
          executionMode,
          dispatchState,
          effectState,
          finishedAt: RECOVERY_TIME,
        });
        expect(
          database
            .prepare(
              `SELECT status, execution_mode AS executionMode,
                      dispatch_state AS dispatchState, effect_state AS effectState,
                      finished_at AS finishedAt
               FROM tool_runs WHERE id = 'recovered-tool-run'`,
            )
            .get(),
        ).toEqual({ status, executionMode, dispatchState, effectState, finishedAt: RECOVERY_TIME });
        const before = captureFacts(database);
        let allocations = 0;
        const inspect = () =>
          recoverStartupState(database, {
            daemonEpoch: LATER_DAEMON_EPOCH,
            createId: () => `terminal-matrix-${String(++allocations)}`,
          });

        if (valid) {
          expect(inspect).not.toThrow();
        } else {
          expect(inspect).toThrow(/invariant/i);
        }
        expect(captureFacts(database)).toBe(before);
        expect(allocations).toBe(0);
      } finally {
        database.close();
      }
    },
  );

  it('accepts a complete recovered state even when a later Turn was enqueued', async () => {
    runtime = createTempRuntime();
    const { database, fixture } = await createDirectActiveFixture(runtime);
    try {
      recoverStartupState(database, recoveryOptions());
      new SessionService(database).enqueueTurn(
        { sessionId: fixture.sessionId, prompt: 'Queued after recovery' },
        'queued-after-recovery',
      );
      const before = captureFacts(database);

      recoverStartupState(database, {
        daemonEpoch: LATER_DAEMON_EPOCH,
        createId: () => {
          throw new Error('Complete recovered no-op allocated an id');
        },
      });

      expect(captureFacts(database)).toBe(before);
    } finally {
      database.close();
    }
  });

  it('accepts recovery episode history after active recovery markers were resolved', async () => {
    runtime = createTempRuntime();
    const database = await openRuntimeDatabase({ dataDir: runtime.dataDir });
    try {
      const service = new SessionService(database);
      const workspacePath = join(runtime.rootDir, 'resolved-history-workspace');
      mkdirSync(workspacePath);
      const workspace = service.registerWorkspace(
        { path: workspacePath },
        'resolved-history-workspace',
      );
      const created = service.createSession(
        {
          workspaceId: workspace.workspaceId,
          title: 'Resolved recovery history',
          prompt: 'Queued after a prior resolved episode',
        },
        'resolved-history-session',
      );
      database
        .prepare('UPDATE sessions SET recovery_episode = 3 WHERE id = ?')
        .run(created.sessionId);
      const before = captureFacts(database);

      recoverStartupState(database, { daemonEpoch: LATER_DAEMON_EPOCH });

      expect(captureFacts(database)).toBe(before);
    } finally {
      database.close();
    }
  });

  it('fails before recovering a valid active tuple when another recovered Session is corrupt', async () => {
    runtime = createTempRuntime();
    const { database, fixture: recoveredFixture } =
      await createDirectActiveFixture(runtime);
    try {
      recoverStartupState(database, recoveryOptions());
      const service = new SessionService(database);
      const workspacePath = join(runtime.rootDir, 'combined-active-workspace');
      mkdirSync(workspacePath);
      const workspace = service.registerWorkspace(
        { path: workspacePath },
        'combined-active-workspace',
      );
      const active = service.createSession(
        {
          workspaceId: workspace.workspaceId,
          title: 'Valid active beside corrupt recovery',
          prompt: 'Claim this Turn',
        },
        'combined-active-session',
      );
      expect(
        new Scheduler(database, {
          daemonEpoch: LATER_DAEMON_EPOCH,
          now: () => new Date('2026-07-14T09:10:00.000Z'),
          createId: createIdFactory(
            '018f0000-0000-7000-8000-000000000501',
            '018f0000-0000-7000-8000-000000000502',
          ),
        }).claimNext()?.turnId,
      ).toBe(active.turnId);
      database
        .prepare(
          "DELETE FROM session_events WHERE session_id = ? AND turn_id = ? AND type = 'recovery.detected'",
        )
        .run(recoveredFixture.sessionId, recoveredFixture.turnId);
      const before = captureFacts(database);

      expect(() =>
        recoverStartupState(database, {
          daemonEpoch: '018f0000-0000-7000-8000-000000000700',
          createId: createIdFactory(
            '018f0000-0000-7000-8000-000000000701',
            '018f0000-0000-7000-8000-000000000702',
          ),
        }),
      ).toThrow(/invariant/i);
      expect(captureFacts(database)).toBe(before);
    } finally {
      database.close();
    }
  });

  it('recovers a real claimed daemon after SIGKILL and stays idempotent across later starts', async () => {
    runtime = createTempRuntime();
    const fixture = await createClaimedDaemonFixture(runtime);
    expect(await fixture.daemon.stop('SIGKILL')).toEqual({
      code: null,
      signal: 'SIGKILL',
    });

    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();
    const replacementClient = await authenticatedClient(runtime, replacement);
    try {
      const response = await replacementClient.sendRequest({
        ...replacementClient.createRequest('session.getSnapshot', {
          sessionId: fixture.sessionId,
        }),
        sessionId: fixture.sessionId,
      });
      if (!response.ok) {
        throw new Error('session.getSnapshot failed after recovery');
      }
      const snapshot = SessionSnapshotSchema.parse(response.result);
      expect(snapshot.session).toMatchObject({
        id: fixture.sessionId,
        currentTurnId: null,
        runtimeStatus: 'recovering',
        queueBlockReason: 'recovery_review',
        recoveryEpisode: 1,
        recoverySourceTurnId: fixture.turnId,
      });
      expect(snapshot.turns).toEqual([
        expect.objectContaining({
          id: fixture.turnId,
          status: 'interrupted',
          executionFence: 2,
        }),
        expect.objectContaining({ id: fixture.queuedTurnId, status: 'queued' }),
      ]);
      expect(snapshot.events.slice(-2).map((event) => event.type)).toEqual([
        'turn.interrupted',
        'recovery.detected',
      ]);
    } finally {
      await replacementClient.close();
    }

    const inspection = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(inspection);
    let recoveredFacts: string;
    try {
      expect(
        inspection.prepare('SELECT daemon_epoch, status FROM runner_leases').all(),
      ).toEqual([{ daemon_epoch: fixture.daemonEpoch, status: 'expired' }]);
      expect(
        inspection.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'").get(),
      ).toEqual({ count: 0 });
      expect(inspection.pragma('foreign_key_check')).toEqual([]);
      recoveredFacts = captureFacts(inspection);
    } finally {
      inspection.close();
    }

    await replacement.stop();
    const third = runtime.spawnDaemon();
    await third.waitForReady();
    await third.stop();
    const afterThird = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(afterThird);
    try {
      expect(captureFacts(afterThird)).toBe(recoveredFacts);
      expect(afterThird.pragma('foreign_key_check')).toEqual([]);
    } finally {
      afterThird.close();
    }
  }, 20_000);

  it('rolls back a SIGKILL before recovery commit, then records one recovery pair only', async () => {
    runtime = createTempRuntime();
    const fixture = await createClaimedDaemonFixture(runtime);
    await fixture.daemon.stop('SIGKILL');

    const crashing = runtime.spawnDaemon({
      entryPoint: crashBeforeRecoveryCommitEntryPoint,
    });
    const crashExit = await crashing.waitForExit(5_000);
    expect(crashExit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(crashing.stdout).toContain('"event":"before_recovery_commit"');

    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();
    await replacement.stop();
    const inspection = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(inspection);
    let recoveredFacts: string;
    try {
      expect(
        inspection
          .prepare(
            "SELECT type FROM session_events WHERE type IN ('turn.interrupted', 'recovery.detected') ORDER BY seq",
          )
          .all(),
      ).toEqual([{ type: 'turn.interrupted' }, { type: 'recovery.detected' }]);
      recoveredFacts = captureFacts(inspection);
    } finally {
      inspection.close();
    }

    const third = runtime.spawnDaemon();
    await third.waitForReady();
    await third.stop();
    const afterThird = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(afterThird);
    try {
      expect(captureFacts(afterThird)).toBe(recoveredFacts);
    } finally {
      afterThird.close();
    }
  }, 20_000);

  it('keeps committed recovery when startup fails before listen, and the next start is a no-op', async () => {
    runtime = createTempRuntime();
    const fixture = await createClaimedDaemonFixture(runtime);
    await fixture.daemon.stop('SIGKILL');
    writeFileSync(runtime.alternateSocketPath, 'preserve-unsafe-boundary', {
      mode: 0o600,
    });
    const failingServer = new DaemonServer({
      socketPath: runtime.alternateSocketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: Buffer.alloc(32, 0x72),
    });

    await expect(failingServer.start()).rejects.toThrow(
      'Refusing to remove an unsafe pre-existing socket path',
    );
    expect(readFileSync(runtime.alternateSocketPath, 'utf8')).toBe(
      'preserve-unsafe-boundary',
    );
    const committed = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(committed);
    let committedFacts: string;
    try {
      committedFacts = captureFacts(committed);
      expect(
        committed.prepare("SELECT COUNT(*) AS count FROM turns WHERE status = 'interrupted'").get(),
      ).toEqual({ count: 1 });
    } finally {
      committed.close();
    }

    unlinkSync(runtime.alternateSocketPath);
    const replacement = runtime.spawnDaemon();
    await replacement.waitForReady();
    await replacement.stop();
    const afterReplacement = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(afterReplacement);
    try {
      expect(captureFacts(afterReplacement)).toBe(committedFacts);
    } finally {
      afterReplacement.close();
    }
  }, 20_000);

  it.each([
    {
      name: 'missing active Lease',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database.prepare('DELETE FROM runner_leases WHERE id = ?').run(fixture.leaseId);
      },
    },
    {
      name: 'multiple active Leases',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database.exec('DROP INDEX runner_leases_one_active_per_turn');
        database
          .prepare(
            `INSERT INTO runner_leases (
              id, daemon_epoch, lease_epoch, session_id, current_turn_id,
              status, heartbeat_at, lease_expires_at
            ) VALUES (?, ?, 2, ?, ?, 'active', ?, ?)`,
          )
          .run(
            '018f0000-0000-7000-8000-000000000399',
            OLD_DAEMON_EPOCH,
            fixture.sessionId,
            fixture.turnId,
            CLAIM_TIME,
            CLAIM_TIME,
          );
      },
    },
    {
      name: 'active Lease using the new daemon epoch',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare('UPDATE runner_leases SET daemon_epoch = ? WHERE id = ?')
          .run(NEW_DAEMON_EPOCH, fixture.leaseId);
      },
    },
    {
      name: 'missing scheduler slot',
      corrupt: (database: RuntimeDatabase) => {
        database.prepare('DELETE FROM scheduler_slots WHERE slot_no = 1').run();
      },
    },
    {
      name: 'free slot with active facts',
      corrupt: (database: RuntimeDatabase) => {
        database
          .prepare("UPDATE scheduler_slots SET state = 'free', owner_turn_id = NULL")
          .run();
      },
    },
    {
      name: 'slot owner pointing at the queued follower',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare('UPDATE scheduler_slots SET owner_turn_id = ? WHERE slot_no = 1')
          .run(fixture.queuedTurnId);
      },
    },
    {
      name: 'owned terminal Turn',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare("UPDATE turns SET status = 'succeeded', finished_at = ? WHERE id = ?")
          .run(RECOVERY_TIME, fixture.turnId);
      },
    },
    {
      name: 'missing Session current pointer',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare('UPDATE sessions SET current_turn_id = NULL WHERE id = ?')
          .run(fixture.sessionId);
      },
    },
    {
      name: 'mismatched Session runtime status',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare("UPDATE sessions SET runtime_status = 'queued' WHERE id = ?")
          .run(fixture.sessionId);
      },
    },
    {
      name: 'Lease pointing at the queued follower',
      corrupt: (database: RuntimeDatabase, fixture: ActiveFixture) => {
        database
          .prepare('UPDATE runner_leases SET current_turn_id = ? WHERE id = ?')
          .run(fixture.queuedTurnId, fixture.leaseId);
      },
    },
    {
      name: 'multiple active Turns across Sessions',
      corrupt: (
        database: RuntimeDatabase,
        fixture: ActiveFixture,
        currentRuntime: TempRuntime,
      ) => {
        const service = new SessionService(database);
        const workspacePath = join(currentRuntime.rootDir, 'corrupt-second-workspace');
        mkdirSync(workspacePath);
        const workspace = service.registerWorkspace(
          { path: workspacePath },
          'corrupt-second-workspace',
        );
        const second = service.createSession(
          {
            workspaceId: workspace.workspaceId,
            title: 'Second active',
            prompt: 'Second active prompt',
          },
          'corrupt-second-session',
        );
        database
          .prepare("UPDATE turns SET status = 'running', started_at = ? WHERE id = ?")
          .run(CLAIM_TIME, second.turnId);
        database
          .prepare(
            "UPDATE sessions SET runtime_status = 'running', current_turn_id = ? WHERE id = ?",
          )
          .run(second.turnId, second.sessionId);
        database
          .prepare(
            `INSERT INTO runner_leases (
              id, daemon_epoch, lease_epoch, session_id, current_turn_id,
              status, heartbeat_at, lease_expires_at
            ) VALUES (?, ?, 2, ?, ?, 'active', ?, ?)`,
          )
          .run(
            '018f0000-0000-7000-8000-000000000398',
            OLD_DAEMON_EPOCH,
            second.sessionId,
            second.turnId,
            CLAIM_TIME,
            CLAIM_TIME,
          );
        expect(fixture.turnId).not.toBe(second.turnId);
      },
    },
  ])('fails startup before socket and writes zero facts for $name', async ({ corrupt }) => {
    runtime = createTempRuntime();
    const { database, fixture } = await createDirectActiveFixture(runtime);
    corrupt(database, fixture, runtime);
    const before = captureFacts(database);
    database.close();
    const server = new DaemonServer({
      socketPath: runtime.socketPath,
      dataDir: runtime.dataDir,
      bootstrapSecret: Buffer.alloc(32, 0x73),
      createDaemonEpoch: () => NEW_DAEMON_EPOCH,
    });

    await expect(server.start()).rejects.toThrow(/invariant/i);
    expect(existsSync(runtime.socketPath)).toBe(false);
    const after = new Database(join(runtime.dataDir, 'runtime.sqlite3'));
    configureDatabase(after);
    try {
      expect(captureFacts(after)).toBe(before);
      expect(after.pragma('foreign_key_check')).toEqual([]);
    } finally {
      after.close();
    }
  });
});
