# Foundation Slice 2 Concurrency Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute two different Sessions concurrently, keep later work durably queued in same-Session FIFO order, support queued-only Turn cancellation, and expose the minimum multi-Session Web Console needed to operate it.

**Architecture:** SQLite remains the capacity and lifecycle authority through exactly two persistent scheduler slots. Runtime concurrency is tracked by immutable Claim identity rather than slot number or counters. Queued cancellation is a single idempotent database mutation, and the Web Console renders `session.list` plus authoritative Snapshots without adding live subscription or running cancellation.

**Tech Stack:** TypeScript 5.9, Node.js, better-sqlite3, Zod 4, Vitest 4, React 19, existing Unix-socket RPC and localhost HTTP bridge.

**Design:** `.agents/superpowers/specs/2026-07-17-slice-2-concurrency-design.md`

**Required methods:** @test-driven-development, @testing-anti-patterns when adding doubles, @verification-before-completion before every commit, and @requesting-code-review after each task.

---

## Test List

- migrate historical slot 1 to exact slots 1 and 2 without losing ownership;
- claim two different Sessions and leave a third durably queued;
- preserve same-Session FIFO and skip canceled ordinals;
- produce exactly two winners from three simultaneous claim contenders;
- terminalize one active tuple without touching the other;
- start two Drivers before either completion settles;
- isolate Runner start failure and late completion by immutable identity;
- wait for every pending/active run during shutdown;
- recover all active tuples in one batch or write nothing;
- list authoritative active Sessions with queued counts;
- cancel queued Turns atomically and idempotently;
- return a stable conflict when claim wins the cancel race;
- preserve queued facts across restart and authentication gates;
- bridge list/cancel through strict HTTP contracts;
- switch Sessions without stale response adoption;
- render independent queued cancel actions and mutually exclusive mobile drawers.

## Chunk 1: Persisted Capacity and Claims

### Task 1: Migrate to two slots and claim safely

**Files:**
- Create: `services/daemon/src/db/migrations/005_scheduler_two_slots.sql`
- Modify: `services/daemon/src/runtime/scheduler.ts`
- Modify: `services/daemon/src/runtime/startup-recovery.ts`
- Modify: `tests/integration/migrations.test.ts`
- Modify: `tests/integration/scheduler-claim.test.ts`
- Modify: `tests/fixtures/scheduler-claim-contender.ts`

- [ ] **Step 1: Write failing migration tests**

  Add cases that open a database at migration 4, then apply migration 5 and assert:

  ```ts
  expect(database.prepare(
    `SELECT slot_no, state, owner_turn_id, updated_at
     FROM scheduler_slots ORDER BY slot_no`,
  ).all()).toEqual([
    expect.objectContaining({ slot_no: 1 }),
    expect.objectContaining({ slot_no: 2, state: 'free', owner_turn_id: null }),
  ]);
  ```

  Add a fixture with an owned slot 1 before migration and prove its owner and timestamp are preserved. Inspect `sqlite_master.sql` and prove the final check accepts only 1 or 2.

- [ ] **Step 2: Run migration tests and verify RED**

  Run: `pnpm vitest run tests/integration/migrations.test.ts`

  Expected: FAIL because migration 5 is absent and the installed schema still permits only slot 1.

- [ ] **Step 3: Add the forward-only migration**

  Use this exact shape:

  ```sql
  ALTER TABLE scheduler_slots RENAME TO scheduler_slots_one_slot;

  CREATE TABLE scheduler_slots (
    slot_no INTEGER PRIMARY KEY CHECK (slot_no IN (1, 2)),
    state TEXT NOT NULL CHECK (state IN ('free', 'owned')),
    owner_turn_id TEXT UNIQUE REFERENCES turns(id),
    updated_at TEXT NOT NULL,
    CHECK (
      (state = 'free' AND owner_turn_id IS NULL)
      OR (state = 'owned' AND owner_turn_id IS NOT NULL)
    )
  );

  INSERT INTO scheduler_slots (slot_no, state, owner_turn_id, updated_at)
  SELECT slot_no, state, owner_turn_id, updated_at
  FROM scheduler_slots_one_slot;

  INSERT INTO scheduler_slots (slot_no, state, owner_turn_id, updated_at)
  VALUES (2, 'free', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  DROP TABLE scheduler_slots_one_slot;
  ```

- [ ] **Step 4: Verify the migration GREEN**

  Run: `pnpm vitest run tests/integration/migrations.test.ts`

  Expected: the real Daemon and isolated compiled package start successfully with two free slots; all migration tests PASS. `startup-recovery.ts` may be generalized only enough to accept exact slots 1/2 with zero active tuples while two-owned startup remains fail-closed until Task 5.

- [ ] **Step 5: Write failing two-slot Scheduler tests**

  Cover these exact behaviors:

  ```ts
  const first = scheduler.claimNext();
  const second = scheduler.claimNext();
  const third = scheduler.claimNext();

  expect([first?.slotNo, second?.slotNo]).toEqual([1, 2]);
  expect(new Set([first?.sessionId, second?.sessionId]).size).toBe(2);
  expect(third).toBeNull();
  ```

  Also assert:

  - the third Turn remains `queued`, `started_at = null`, `execution_fence = 0`;
  - it has no active Lease and no `turn.started` Event;
  - two Turns from one Session cannot occupy both slots;
  - after freeing slot 1 while slot 2 remains owned, the next Claim uses slot 1;
  - incomplete, duplicate, or cross-linked active tuples throw `SchedulerInvariantError` before writes;
  - three process contenders produce two Claims with distinct slots and Turns plus one null result.

- [ ] **Step 6: Run Scheduler tests and verify RED**

  Run: `pnpm vitest run tests/integration/scheduler-claim.test.ts`

  Expected: FAIL on the second Claim or exact slot-set assertions.

- [ ] **Step 7: Implement exact slot and tuple validation**

  In `scheduler.ts` introduce:

  ```ts
  const SLOT_NOS = [1, 2] as const;
  export type SlotNo = (typeof SLOT_NOS)[number];

  export interface Claim {
    readonly slotNo: SlotNo;
    readonly sessionId: string;
    readonly turnId: string;
    readonly leaseId: string;
    readonly daemonEpoch: string;
    readonly leaseEpoch: number;
    readonly executionFence: number;
  }
  ```

  Replace single-slot reads with an ordered `readSlots()` that requires exactly slot 1 and slot 2. Validate every owned slot against active Turns, Sessions, and Leases by Turn ID. Require all active fact counts to equal the owned-slot count and reject orphaned facts.

  Select the first free row by slot number. When both are owned, return null only after validating both complete tuples. Keep the existing candidate ordering and `NOT EXISTS` earlier queued predicate.

- [ ] **Step 8: Run Scheduler and restart-focused tests GREEN**

  Run:

  ```bash
  pnpm vitest run tests/integration/scheduler-claim.test.ts
  pnpm vitest run tests/integration/scheduler-restart.test.ts -t "slot|claim|recovered state"
  ```

  Expected: PASS.

- [ ] **Step 9: Commit**

  ```bash
  git add services/daemon/src/db/migrations/005_scheduler_two_slots.sql services/daemon/src/runtime/scheduler.ts services/daemon/src/runtime/startup-recovery.ts tests/integration/migrations.test.ts tests/integration/scheduler-claim.test.ts tests/fixtures/scheduler-claim-contender.ts
  git commit -m "feat: add durable two-slot scheduling"
  ```

## Chunk 2: Tuple Isolation and Runtime Fan-Out

### Task 2: Terminalize only the requested active tuple

**Files:**
- Modify: `services/daemon/src/db/execution-repository.ts`
- Modify: `services/daemon/src/runtime/turn-terminalizer.ts`
- Modify: `services/daemon/src/runtime/turn-terminalizer.test.ts`
- Modify: `tests/integration/scheduler-claim.test.ts`
- Modify: `tests/integration/runner-binding.test.ts`

- [ ] **Step 1: Write failing two-active-tuple terminalization tests**

  Build two complete Claims, terminalize only one, and assert:

  ```ts
  expect(readTuple(first.turnId)).toMatchObject({
    turnStatus: 'succeeded',
    leaseStatus: 'expired',
    slotState: 'free',
  });
  expect(readTuple(second.turnId)).toEqual(secondTupleBefore);
  ```

  Add fail-closed cases where the requested binding is valid but the other active tuple is corrupt. No target terminalization write may occur.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `pnpm vitest run services/daemon/src/runtime/turn-terminalizer.test.ts tests/integration/runner-binding.test.ts`

  Expected: FAIL because `ExecutionRepository` requires global active counts and slot count to equal one.

- [ ] **Step 3: Generalize active tuple validation without weakening it**

  Update `ExecutionRepository.readActiveTuple(binding)` to:

  - require exact slots 1 and 2;
  - read every active Turn, Session, Lease, and owned slot;
  - validate the global one-to-one mapping and count equality for `n ∈ [0, 2]`;
  - locate the requested tuple by full Claim fields;
  - reject a valid target when any other active tuple is corrupt;
  - return the requested tuple without assuming it is the only tuple.

  Keep all terminal write CAS predicates on the full binding. The slot update must include both `slot_no = binding.slotNo` and `owner_turn_id = binding.turnId`.

- [ ] **Step 4: Run focused tests GREEN**

  Run: `pnpm vitest run services/daemon/src/runtime/turn-terminalizer.test.ts tests/integration/runner-binding.test.ts tests/integration/scheduler-claim.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add services/daemon/src/db/execution-repository.ts services/daemon/src/runtime/turn-terminalizer.ts services/daemon/src/runtime/turn-terminalizer.test.ts tests/integration/scheduler-claim.test.ts tests/integration/runner-binding.test.ts
  git commit -m "fix: isolate active tuple terminalization"
  ```

### Task 3: Start and observe two executions concurrently

**Files:**
- Modify: `services/daemon/src/runtime/execution-coordinator.ts`
- Modify: `services/daemon/src/runtime/execution-coordinator.test.ts`
- Modify: `tests/integration/execution-wakeup.test.ts`

- [ ] **Step 1: Write failing Coordinator concurrency tests**

  Add a fake Driver whose first two `start()` calls return unresolved completions. Assert both calls occur before either completion resolves. Add cases for:

  - 100 notifications still use one drain loop;
  - first start rejection terminalizes only the first Claim while the second remains active;
  - a third Claim starts after one completion;
  - `quiesce()` prevents new Claims;
  - `join()` waits for every pending start and active completion.

- [ ] **Step 2: Run Coordinator tests and verify RED**

  Run: `pnpm vitest run services/daemon/src/runtime/execution-coordinator.test.ts`

  Expected: FAIL because `activeRunner` blocks the second Claim.

- [ ] **Step 3: Add immutable run identity and maps**

  Add a small local key helper:

  ```ts
  const executionKey = (claim: Claim): string =>
    `${claim.turnId}:${claim.leaseId}:${claim.executionFence}`;
  ```

  Replace `activeRunner` with:

  ```ts
  private readonly starting = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ExecutionRun>();
  ```

  `drain()` must repeatedly claim until null. For each Claim, register a start operation and continue claiming without awaiting Runner readiness. The start operation moves only its own key to `active`, observes its completion, and on rejection terminalizes only that binding. Every settle path deletes by key and object identity, marks the level dirty, and schedules another drain when running.

  `isJoined()` must require both maps to be empty in addition to the existing drain flags.

- [ ] **Step 4: Run unit and Daemon wakeup tests GREEN**

  Run:

  ```bash
  pnpm vitest run services/daemon/src/runtime/execution-coordinator.test.ts
  pnpm vitest run tests/integration/execution-wakeup.test.ts
  ```

  Expected: PASS and the overlap assertion proves both starts entered before either completion.

- [ ] **Step 5: Commit**

  ```bash
  git add services/daemon/src/runtime/execution-coordinator.ts services/daemon/src/runtime/execution-coordinator.test.ts tests/integration/execution-wakeup.test.ts
  git commit -m "feat: coordinate two concurrent executions"
  ```

### Task 4: Make Runner Driver identity-safe and fan in shutdown

**Files:**
- Modify: `services/daemon/src/runtime/runner-supervisor.ts`
- Modify: `services/daemon/src/server.ts`
- Modify: `tests/integration/runner-shutdown.test.ts`
- Modify: `tests/integration/runner-binding.test.ts`
- Modify: `tests/integration/runner-restart.test.ts`
- Modify: `tests/integration/execution-wakeup.test.ts`

- [ ] **Step 1: Write failing Driver map and shutdown tests**

  Test two starts with distinct run identities and assert both reach READY independently. Add a slot-reuse case where an old delayed completion settles after a newer execution using the same slot; the newer run must remain registered.

  Add shutdown ordering assertions:

  ```ts
  expect(events).toEqual([
    'fence:a', 'fence:b',
    'abort:a', 'abort:b',
    'kill:a', 'kill:b',
    'reaped:a', 'reaped:b',
    'terminalized:a', 'terminalized:b',
  ]);
  ```

  Exact inter-run ordering inside each phase may be sorted for deterministic assertion, but no terminalization may precede both reaps.

  Add a server-level cleanup assertion that listener/connection shutdown happens before Driver shutdown, while socket unlink, database close, and runtime-lock release happen only after Driver shutdown and Coordinator join.

- [ ] **Step 2: Run Driver tests and verify RED**

  Run: `pnpm vitest run tests/integration/runner-shutdown.test.ts tests/integration/runner-binding.test.ts tests/integration/runner-restart.test.ts`

  Expected: FAIL because the Driver has single `pendingStart` and `active` fields.

- [ ] **Step 3: Replace singleton fields with identity-keyed maps**

  Introduce `DriverPendingStart` and `DriverActiveRun` maps keyed by `turnId:leaseId:executionFence`.

  Requirements:

  - `start()` rejects duplicate identity but permits another identity;
  - `performStart()` clears only the exact pending object it registered;
  - `run()` clears only the exact active object it registered;
  - heartbeat and executor identity persistence retain full Claim CAS predicates;
  - each run owns its own model AbortController;
  - one start failure or process exit does not fence another run.

  Implement `performShutdown()` in phases:

  1. mark `shuttingDown`;
  2. fence all materialized executions;
  3. abort all model signals;
  4. kill all executions;
  5. `Promise.allSettled` all pending starts, process completions, and active loops;
  6. after fan-in, interrupt only runs lacking a committed terminal result;
  7. resolve each public completion and clear maps;
  8. rethrow the first material shutdown failure after cleanup.

  Preserve the server boundary in `server.ts`: quiesce first, close listener/control connections, await Driver shutdown, await Coordinator join, then unlink socket, close the database, and release the runtime lock.

- [ ] **Step 4: Run Driver and wakeup tests GREEN**

  Run:

  ```bash
  pnpm vitest run tests/integration/runner-shutdown.test.ts tests/integration/runner-binding.test.ts tests/integration/runner-restart.test.ts
  pnpm vitest run tests/integration/execution-wakeup.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add services/daemon/src/runtime/runner-supervisor.ts services/daemon/src/server.ts tests/integration/runner-shutdown.test.ts tests/integration/runner-binding.test.ts tests/integration/runner-restart.test.ts tests/integration/execution-wakeup.test.ts
  git commit -m "feat: supervise concurrent runner identities"
  ```

## Chunk 3: Honest Recovery

### Task 5: Recover active tuples as one validated batch

**Files:**
- Modify: `services/daemon/src/runtime/startup-recovery.ts`
- Modify: `services/daemon/src/runtime/turn-terminalizer.ts`
- Modify: `services/daemon/src/runtime/turn-terminalizer.test.ts`
- Modify: `tests/integration/scheduler-restart.test.ts`
- Modify: `services/daemon/src/runtime/execution-recovery.test.ts`

- [ ] **Step 1: Write failing multi-tuple recovery tests**

  Add fixtures for two valid active tuples and assert both are interrupted in one startup recovery episode. Add cases where:

  - tuple A is valid and tuple B is corrupt;
  - tuple A executor is exited and tuple B executor is ambiguous;
  - a hook throws before batch commit;
  - a recovery write for the second tuple fails.

  Every failure case must assert zero recovery writes for both tuples.

- [ ] **Step 2: Run recovery tests and verify RED**

  Run: `pnpm vitest run tests/integration/scheduler-restart.test.ts services/daemon/src/runtime/execution-recovery.test.ts`

  Expected: FAIL because startup recovery models one active inspection/write path.

- [ ] **Step 3: Split recovery into inspect, prove, and batch phases**

  Refactor startup recovery to produce an immutable array of validated recovery inputs sorted by slot number.

  Add `TurnTerminalizer.interruptMany(inputs)` as the transaction-owning batch API. Extract the current interruption writes into a private `interruptWithinTransaction(input)` that requires `database.inTransaction === true`. Keep `interrupt(input)` as `interruptMany([input])` so normal shutdown and startup recovery share one implementation.

  Phase requirements:

  ```ts
  const inspections = inspectAllActiveState(database);
  for (const inspection of inspections) {
    assertExecutorExited(inspectPersistedExecutor(inspection.identity));
  }
  terminalizer.interruptMany(
    inspections.map((inspection) => ({
      binding: inspection.binding,
      reason: inspection.reason,
      executorExited: true,
      resolutions: inspection.resolutions,
    })),
  );
  ```

  `inspectAllActiveState` must validate the exact slot set and every active tuple before returning. No recovery write may occur in the first two phases. `interruptMany` must revalidate the full expected set before its first write, then perform all writes in one immediate transaction. A hook failure during the second tuple rolls back the first tuple as well.

- [ ] **Step 4: Run recovery tests GREEN**

  Run: `pnpm vitest run tests/integration/scheduler-restart.test.ts services/daemon/src/runtime/execution-recovery.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add services/daemon/src/runtime/startup-recovery.ts services/daemon/src/runtime/turn-terminalizer.ts services/daemon/src/runtime/turn-terminalizer.test.ts tests/integration/scheduler-restart.test.ts services/daemon/src/runtime/execution-recovery.test.ts
  git commit -m "fix: recover executions as one validated batch"
  ```

## Chunk 4: Session Reads and Queued Cancellation

### Task 6: Add strict protocol, repository, and RPC contracts

**Files:**
- Modify: `packages/protocol/src/rpc.ts`
- Modify: `packages/protocol/src/rpc.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `services/daemon/src/db/errors.ts`
- Modify: `services/daemon/src/db/session-repository.ts`
- Modify: `services/daemon/src/db/session-repository.test.ts`
- Modify: `services/daemon/src/runtime/session-service.ts`
- Modify: `services/daemon/src/runtime/session-service.test.ts`
- Modify: `services/daemon/src/rpc/router.ts`
- Modify: `tests/integration/mutation-idempotency.test.ts`
- Modify: `tests/integration/daemon-auth.test.ts`
- Create: `tests/fixtures/turn-cancel-contender.ts`

- [ ] **Step 1: Write failing protocol tests**

  Add exact schemas:

  ```ts
  SessionSummarySchema = z.object({
    id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    runtimeStatus: SessionRuntimeStatusSchema,
    currentTurnId: NonEmptyStringSchema.nullable(),
    queuedTurnCount: NonNegativeIntegerSchema,
    updatedAt: NonEmptyStringSchema,
  }).strict();

  SessionListPayloadSchema = z.object({}).strict();
  SessionListResultSchema = z.object({
    sessions: z.array(SessionSummarySchema),
  }).strict();

  TurnCancelPayloadSchema = z.object({
    sessionId: NonEmptyStringSchema,
    turnId: NonEmptyStringSchema,
  }).strict();

  TurnCancelResultSchema = z.object({
    turnId: NonEmptyStringSchema,
    status: z.literal('canceled'),
  }).strict();
  ```

  `session.list` is unscoped/read-only. `turn.cancel` is Session-scoped, requires a client request ID, requires the top-level Session ID to match the payload, and requires the top-level Turn ID to remain null.

- [ ] **Step 2: Run protocol tests and verify RED**

  Run: `pnpm vitest run packages/protocol/src/rpc.test.ts`

  Expected: FAIL because the methods and exports are missing.

- [ ] **Step 3: Implement and export the protocol schemas**

  Add both methods to `RpcMethodSchema`, method-specific request schemas, `RpcRequestSchema`, result exports, and package exports. Keep all schemas strict.

- [ ] **Step 4: Run protocol tests GREEN**

  Run: `pnpm vitest run packages/protocol/src/rpc.test.ts`

  Expected: PASS.

- [ ] **Step 5: Write failing repository and idempotency tests**

  Cover:

  - `session.list` returns only active-lifecycle Sessions in `updated_at DESC, id DESC` order;
  - `queuedTurnCount` counts normal queued Turns behind a running Turn;
  - queued cancel writes `canceled`, `finished_at`, one Event, one Session revision/sequence increment, and one idempotency result atomically;
  - cancel leaves `started_at`, `execution_fence`, Leases, slots, model calls, and tool runs unchanged;
  - same request ID replays the exact result;
  - a different request ID for an already canceled Turn returns success without another Event;
  - same request ID with a different target returns `IDEMPOTENCY_CONFLICT`;
  - running or other terminal status returns `TURN_NOT_CANCELLABLE` with zero writes;
  - canceling ordinal 2 keeps ordinal 3 unchanged and eligible after ordinal 1 completes;
  - a recovery-blocked Session stays `recovering` and keeps `queue_block_reason = recovery_review` when cancel leaves other queued Turns and when it leaves none;
  - a real cancel/claim race produces exactly one legal winner and no mixed facts;
  - transaction failure rolls back Turn, Event, Session, and idempotency facts.

  For the race, create `tests/fixtures/turn-cancel-contender.ts` matching the existing Scheduler contender protocol. Launch the Scheduler and cancel contenders against the same SQLite file behind one stdin barrier. Accept only:

  ```text
  cancel wins: Turn=canceled, Scheduler=null, no Lease/start Event/fence
  claim wins:  Turn=running, cancel=TURN_NOT_CANCELLABLE, one Lease/start Event/fence=1
  ```

  Reject every other projection, including both success, both failure, duplicate Events, or an owned slot for a canceled Turn.

- [ ] **Step 6: Run repository/service tests and verify RED**

  Run:

  ```bash
  pnpm vitest run services/daemon/src/db/session-repository.test.ts services/daemon/src/runtime/session-service.test.ts
  pnpm vitest run tests/integration/mutation-idempotency.test.ts -t "cancel|session.list"
  ```

  Expected: FAIL because list/cancel APIs and domain errors are absent.

- [ ] **Step 7: Implement Session list and queued cancel transaction**

  Add domain errors:

  - `TURN_NOT_FOUND`;
  - `TURN_NOT_CANCELLABLE` with non-retryable validation semantics.

  Add `SessionRepository.listSessions()` using one grouped query over active Sessions and queued normal Turns. Add `cancelQueuedTurn()` that performs the queued CAS, inserts `turn.canceled`, and recomputes runtime status:

  ```sql
  CASE
    WHEN queue_block_reason = 'recovery_review' THEN 'recovering'
    WHEN current_turn_id IS NOT NULL THEN runtime_status
    WHEN EXISTS (
      SELECT 1 FROM turns
      WHERE session_id = sessions.id AND status = 'queued' AND queue_kind = 'normal'
    ) THEN 'queued'
    ELSE 'idle'
  END
  ```

  Extend `MutationMethod` with `turn.cancel`. Use the existing `mutate()` immediate transaction so the idempotency result commits with all state changes. Treat already canceled as a successful no-op only after proving exactly one matching cancel Event exists.

  Route `session.list` without notifying the scheduler. Route `turn.cancel` and notify after commit so a canceled Session head cannot leave capacity stale.

- [ ] **Step 8: Verify service, integration, and auth GREEN**

  Run:

  ```bash
  pnpm vitest run packages/protocol/src/rpc.test.ts
  pnpm vitest run services/daemon/src/db/session-repository.test.ts services/daemon/src/runtime/session-service.test.ts
  pnpm vitest run tests/integration/mutation-idempotency.test.ts tests/integration/daemon-auth.test.ts tests/integration/scheduler-claim.test.ts
  ```

  Expected: PASS.

- [ ] **Step 9: Commit**

  ```bash
  git add packages/protocol/src/rpc.ts packages/protocol/src/rpc.test.ts packages/protocol/src/index.ts services/daemon/src/db/errors.ts services/daemon/src/db/session-repository.ts services/daemon/src/db/session-repository.test.ts services/daemon/src/runtime/session-service.ts services/daemon/src/runtime/session-service.test.ts services/daemon/src/rpc/router.ts tests/integration/mutation-idempotency.test.ts tests/integration/daemon-auth.test.ts tests/fixtures/turn-cancel-contender.ts
  git commit -m "feat: list sessions and cancel queued turns"
  ```

## Chunk 5: HTTP and Browser Operations

### Task 7: Bridge list and cancel through the localhost API

**Files:**
- Modify: `apps/web-console/src/shared/contracts.ts`
- Modify: `apps/web-console/src/shared/contracts.test.ts`
- Modify: `apps/web-console/src/server/daemon-rpc-client.ts`
- Modify: `apps/web-console/src/server/daemon-rpc-client.test.ts`
- Modify: `apps/web-console/src/server/rpc-controller.ts`
- Modify: `apps/web-console/src/server/rpc-controller.test.ts`
- Modify: `apps/web-console/src/server/http-api.ts`
- Modify: `apps/web-console/src/server/http-api.test.ts`
- Modify: `apps/web-console/src/client/api.ts`
- Modify: `apps/web-console/src/client/api.test.ts`

- [ ] **Step 1: Write failing strict contract and route tests**

  Add HTTP schemas for `{ sessions }`, cancel submission `{ submissionId }`, and cancel response `{ turnId, status: 'canceled' }`.

  Assert:

  - `GET /api/sessions` sends an authenticated `session.list` request;
  - `POST /api/sessions/:sessionId/turns/:turnId/cancel` maps `submissionId` to `clientRequestId`;
  - a retry operation reuses the same submission ID;
  - `TURN_NOT_CANCELLABLE` maps to HTTP 409 and retains its stable public code;
  - missing Session/Turn maps to 404;
  - malformed paths, bodies, extra fields, wrong Origin, and missing CSRF are rejected before RPC.

- [ ] **Step 2: Run HTTP/client tests and verify RED**

  Run:

  ```bash
  pnpm vitest run apps/web-console/src/shared/contracts.test.ts apps/web-console/src/server/daemon-rpc-client.test.ts apps/web-console/src/server/rpc-controller.test.ts apps/web-console/src/server/http-api.test.ts apps/web-console/src/client/api.test.ts
  ```

  Expected: FAIL because list/cancel methods and routes do not exist.

- [ ] **Step 3: Implement RPC client, controller, HTTP, and browser methods**

  Extend `ApiClient` with:

  ```ts
  listSessions(): Promise<SessionListResult>;
  cancelTurn(
    sessionId: string,
    turnId: string,
    submission: TurnCancelSubmission,
  ): Promise<TurnCancelResult>;
  createCancelTurnOperation(
    sessionId: string,
    turnId: string,
  ): MutationOperation<TurnCancelResult>;
  ```

  Generalize the POST body helper to accept the exact three mutation submission schemas, not `unknown`. Encode both path parameters independently.

  Preserve the current Host/Origin/CSRF and sanitized error behavior.

- [ ] **Step 4: Run HTTP/client tests GREEN**

  Run:

  ```bash
  pnpm vitest run apps/web-console/src/shared/contracts.test.ts apps/web-console/src/server/daemon-rpc-client.test.ts apps/web-console/src/server/rpc-controller.test.ts apps/web-console/src/server/http-api.test.ts apps/web-console/src/client/api.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web-console/src/shared/contracts.ts apps/web-console/src/shared/contracts.test.ts apps/web-console/src/server/daemon-rpc-client.ts apps/web-console/src/server/daemon-rpc-client.test.ts apps/web-console/src/server/rpc-controller.ts apps/web-console/src/server/rpc-controller.test.ts apps/web-console/src/server/http-api.ts apps/web-console/src/server/http-api.test.ts apps/web-console/src/client/api.ts apps/web-console/src/client/api.test.ts
  git commit -m "feat: bridge session list and queued cancel"
  ```

## Chunk 6: Multi-Session Web Console

### Task 8: Add Session navigation, switching, and queued cancel UI

**Files:**
- Create: `apps/web-console/src/client/components/SessionList.tsx`
- Modify: `apps/web-console/src/client/App.tsx`
- Modify: `apps/web-console/src/client/App.test.tsx`
- Modify: `apps/web-console/src/client/view-model.ts`
- Modify: `apps/web-console/src/client/view-model.test.ts`
- Modify: `apps/web-console/src/client/components/NavigationRail.tsx`
- Modify: `apps/web-console/src/client/components/SessionHeader.tsx`
- Modify: `apps/web-console/src/client/components/Timeline.tsx`
- Modify: `apps/web-console/src/client/components/Inspector.tsx`
- Modify: `apps/web-console/src/client/styles.css`
- Modify: `apps/web-console/src/client/styles.test.ts`

- [ ] **Step 1: Write failing Session list and stale-switch tests**

  In `App.test.tsx`, assert:

  - `2 running · 1 queued` from Session runtime statuses;
  - `Running · 2 queued` for one running Session with two queued Turns;
  - all active Sessions remain visible while another Session is selected;
  - rapid A → B → C selection adopts only C's Snapshot;
  - selection does not call enqueue or cancel;
  - `New task` shows the empty composer without removing running Sessions;
  - list initial load, empty, first failure, and stale-refresh failure use exactly `Loading Sessions…`, `No Sessions yet.`, `Start a task to create one.`, `Couldn’t load Sessions.`, and `Couldn’t refresh Sessions.`;
  - localStorage stores only the selected Session ID.
  - an unselected running Session changes to idle in navigation after list polling, without selecting it;
  - Session list polling uses `activeMs` while any Session is active and `idleMs` otherwise;
  - Session create, Turn enqueue, cancel success, and cancel conflict each trigger a list refresh.

- [ ] **Step 2: Write failing queued cancel and drawer tests**

  Assert:

  - only queued Turn cards render `Cancel queued turn`;
  - inspect and cancel are sibling buttons with no nested button;
  - each queued Turn owns an independent mutation operation;
  - retry reuses the same operation;
  - success refreshes Snapshot and leaves a `Canceled before start.` card;
  - 409 refreshes Snapshot and shows `This turn started before it could be canceled.`;
  - disconnected runtime disables cancel with `Reconnect to cancel this queued turn.`;
  - below 820 px, opening Sessions closes Inspector and vice versa;
  - Escape/backdrop restores focus and only one drawer/backdrop exists.

- [ ] **Step 3: Run client tests and verify RED**

  Run:

  ```bash
  pnpm vitest run apps/web-console/src/client/view-model.test.ts apps/web-console/src/client/App.test.tsx apps/web-console/src/client/styles.test.ts
  ```

  Expected: FAIL because the client supports only one current Session and Timeline cards are whole-card buttons.

- [ ] **Step 4: Implement authoritative Session list state**

  In `App.tsx` add:

  - immediate Session list load after Runtime bootstrap;
  - Session list polling using `activeMs` while any listed Session is queued/running/canceling/recovering, otherwise `idleMs`;
  - `selectedSessionId` separate from the currently adopted Snapshot;
  - a monotonically increasing selection generation or AbortController so stale Snapshot/Event responses cannot cross Session boundaries;
  - one `activeDrawer: 'sessions' | 'inspector' | null` below 820 px;
  - a `Map<turnId, CancelMutationState>` so canceling one Turn does not block another.

  Refresh the Session list after session creation, Turn enqueue, cancel success/conflict, and normal polling. Keep the last good list when refresh fails.

- [ ] **Step 5: Implement reusable Session list and responsive drawer**

  `SessionList.tsx` receives summaries, selected ID, status override, loading/error state, and selection callback. Render textual statuses and `aria-current="page"`.

  `NavigationRail.tsx` renders the desktop list and a mobile Sessions trigger. On narrow screens the drawer reuses `SessionList`, traps focus, closes on Escape/backdrop, and restores focus to its trigger.

  `SessionHeader` must keep runtime status visible below 820 px even though other metadata stays hidden.

- [ ] **Step 6: Split Timeline inspection from queued actions**

  Change each Timeline item from a single outer button to a non-button card containing:

  - an inspect button;
  - an action region;
  - `Cancel queued turn` only when the authoritative Turn status is queued;
  - pending/error/conflict copy scoped to that Turn.

  Extend `view-model.ts` so `turn.canceled` and canceled Turn fallback projection produce a stable canceled card with `Canceled before start.`.

  Use these additional literal states so tests do not invent copy: `Loading Session…`, `Couldn’t open this Session.`, `Try again`, `Couldn’t cancel this queued turn.`, and `This turn started before it could be canceled.`.

- [ ] **Step 7: Run client tests GREEN**

  Run:

  ```bash
  pnpm vitest run apps/web-console/src/client/view-model.test.ts apps/web-console/src/client/App.test.tsx apps/web-console/src/client/styles.test.ts
  pnpm --filter @agent-workbench/web-console typecheck
  ```

  Expected: PASS.

- [ ] **Step 8: Commit**

  ```bash
  git add apps/web-console/src/client/components/SessionList.tsx apps/web-console/src/client/App.tsx apps/web-console/src/client/App.test.tsx apps/web-console/src/client/view-model.ts apps/web-console/src/client/view-model.test.ts apps/web-console/src/client/components/NavigationRail.tsx apps/web-console/src/client/components/SessionHeader.tsx apps/web-console/src/client/components/Timeline.tsx apps/web-console/src/client/components/Inspector.tsx apps/web-console/src/client/styles.css apps/web-console/src/client/styles.test.ts
  git commit -m "feat: operate concurrent sessions in web console"
  ```

## Chunk 7: Restart, Full Verification, and Demo

### Task 9: Prove persistence, authentication, and complete delivery

**Files:**
- Modify: `tests/integration/scheduler-restart.test.ts`
- Modify: `tests/integration/session-persistence.test.ts`
- Modify: `tests/integration/web-console-runtime.test.ts`
- Modify: `tests/integration/web-console-shutdown.test.ts`
- Modify: `docs/development/web-console-demo.md`

- [ ] **Step 1: Add final failing integration scenarios**

  Add process-level proof that:

  - Session A owns A1/A2/A3 at ordinals 1/2/3; Session B owns B1 at ordinal 1; Session C owns C1 at ordinal 1; A1, B1, and C1 are created in that queue order, then A2/A3 are enqueued; all five preserve Turn IDs, ordinals, queued timestamps, Messages, and queued Events across SIGKILL/restart;
  - no work starts before a control client authenticates;
  - after authentication, A1 and B1 start, while C1, A2, and A3 stay queued with same-Session FIFO intact;
  - queued cancel persists across restart and never creates Runner/Lease/start facts;
  - Web Console shutdown reaps two concurrent Runner processes before Daemon/database exit.

- [ ] **Step 2: Run final integration scenarios and verify RED if any gap remains**

  Run:

  ```bash
  pnpm vitest run tests/integration/scheduler-restart.test.ts tests/integration/session-persistence.test.ts tests/integration/web-console-runtime.test.ts tests/integration/web-console-shutdown.test.ts
  ```

  Expected: any remaining lifecycle gap fails before documentation or delivery claims.

- [ ] **Step 3: Make only the minimum fixes required by those tests**

  Do not add running cancellation, subscription, recovery UI, or configurable concurrency. Update demo documentation with:

  - how to create three Sessions;
  - how to observe two running and one queued;
  - how to switch Sessions without stopping work;
  - how to cancel a queued Turn;
  - the explicit limitation that running Turns cannot be canceled in this slice.

- [ ] **Step 4: Run the complete verification gate**

  Run fresh, in order:

  ```bash
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm build
  git status --short
  ```

  Expected:

  - all tests pass with zero failures;
  - typecheck, lint, and build exit 0;
  - only intentional source/spec changes are present;
  - `framework_blueprint.md` is absent from this worktree and never staged.

- [ ] **Step 5: Run the local demonstration**

  Start the Web Console from this worktree using the existing local provider configuration without printing or persisting secrets:

  ```bash
  pnpm demo:web
  ```

  Verify in the browser:

  - Session navigation is usable at desktop and 390 px width;
  - two real Sessions overlap when the provider latency permits;
  - a third Session/Turn remains queued;
  - queued cancel updates the authoritative Timeline;
  - switching Sessions does not stop the other task.

- [ ] **Step 6: Commit final integration and docs**

  ```bash
  git add tests/integration/scheduler-restart.test.ts tests/integration/session-persistence.test.ts tests/integration/web-console-runtime.test.ts tests/integration/web-console-shutdown.test.ts docs/development/web-console-demo.md
  git commit -m "test: verify slice two concurrency lifecycle"
  ```

- [ ] **Step 7: Request final review and prepare stacked delivery**

  Request an independent full-branch review against the design and this plan. Fix all material findings, rerun the complete verification gate, then push `codex/slice-2-concurrency` and open a Draft PR targeting `codex/web-ui-preview`, not `main`.
