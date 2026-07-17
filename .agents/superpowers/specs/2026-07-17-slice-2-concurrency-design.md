# Foundation Slice 2 Concurrency Design

Status: design review fixes applied
Date: 2026-07-17

## Goal

Make the current local runtime visibly and durably execute two different Sessions at once, keep additional work persisted in FIFO order, and let the user cancel only Turns that have not started.

The design preserves the current authority model: SQLite owns execution truth, the Daemon owns scheduling, and the Web Console only renders protocol state.

## Scope

Included:

- exactly two persistent scheduler slots;
- at most two active Turns, from different Sessions;
- a third eligible Session remains durably queued until capacity is released;
- one active Turn per Session and strict same-Session Turn FIFO;
- atomic, idempotent cancellation of a queued Turn;
- `session.list` and the minimum Web Console navigation needed to operate concurrent Sessions;
- a queued Turn action that is independent from Timeline inspection;
- a narrow-screen Session drawer mutually exclusive with the Inspector drawer.

Excluded:

- cancellation of a running Turn;
- provider HTTP abort or a new cancellation transport;
- live Event subscription;
- `waiting_for_user` behavior;
- recovery/quarantine UI;
- visual redesign;
- configurable or dynamically scaled concurrency.

## First-Principles Decisions

1. **Concurrency is a persisted ownership fact, not an in-memory counter.** Two rows in `scheduler_slots` are the capacity boundary. In-memory maps observe executions but never grant capacity.
2. **A Session is the serialization boundary.** Different Sessions may run concurrently; Turns inside one Session never overlap.
3. **A queued Turn has had no execution side effect.** Canceling it changes only durable queue state and Session Events. It never creates a Lease, increments an execution fence, starts a Runner, or emits `turn.started`.
4. **A run is identified by immutable execution identity.** Slot numbers are reusable. The identity used by the Coordinator and Driver is `turnId + leaseId + executionFence`.
5. **Recovery is all-or-nothing.** Startup validates all active tuples and all persisted executor identities before writing any recovery state.
6. **The UI never infers runtime truth.** Session status, queued counts, Turn status, and cancellation results come from the Daemon.

## Persistent Invariants

The valid slot set is exactly `{1, 2}`.

Let `n` be the number of owned slots. Then `n` is in `[0, 2]`, and all of the following counts equal `n`:

- Turns with status `running` or `cancel_requested`;
- Sessions with a non-null `current_turn_id` or runtime status `running`/`canceling`;
- active Runner Leases;
- owned scheduler slots.

For every owned slot there is exactly one tuple:

```text
owned scheduler slot
  ↔ active Turn
  ↔ Session.current_turn_id
  ↔ active Runner Lease
```

Tuple requirements:

- all four facts refer to the same Turn and Session;
- the active Turn has `queue_kind = normal`, `started_at != null`, `finished_at = null`, no terminal error/result fields, and `execution_fence > 0`;
- the Session has no queue block reason and its runtime status matches the Turn status;
- the Lease belongs to the current Daemon epoch during normal scheduling;
- active Sessions are unique, enforced by `turns_one_active_per_session` and checked explicitly;
- slot ownership is unique by `owner_turn_id`.

Any missing, duplicate, orphaned, or cross-linked fact fails closed before a claim or terminalization write.

## Migration

Add `services/daemon/src/db/migrations/005_scheduler_two_slots.sql`.

The migration runs inside the existing migration transaction and must:

1. rename the historical `scheduler_slots` table;
2. create the final table with `CHECK (slot_no IN (1, 2))` and all existing state, owner, uniqueness, and foreign-key constraints;
3. copy slot 1 without changing its state, owner, or timestamp;
4. insert slot 2 as free;
5. drop the historical table.

Historical migrations remain unchanged. Preserving an owned slot 1 is required because migration may precede crash recovery.

## Scheduler Claim

`Claim.slotNo` becomes `1 | 2`.

`Scheduler.claimNext()` remains one immediate SQLite transaction:

1. read and validate the exact slot set and every active tuple;
2. choose the lowest free slot;
3. choose the globally earliest eligible Session head;
4. CAS the selected slot, Turn, and Session;
5. insert one active Lease;
6. insert one `turn.started` Event containing the selected slot;
7. return the immutable Claim.

The candidate query remains ordered by `queued_at`, Session ID, ordinal, and Turn ID. A candidate is eligible only when:

- the Turn is `queued` and normal;
- the Session has no active Turn or block reason;
- no earlier Turn in that Session is still `queued`.

Canceled ordinals remain in history but do not block a later queued ordinal.

Three simultaneous claim contenders with two free slots must produce exactly two distinct Claims and one null result.

## Execution Identity and Coordinator

Define one canonical key function over:

```ts
type RunIdentity = Readonly<{
  turnId: string;
  leaseId: string;
  executionFence: number;
}>;
```

`ExecutionCoordinator` replaces `activeRunner: boolean` with identity-keyed `starting` and `active` maps.

Drain behavior:

1. pass the existing dependency and authentication gates;
2. repeatedly call `claimNext()` until it returns null;
3. register each Claim in `starting` before calling the Driver;
4. start each claimed execution asynchronously rather than awaiting the previous Runner's readiness;
5. move only the matching identity from `starting` to `active`;
6. on start failure, terminalize only that Claim and notify capacity again;
7. on completion, delete only the exact identity and notify capacity again.

A late completion from an old execution cannot delete a newer execution that reused the same slot.

`join()` resolves only after quiesce and after the scheduled drain, active drain, all starts, and all completions have settled.

## Runner Execution Driver

`RunnerExecutionDriver` replaces its single pending and active fields with maps keyed by immutable run identity.

Rules:

- duplicate start of the same identity is rejected;
- slot number is never used as a map key;
- heartbeat, executor identity persistence, model/tool handling, and terminalization continue to use the full Claim as their persisted fence;
- cleanup deletes a map entry only when the stored object is the same run instance;
- one Runner start failure, exit, or terminal commit never fences or removes another run;
- a freed slot may be reused while another Runner remains active.

No new provider cancellation API is introduced.

## Terminalization

`ExecutionRepository` validates the requested binding and the global two-slot invariant, rather than requiring global counts to equal one.

A successful, failed, interrupted, or start-failed terminalization changes only the target tuple:

- target Turn becomes terminal;
- target Session projection advances to `queued` when another queued Turn exists, otherwise `idle`;
- target Lease expires;
- target slot becomes free;
- target terminal Event is appended.

The other active tuple must remain byte-for-byte unchanged except for unrelated timestamps produced by its own execution.

## Startup Recovery

Startup recovery has three phases:

1. **Read and validate:** inspect the exact slot set, all active tuples, all active subexecutions, all recovery markers, and all persisted executor identities without writing.
2. **Prove executors exited:** inspect every persisted executor. Any `live` or `ambiguous` identity blocks all recovery writes.
3. **Batch recover:** in one immediate transaction, revalidate the same complete set and interrupt every recoverable active tuple.

The implementation must not recover tuples one by one while other tuples are still unvalidated. Any validation, executor inspection, hook, or write failure leaves zero recovery writes.

`TurnTerminalizer` provides a batch interruption entry point that owns one outer immediate transaction and performs every tuple's interruption within it. The existing single-turn interrupt path delegates to the same internal write routine with a one-element batch; startup recovery never opens nested terminalizer transactions.

## Shutdown

Shutdown order is:

1. quiesce the Coordinator so no new claim can occur;
2. stop accepting RPC and destroy existing control connections so no new mutation enters shutdown;
3. fence every pending and active run;
4. abort each local model signal;
5. send termination to every executor;
6. fan in all pending starts, process completions, and run loops with `Promise.allSettled`;
7. after every executor is reaped, terminalize any run that did not commit a terminal result;
8. join the Coordinator;
9. unlink the socket, close the database, and release the runtime lock in the existing server order.

No slot is released while its executor may still write.

## `session.list` Contract

Add an authenticated, unscoped read method:

```ts
type SessionListPayload = Record<string, never>;

type SessionSummary = Readonly<{
  id: string;
  title: string;
  runtimeStatus: SessionRuntimeStatus;
  currentTurnId: string | null;
  queuedTurnCount: number;
  updatedAt: string;
}>;

type SessionListResult = Readonly<{
  sessions: readonly SessionSummary[];
}>;
```

Only active-lifecycle Sessions are returned. Ordering is `updated_at DESC, id DESC`. `queuedTurnCount` counts queued normal Turns in that Session, including queued Turns behind a running Turn.

The method uses `sessionId = null`, `turnId = null`, and `clientRequestId = null`.

## `turn.cancel` Contract

Add an authenticated, Session-scoped mutation:

```ts
type TurnCancelPayload = Readonly<{
  sessionId: string;
  turnId: string;
}>;

type TurnCancelResult = Readonly<{
  turnId: string;
  status: 'canceled';
}>;
```

The top-level Session ID must match the payload, and the top-level Turn ID remains null because this is a Session-scoped RPC carrying the target Turn in its payload. A non-empty `clientRequestId` is required.

The repository transaction performs:

1. verify the Session exists;
2. verify the Turn exists inside that Session;
3. if already canceled, verify exactly one `turn.canceled` Event and return success without another Event;
4. otherwise CAS `queued → canceled`, setting `finished_at` and leaving execution fields untouched;
5. append exactly one `turn.canceled` Event with actor `daemon`, audience `both`, and payload `{ ordinal, queueKind: 'normal' }`;
6. increment Session event sequence and revision;
7. recompute Session runtime projection with recovery blocks taking precedence: when `queue_block_reason = 'recovery_review'`, preserve `runtime_status = 'recovering'`; otherwise derive `running`/`queued`/`idle` from `current_turn_id` and remaining queued Turns;
8. commit the idempotency result in the same immediate transaction.

Stable failures:

- missing Session: `SESSION_NOT_FOUND`, HTTP 404;
- missing Turn or Turn owned by another Session: `TURN_NOT_FOUND`, HTTP 404;
- running, succeeded, failed, interrupted, or otherwise non-queued/non-canceled Turn: `TURN_NOT_CANCELLABLE`, HTTP 409, non-retryable;
- same idempotency key with a different payload: existing `IDEMPOTENCY_CONFLICT` behavior.

Cancel/claim races are serialized by immediate write transactions. Cancel wins by committing `canceled`; claim wins by committing `running`, after which cancel returns the stable conflict. Running cancellation is never attempted.

Canceling a queued Turn in a recovery-blocked Session never clears its recovery markers. Tests must cover both a remaining queued Turn and no remaining queued Turns while the Session stays `recovering`.

## HTTP Bridge

Add:

- `GET /api/sessions` → `{ sessions }`;
- `POST /api/sessions/:sessionId/turns/:turnId/cancel` with `{ submissionId }` → `{ turnId, status: 'canceled' }`.

The browser mutation operation creates one submission ID and reuses it for retry. A conflict triggers an authoritative Snapshot refresh.

## Minimum Web Console Behavior

Desktop Navigation shows:

- `Sessions`;
- a Session-level summary such as `2 running · 1 queued`;
- each active Session title and textual status;
- `Running · N queued` when a running Session has queued Turns behind it;
- the selected row with `aria-current="page"`.

Session switching:

- never cancels, reorders, or resubmits work;
- fences late Snapshot/Event responses from the previously selected Session;
- replaces the center content with a loading state until the new Snapshot succeeds;
- stores only the selected Session ID locally;
- keeps the current selection when a list refresh fails.

Session list freshness:

- fetch immediately after Runtime bootstrap;
- poll with the existing `activeMs` interval while any listed Session is `queued`, `running`, `canceling`, or `recovering`, otherwise use `idleMs`;
- refresh after Session creation, Turn enqueue, queued cancel success, and queued cancel conflict;
- preserve the last good list on poll failure and retry with the normal interval;
- update unselected Session rows when their authoritative status changes.

Queued Turn action:

- appears only for a Turn whose authoritative Snapshot status is `queued` and while the Runtime is available;
- is a sibling of the Timeline inspect control, never a nested button;
- uses one mutation state per Turn;
- does not optimistically mark the Turn canceled;
- refreshes the Snapshot after success or `TURN_NOT_CANCELLABLE`;
- never renders for a running or terminal Turn.

Narrow screens below 820 px use a Session drawer. The Session and Inspector drawers are mutually exclusive and share the existing escape, backdrop, and focus-restoration behavior.

## Acceptance Matrix

Required proof:

1. two Sessions enter Driver start before either completion settles;
2. a third Session remains queued with no Lease, start Event, started timestamp, or fence increment;
3. releasing one slot starts only the next eligible Session and does not modify the other active tuple;
4. two Turns from the same Session never overlap;
5. three simultaneous claim contenders create exactly two winners;
6. one Runner start failure does not block or stop the other Runner;
7. a freed slot is reused while another Runner remains active;
8. a delayed completion cannot remove a newer run;
9. queued cancellation is atomic and produces exactly one Event;
10. repeated cancellation is successful and does not duplicate the Event;
11. canceling a middle ordinal preserves later ordinals and FIFO;
12. cancel/claim produces either canceled or running conflict, never a mixed state;
13. restart preserves queued Turn IDs, ordinals, timestamps, Messages, and Events;
14. startup recovery writes nothing if any active tuple or executor identity is invalid or ambiguous;
15. a failure injected during the second tuple's recovery write rolls back every recovery write for both tuples;
16. two pending/active Runners are both fenced and reaped before either uncommitted Turn is terminalized, and the database/lock close only after Driver shutdown and Coordinator join;
17. authentication remains required before reads, mutations, or queued execution begins;
18. the Session list is authoritative, stable-sorted, and refreshes an unselected Session after its status changes;
19. switching Sessions fences late responses and has no execution side effect;
20. queued cancel UI is independent, retry-safe, accessible, and absent for running Turns;
21. recovery-blocked Sessions remain recovering after queued cancellation with or without other queued Turns;
22. Session and Inspector drawers are mutually exclusive below 820 px;
23. the full existing test, typecheck, lint, and build gates remain green.

## File-Level Change Map

Runtime and storage:

- `services/daemon/src/db/migrations/005_scheduler_two_slots.sql`
- `services/daemon/src/runtime/scheduler.ts`
- `services/daemon/src/db/execution-repository.ts`
- `services/daemon/src/runtime/turn-terminalizer.ts`
- `services/daemon/src/runtime/execution-coordinator.ts`
- `services/daemon/src/runtime/runner-supervisor.ts`
- `services/daemon/src/runtime/startup-recovery.ts`
- `services/daemon/src/server.ts`
- `services/daemon/src/db/session-repository.ts`
- `services/daemon/src/runtime/session-service.ts`

Protocol and transport:

- `packages/protocol/src/rpc.ts`
- `packages/protocol/src/index.ts`
- `services/daemon/src/rpc/router.ts`
- `apps/web-console/src/shared/contracts.ts`
- `apps/web-console/src/server/daemon-rpc-client.ts`
- `apps/web-console/src/server/rpc-controller.ts`
- `apps/web-console/src/server/http-api.ts`

Web client:

- `apps/web-console/src/client/api.ts`
- `apps/web-console/src/client/App.tsx`
- `apps/web-console/src/client/view-model.ts`
- `apps/web-console/src/client/components/NavigationRail.tsx`
- `apps/web-console/src/client/components/Timeline.tsx`
- `apps/web-console/src/client/styles.css`

Primary tests:

- `packages/protocol/src/rpc.test.ts`
- `tests/integration/migrations.test.ts`
- `tests/integration/scheduler-claim.test.ts`
- `tests/integration/scheduler-restart.test.ts`
- `tests/integration/execution-wakeup.test.ts`
- `tests/integration/mutation-idempotency.test.ts`
- `services/daemon/src/runtime/execution-coordinator.test.ts`
- `services/daemon/src/runtime/session-service.test.ts`
- `apps/web-console/src/shared/contracts.test.ts`
- `apps/web-console/src/server/http-api.test.ts`
- `apps/web-console/src/client/api.test.ts`
- `apps/web-console/src/client/view-model.test.ts`
- `apps/web-console/src/client/App.test.tsx`

## Revisit Triggers

Revisit this design only when one of these becomes an explicit requirement:

- configurable concurrency greater than two;
- running Turn cancellation;
- distributed Daemons or an external queue;
- provider-level abort guarantees;
- live subscription rather than polling.
