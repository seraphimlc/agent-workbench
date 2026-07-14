# Headless Craft Skeleton Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a restart-safe headless Craft walking skeleton that reads `notes.md`, writes `summary.md` through a durable READY/GO worker, registers an immutable final Markdown Artifact, completes the Turn from a persisted successful final ModelAttempt, and restores the same Snapshot, TurnOutcome, and preview after Daemon restart.

**Architecture:** Keep SQLite and every authoritative transition inside the Daemon. A level-triggered execution coordinator claims the existing single durable slot and launches one short-lived, Turn-bound Runner over inherited framed pipes; the Runner owns only the Agent Loop, while model, tool, file, Blob, Artifact, audit, recovery, and terminalization services remain in the Daemon. Production uses one strict OpenAI-compatible SSE adapter; tests point that adapter at a loopback Fake Server through constructor-only dependency injection, so the ordinary Daemon has no fake switch and leaves queued Turns untouched when execution dependencies are absent.

**Tech Stack:** TypeScript 5.9, pnpm 10, Node child processes and inherited pipes, Zod 4, better-sqlite3 12, Vitest 4, native `fetch`, OpenAI-compatible SSE, SHA-256 content addressing, POSIX atomic file operations.

---

## Scope and locked decisions

This plan is the second vertical slice of Foundation Slice 1. It must prove the complete headless path:

```text
notes.md
  -> real short-lived Session Runner
  -> OpenAI-compatible streamed Tool Calling
  -> fs.read_text
  -> fs.write_text through durable READY/GO
  -> artifact.register visibility=final
  -> immutable Markdown Blob
  -> final no-ToolCall ModelAttempt
  -> one atomic Turn succeeded transaction
  -> Daemon restart
  -> identical Snapshot metadata, TurnOutcome, and artifact.get preview
```

Locked boundaries:

- Keep exactly one scheduler slot. Do not add the second slot or change `Scheduler.claimNext()` into a process supervisor.
- Do not add Electron, Keychain, real model credentials, Model Profile CRUD, live subscribe, cancel, waiting-for-user, recovery UI, Shell, a generic worker framework, Skill, Scenario, or extension loading.
- Do not expose `scheduler.tick`, `turn.run`, `tool.execute`, file read/write, or any other executor RPC to the Renderer/Main connection.
- Add only one new Main-facing method: `artifact.get`. It is read-only and returns a bounded Markdown preview from the immutable Blob, never from the current workspace file.
- Main RPC authentication remains unchanged. Runner IPC uses a distinct strict schema over inherited framed pipes.
- A normal `runDaemon()` has no execution dependencies in this slice. It starts and serves RPC normally, but queued Turns remain queued. Tests and `smoke:craft` inject execution dependencies directly into `DaemonServer`; fake configuration never enters production CLI, environment variables, Main RPC, or provider enums.
- The Runner never receives a SQLite path, workspace file descriptor, filesystem API, API key, Provider URL, or Tool handler. It can only call its Turn-bound Daemon channel.
- A model Tool Call is not executable while streaming. Candidate fragments remain in memory; only a fully terminated, validated, durably succeeded ModelAttempt creates authoritative `model_tool_calls` rows.
- `tool.execute` from Runner contains only `{modelAttemptId, logicalCallId}`. Daemon loads the exact Tool id and normalized arguments from the succeeded attempt; Runner cannot replace either.
- `turn.complete` contains only `{modelAttemptId}`. Daemon loads the final assistant text from the latest persisted successful ModelAttempt whose finish reason is `stop` and which has no Tool Calls; Runner cannot submit arbitrary final text.
- Snapshot contains execution and Artifact metadata only. It never contains Blob bytes or Artifact preview text.
- Snapshot Model/Tool projections exclude raw model input/result JSON, partial stream content, Tool input/result JSON, opaque `sourceHandle`, dispatch nonce, capability, Provider credential, process environment, and Blob storage path. Message content remains governed by the existing Message projection.
- Security Audit rows contain target metadata and normalized hashes only. Prompt text, file content, Tool arguments, model responses, credentials, capabilities, and opaque source handles never enter `audit_events`.
- `artifact.get` returns at most 256 KiB of UTF-8-safe Markdown preview and reports truncation and total byte count.
- File Tool protection is honest: no-follow descriptor checks, inode comparison, hard-link rejection, content hashes, atomic replace, and directory fsync protect against ordinary races and control-plane aliases. This slice does not claim absolute linearizable CAS against a malicious same-UID process racing every syscall.
- Slice 1 intentionally rejects every symlink component and every multiply-linked target, even when it would resolve outside the control plane. This is a conservative walking-skeleton restriction, not the final Full Access path policy.
- Startup recovery and explicit shutdown must cover nonterminal ModelCalls, ModelAttempts, ToolRuns, Runner, and fs.write worker state before SQLite closes or a new Turn may start.
- Slice 1 has no quarantine/Reaper. If an old Runner/worker identity cannot be confirmed exited, startup does not become ready and runtime scheduling remains disabled with `ORPHAN_EXECUTOR_SUSPECTED`.

## File responsibility map

Shared contracts:

- `packages/protocol/src/runner.ts`: Daemon/Runner bind, request, response, heartbeat, and exact epoch/session/turn/lease capability schemas.
- `packages/protocol/src/execution.ts`: ModelCall, ModelAttempt, ToolRun, Artifact, ArtifactVersion, and TurnOutcome projections.
- `packages/protocol/src/runtime.ts`: Session Snapshot composition; extended only in Task 6 after repositories can return real metadata.
- `packages/protocol/src/rpc.ts`: add `artifact.get` only in Task 6.

Daemon execution kernel:

- `services/daemon/src/runtime/execution-coordinator.ts`: level-triggered wake coalescing, one active Runner, and no-execution-dependencies behavior.
- `services/daemon/src/runtime/runner-supervisor.ts`: spawn, bind, heartbeat timeout, EOF/crash handling, and direct-child reaping.
- `services/daemon/src/runtime/runner-channel.ts`: framed inherited-pipe transport and capability/Lease authorization.
- `services/daemon/src/runtime/turn-terminalizer.ts`: the only normal success/failure/interruption transition that releases slot and Lease.
- `services/daemon/src/db/execution-repository.ts`: durable Model/Tool/Lease facts and exact compare-and-set operations.
- `services/daemon/src/db/session-event-writer.ts`: allocate one or more Session Event seq values inside caller-owned transactions.

Model and Runner:

- `services/daemon/src/model/openai-sse-decoder.ts`: bounded UTF-8/SSE parsing and Tool Call fragment accumulation.
- `services/daemon/src/model/openai-compatible-adapter.ts`: production HTTP adapter; no fake branch.
- `services/daemon/src/model/model-gateway.ts`: audit-before-egress, ModelCall/Attempt lifecycle, response validation, and persisted Tool Call facts.
- `runtimes/session-runner/src/agent-loop.ts`: sequential model -> Tool -> model loop and final completion reference.
- `packages/testkit/src/fake-openai-server.ts`: loopback scripted HTTP fixture used only by tests and smoke.

Tools and files:

- `packages/file-safety/src/path-boundary.ts`: process-shared canonical/no-follow/protected-root/regular-file/link-count checks used by both Daemon and worker.
- `packages/file-safety/src/file-fingerprint.ts`: descriptor identity and SHA-256 fingerprint helpers.
- `packages/file-safety/src/atomic-text-writer.ts`: worker-side final boundary recheck, CAS, temp/fsync, atomic install, and postcondition verification.
- `services/daemon/src/tools/tool-gateway.ts`: fixed builtin catalog, authoritative Tool Call lookup, ToolRun creation, handler dispatch, and result persistence.
- `services/daemon/src/tools/path-guard.ts`: Daemon configuration wrapper over the shared file-safety package.
- `services/daemon/src/tools/fs-read-text.ts`: bounded UTF-8 read plus tracked fingerprint commit.
- `services/daemon/src/tools/fs-write-text.ts`: READY/GO orchestration and deterministic postcondition checking.
- `services/daemon/src/tools/write-worker-supervisor.ts`: worker bind/READY/GO/ACK/result protocol and child identity management.
- `runtimes/tool-worker/src/write-text-worker.ts`: the only worker handler in this plan.

Artifacts:

- `services/daemon/src/artifacts/blob-store.ts`: content-addressed atomic Blob installation and bounded verified reads.
- `services/daemon/src/artifacts/artifact-service.ts`: `artifact.register`, registration replay, immutable version allocation, and provenance.
- `services/daemon/src/artifacts/turn-outcome-service.ts`: deterministic read-transaction projection; no summarization model call.

## Chunk 1: Durable execution kernel

### Task 1: Add Runner/execution contracts and durable ledger migrations

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/runtime.ts`
- Modify: `packages/protocol/src/rpc.test.ts`
- Create: `packages/protocol/src/runner.ts`
- Create: `packages/protocol/src/runner.test.ts`
- Create: `packages/protocol/src/tool-worker.ts`
- Create: `packages/protocol/src/tool-worker.test.ts`
- Create: `packages/protocol/src/execution.ts`
- Create: `packages/protocol/src/execution.test.ts`
- Create: `services/daemon/src/db/migrations/003_execution_ledger.sql`
- Create: `services/daemon/src/db/migrations/004_artifact_store.sql`
- Modify: `services/daemon/src/db/session-repository.ts`
- Modify: `tests/integration/migrations.test.ts`
- Modify: `tests/integration/session-persistence.test.ts`
- Modify: `tests/integration/runtime-smoke.test.ts`
- Modify: `docs/development/runtime-foundation.md`

- [ ] **Step 1: Write the failing Runner protocol tests**

  Define fixtures and assertions for one initial `runner.bind` notification and these Runner request methods:

  ```ts
  type RunnerBinding = {
    runnerInstanceId: string;
    capability: string;
    daemonEpoch: string;
    sessionId: string;
    turnId: string;
    leaseId: string;
    leaseEpoch: number;
    executionFence: number;
  };

  type RunnerMethod =
    | "runner.ready"
    | "runner.heartbeat"
    | "turn.context.get"
    | "model.call"
    | "tool.execute"
    | "turn.complete";
  ```

  Every request must contain the complete Binding, `requestId`, `traceId`, method, and method-specific payload. Assert rejection of a missing capability, zero lease epoch, nonpositive execution fence, mismatched top-level Turn, arbitrary method, extra fields, and a `turn.complete` payload containing assistant text. Assert `tool.execute` accepts only `{modelAttemptId, logicalCallId}`.

- [ ] **Step 2: Write failing execution projection tests**

  Export strict Zod projections for ModelCall, ModelAttempt, ToolRun, Artifact, ArtifactVersion, and TurnOutcome. Projection schemas contain ids, ownership, status, version, timing, error code, effect/dispatch status, MIME, size, and hashes only; they must reject persistence-only payloads such as `inputJson`, `resultJson`, `partialOutputJson`, `sourceHandle`, `dispatchNonce`, `storageRelpath`, and credentials. Lock these minimum TurnOutcome fields:

  ```ts
  type TurnOutcome = {
    turnId: string;
    terminalStatus: "succeeded" | "failed" | "canceled" | "interrupted" | "waiting_for_user";
    errorCode: string | null;
    resultMessageId: string | null;
    finalArtifactVersionIds: string[];
    workingArtifactVersionIds: string[];
    evidenceArtifactVersionIds: string[];
    modelCallSummary: { total: number; succeeded: number; failed: number; interrupted: number };
    toolRunSummary: { total: number; succeeded: number; failed: number; interrupted: number };
    skillRunSummary: { total: number; succeeded: number; failed: number; interrupted: number };
    checklistSummary: { total: number; pending: number; inProgress: number; completed: number; skipped: number };
    usageSummary: { inputTokens: number; outputTokens: number; cachedTokens: number; incomplete: boolean };
    unresolvedEffectToolRunIds: string[];
  };
  ```

  This slice has no Checklist or SkillRun tables yet, so those two projections are stable zero values. `usageSummary` is not a placeholder: Task 6 sums the ModelAttempt token columns introduced by migration 003 and sets `incomplete=true` when any terminal Attempt lacks final Provider usage.

  Keep the existing SessionSnapshot top-level arrays unchanged in this task; Task 6 composes the new execution/Artifact projections. Add `executionFence` to `TurnRowSchema`, select it in `SessionRepository`, and prove existing queued Turns project fence `0` across restart.

  Add strict one-shot write-worker schemas for INIT, READY, GO, ACK, RESULT, and ERROR. INIT binds `daemonEpoch/sessionId/turnId/toolRunId/executionFence/capability/dispatchNonce`; GO/ACK consume the exact nonce; RESULT contains only status, hashes, size, and stable error metadata. Reject duplicate/unknown message kinds and extra fields.

- [ ] **Step 3: Write failing migration tests**

  Extend source and built migration tests to require installed/applied versions `[1,2,3,4]`. Cover:

  - fresh install applies all four with no backup;
  - an existing 002 database creates exactly one awaited pre-003 backup, then applies 003 and 004;
  - any failure in 003 or 004 rolls back that migration and its history row;
  - all new partial and unique indexes reject conflicting active facts;
  - foreign keys reject missing parents and CHECK constraints reject invalid state/mode combinations; Tasks 2, 3, and 6 separately prove cross-Turn/session ownership is rejected by the compare-and-set repositories.

  Update the existing Runtime Smoke SQLite assertion from migrations `[1,2]` to `[1,2,3,4]`. Its product boundary remains unchanged: normal Daemon still leaves the first Turn queued and the new execution/Artifact tables remain empty.

- [ ] **Step 4: Run the focused tests and confirm RED**

  Run:

  ```bash
  pnpm test packages/protocol/src/runner.test.ts packages/protocol/src/tool-worker.test.ts packages/protocol/src/execution.test.ts packages/protocol/src/rpc.test.ts tests/integration/migrations.test.ts tests/integration/session-persistence.test.ts tests/integration/runtime-smoke.test.ts
  ```

  Expected: FAIL because Runner schemas, execution projections, and migrations 003/004 do not exist.

- [ ] **Step 5: Implement migration 003 exactly**

  `003_execution_ledger.sql` adds `execution_fence INTEGER NOT NULL DEFAULT 0 CHECK(execution_fence>=0)` to `turns`, adds nullable `runner_instance_id`, `pid`, and `process_start_identity` columns to `runner_leases`, then creates:

  - `model_calls(id PK, session_id FK, turn_id FK, ordinal>0, kind CHECK craft, status CHECK running/succeeded/failed/interrupted, profile_snapshot_json, input_json, result_json nullable, successful_attempt_id nullable REFERENCES model_attempts(id) DEFERRABLE INITIALLY DEFERRED, error_code/message nullable, created_at, started_at, finished_at, UNIQUE(turn_id,ordinal))`;
  - `model_attempts(id PK, model_call_id FK, attempt>0, status CHECK running/succeeded/failed/interrupted, provider_request_id nullable, partial_output_json nullable, result_json nullable, finish_reason nullable, input_tokens/output_tokens/cached_tokens nullable nonnegative, latency_ms nullable nonnegative, error_code/message nullable, retryable nullable boolean, started_at, finished_at nullable, UNIQUE(model_call_id,attempt))`;
  - `model_tool_calls(model_attempt_id FK, logical_call_id, call_index>=0, tool_id, arguments_json, normalized_input_hash, PRIMARY KEY(model_attempt_id,logical_call_id), UNIQUE(model_attempt_id,call_index))`;
  - `tool_runs(id PK, session_id FK, turn_id FK, ordinal>0, logical_call_id, source_model_call_id FK, source_model_attempt_id FK, attempt>0, operation_id UNIQUE, idempotency_key nullable, source_handle nullable UNIQUE, tool_id, tool_version, execution_mode CHECK read_inline/worker/transactional_intrinsic, side_effect_class CHECK read/local_write, status CHECK queued/running/cancel_requested/succeeded/failed/canceled/interrupted, dispatch_state nullable CHECK prepared/worker_ready/go_sent/acknowledged, dispatch_nonce nullable UNIQUE, normalized_input_hash, input_json, result_json nullable, effect_state CHECK not_applied/applied/unknown, pid/process_start_identity nullable, error_code/message nullable, queued_at, started_at/finished_at nullable, UNIQUE(turn_id,ordinal), UNIQUE(source_model_attempt_id,logical_call_id,attempt))`;
  - `tracked_files(session_id FK, canonical_path, requested_path, content_sha256, size>=0, mtime_ms>=0, device, inode, baseline_source CHECK read/write, last_source_tool_run_id FK, updated_at, PRIMARY KEY(session_id,canonical_path))`;
  - `fs_write_effects(tool_run_id PK/FK, requested_path, canonical_path, target_existed_before boolean, baseline_sha256 nullable, expected_sha256, expected_size>=0)`;
  - `audit_events(global_seq INTEGER PRIMARY KEY AUTOINCREMENT, id UNIQUE, session_id FK, turn_id FK, operation_key, phase CHECK intent/outcome, action, payload_json, created_at, UNIQUE(operation_key,phase))`;
  - `effect_resolutions(id PK, resolution_key UNIQUE, tool_run_id FK, resolution CHECK confirmed_applied/confirmed_not_applied, evidence_json, actor CHECK daemon, created_at)`.

  Add partial unique indexes:

  - one active `model_calls` row per Turn where status=`running`;
  - one active `model_attempts` row per ModelCall where status=`running`;
  - one succeeded ModelAttempt per ModelCall;
  - one active ToolRun per Turn where status in queued/running/cancel_requested;
  - one nonnull `(tool_id,tool_version,idempotency_key)` owner for effectful Tool execution;
  - one active Runner Lease per Turn where status=`active`.

  Add table CHECKs that `read_inline` is read/null-dispatch/not_applied, `worker` is local_write with nonnull operation/idempotency/dispatch fields, and `transactional_intrinsic` has null dispatch and never claims an external applied effect. Only a succeeded `fs.write_text` may own a nonnull `source_handle`. Migration tests must reject every cross-mode combination.

- [ ] **Step 6: Implement migration 004 exactly**

  `004_artifact_store.sql` creates:

  - `blobs(sha256 PK length=64, size>=0, storage_relpath UNIQUE, created_at)`;
  - `artifacts(id PK, session_id FK, logical_name, current_version_id NOT NULL, created_at, updated_at, UNIQUE(session_id,logical_name), FOREIGN KEY(id,current_version_id) REFERENCES artifact_versions(artifact_id,id) DEFERRABLE INITIALLY DEFERRED)`;
  - `artifact_versions(id PK, artifact_id FK, version>0, source_turn_id FK, source_tool_run_id FK, blob_sha256 FK, visibility CHECK final/working/evidence, artifact_type CHECK markdown, mime_type CHECK text/markdown, filename, size>=0, validation_status CHECK valid/warning/invalid/unchecked, registration_key, registration_input_hash, provenance_json, created_at, UNIQUE(artifact_id,id), UNIQUE(artifact_id,version), UNIQUE(source_turn_id,registration_key))`.

  Do not add a generic `blob_refs` abstraction in this slice. The ArtifactVersion foreign key is the complete durable Blob ownership relation needed by the walking skeleton.

  Preallocate Artifact and Version ids. For a new Artifact, insert both sides of the circular relation in one deferred transaction; for an existing Artifact, insert the Version then compare-and-set `current_version_id`. Migration tests must prove an Artifact cannot commit without a current Version or point at another Artifact's Version.

- [ ] **Step 7: Implement and export the schemas, then confirm GREEN**

  Run:

  ```bash
  pnpm test packages/protocol/src/runner.test.ts packages/protocol/src/tool-worker.test.ts packages/protocol/src/execution.test.ts packages/protocol/src/rpc.test.ts tests/integration/migrations.test.ts tests/integration/session-persistence.test.ts tests/integration/runtime-smoke.test.ts
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm build
  ```

  Expected: all commands exit 0; built migration discovery returns `[1,2,3,4]`.

- [ ] **Step 8: Commit**

  ```bash
  git add pnpm-workspace.yaml packages/protocol services/daemon/src/db/migrations/003_execution_ledger.sql services/daemon/src/db/migrations/004_artifact_store.sql services/daemon/src/db/session-repository.ts tests/integration/migrations.test.ts tests/integration/session-persistence.test.ts tests/integration/runtime-smoke.test.ts docs/development/runtime-foundation.md
  git commit -m "feat: define craft execution ledger"
  ```

### Task 2: Add atomic Turn terminalization and the event-driven scheduler pump

**Files:**
- Create: `services/daemon/src/db/session-event-writer.ts`
- Create: `services/daemon/src/db/execution-repository.ts`
- Create: `services/daemon/src/runtime/turn-terminalizer.ts`
- Create: `services/daemon/src/runtime/turn-terminalizer.test.ts`
- Create: `services/daemon/src/runtime/execution-recovery.ts`
- Create: `services/daemon/src/runtime/execution-recovery.test.ts`
- Create: `services/daemon/src/runtime/execution-coordinator.ts`
- Create: `services/daemon/src/runtime/execution-coordinator.test.ts`
- Modify: `services/daemon/src/runtime/scheduler.ts`
- Modify: `services/daemon/src/runtime/startup-recovery.ts`
- Modify: `services/daemon/src/rpc/router.ts`
- Modify: `services/daemon/src/server.ts`
- Modify: `services/daemon/src/index.ts`
- Create: `tests/integration/execution-wakeup.test.ts`
- Modify: `tests/integration/scheduler-claim.test.ts`
- Modify: `tests/integration/scheduler-restart.test.ts`

- [ ] **Step 1: Write failing terminalization tests**

  Seed a claimed Turn, exact active Lease/slot, and a latest succeeded ModelAttempt with normalized result `{finishReason:"stop",content:"Completed",toolCalls:[]}`. Assert `TurnTerminalizer.succeed()` performs one `BEGIN IMMEDIATE` transaction that:

  - revalidates `daemonEpoch/sessionId/turnId/leaseId/leaseEpoch/executionFence` and the complete active tuple;
  - rejects an older Attempt, an Attempt with Tool Calls, empty final content, any nonterminal ModelCall/Attempt/ToolRun, or unresolved Tool effect;
  - inserts one completed assistant Message using the persisted Attempt content;
  - changes Turn `running->succeeded`, sets `finished_at` and `result_message_id`;
  - expires the exact Lease and frees the exact owned slot;
  - clears `Session.current_turn_id` and projects runtime status to `queued` when another eligible Turn exists, otherwise `idle`;
  - advances Session Event seq/revision and appends one `turn.succeeded` Event in the same transaction;
  - leaves Artifact rows and the final ModelAttempt immutable.

  Add CAS-race tests: terminalization versus a mismatched Lease, already Terminal Turn, and duplicate completion. Only one transaction may win.

  Also seed active ModelCall/Attempt and safe nonterminal ToolRun rows and lock the other two transitions:

  - `fail()` always changes Turn `running->failed`, appends `turn.failed`, writes Model/Attempt/Tool terminal failures, expires Lease, releases slot, and projects Session queued/idle in one caller-owned `BEGIN IMMEDIATE`; only the Assistant result Message is optional, and the transition is rejected if any effect cannot be resolved safely as not-applied;
  - `interrupt()` first revokes the persisted execution fence, then in that same transaction closes Model/Attempt rows, closes safe ToolRuns, writes any effect resolutions supplied by the deterministic recovery policy, sets Turn=`interrupted`, expires Lease, frees the slot only after executor exit is proven, sets Session=`recovering/recovery_review`, and appends subexecution Events followed by `turn.interrupted` and `recovery.detected`.

  `ExecutionRecovery` is a transaction participant, not a service that commits independently. Tests must inject a failure after every write group and prove zero partial Model/Tool/Turn/Lease/slot/Session/Event facts commit.

- [ ] **Step 2: Write failing coordinator tests**

  Use a fake Scheduler and fake execution driver. Assert:

  - no execution dependencies means no claim even after queue notifications;
  - no authenticated control client means no claim;
  - first authenticated connection triggers one claim for already-persisted work;
  - successful `session.create`/`turn.enqueue` commit triggers a wake without a public RPC;
  - 100 synchronous wake signals coalesce and never run two drains;
  - while one Runner is active, no second claim occurs;
  - a driver start failure before READY atomically fails the claimed Turn with `RUNNER_START_FAILED`, releases the slot, and permits the next wake;
  - after terminal commit and Runner reap, another wake claims the next queued Turn;
  - `quiesce()` permanently prevents new claims.

- [ ] **Step 3: Run focused tests and confirm RED**

  Run:

  ```bash
  pnpm test services/daemon/src/runtime/turn-terminalizer.test.ts services/daemon/src/runtime/execution-recovery.test.ts services/daemon/src/runtime/execution-coordinator.test.ts tests/integration/execution-wakeup.test.ts tests/integration/scheduler-restart.test.ts
  ```

  Expected: FAIL because terminalizer, coordinator, and wake hooks are absent.

- [ ] **Step 4: Implement transaction-owned Event allocation and terminalization**

  `SessionEventWriter` must run only inside an existing transaction. It reads `sessions.next_event_seq`, reserves an exact count with a revision compare-and-set, and inserts consecutive Events; it never opens its own transaction.

  Refactor the existing zero-subexecution startup recovery in this Task to call `TurnTerminalizer.interrupt()` and `SessionEventWriter` rather than its old direct SQL. It always reserves `subexecutionEventCount + 2`; for today's old tuple that is two Events, but there is only one fence/revision/recovery implementation. Update scheduler restart/idempotence tests to assert the terminal fence increment and unchanged existing event order.

  Change Scheduler claim CAS to increment `turns.execution_fence` exactly once and return it in Claim; extend the claim integration test to assert queued fence `0` becomes running fence `1` and a rejected/duplicate claim cannot increment it again. `TurnTerminalizer` owns success/failure/interruption transitions, requires that fence on every active-tuple mutation, increments it again when terminalizing to fence late replies, and checks every `UPDATE ... WHERE expected_state` affected exactly one row. It invokes `ExecutionRecovery` inside the same transaction for fail/interrupt; no ModelGateway, RunnerSupervisor, Tool handler, or startup helper may commit a subexecution terminal row separately from the owning Turn terminalization. It exposes one post-commit callback used solely to wake the coordinator.

- [ ] **Step 5: Implement the level-triggered coordinator and commit hooks**

  `ExecutionCoordinator.notify()` must be synchronous, nonthrowing, and only mark a dirty flag plus schedule one microtask/immediate drain. The drain checks `running && authenticatedControlConnectionCount>0 && executionDependencies && !activeRunner`, calls `Scheduler.claimNext()`, and hands a Claim to the injected execution driver. It never polls.

  Router invokes `notify()` only after `session.create` or `turn.enqueue` returns from its committed SessionService transaction. DaemonServer increments the authenticated connection count once after successful `auth.respond`, decrements it once on close, and notifies on transition `0->1`. Idempotent mutation replay may cause a harmless extra wake.

  `runDaemon()` supplies no execution dependencies, preserving all current runtime-smoke expectations: the first Turn stays queued.

- [ ] **Step 6: Extend server cleanup ordering**

  Change cleanup order to: quiesce coordinator -> stop accepting/destroy Main connections -> await execution driver shutdown while SQLite remains open -> unlink owned socket -> close SQLite -> release runtime lock. A shutdown error is aggregated and never hidden by later cleanup.

- [ ] **Step 7: Run tests and confirm GREEN**

  Run:

  ```bash
  pnpm test services/daemon/src/runtime/turn-terminalizer.test.ts services/daemon/src/runtime/execution-recovery.test.ts services/daemon/src/runtime/execution-coordinator.test.ts tests/integration/execution-wakeup.test.ts tests/integration/scheduler-restart.test.ts tests/integration/runtime-smoke.test.ts
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm build
  ```

  Expected: all pass; the existing runtime smoke still restores a queued Turn.

- [ ] **Step 8: Commit**

  ```bash
  git add services/daemon/src/db/session-event-writer.ts services/daemon/src/db/execution-repository.ts services/daemon/src/runtime/turn-terminalizer.ts services/daemon/src/runtime/turn-terminalizer.test.ts services/daemon/src/runtime/execution-recovery.ts services/daemon/src/runtime/execution-recovery.test.ts services/daemon/src/runtime/execution-coordinator.ts services/daemon/src/runtime/execution-coordinator.test.ts services/daemon/src/runtime/scheduler.ts services/daemon/src/runtime/startup-recovery.ts services/daemon/src/rpc/router.ts services/daemon/src/server.ts services/daemon/src/index.ts tests/integration/execution-wakeup.test.ts tests/integration/scheduler-claim.test.ts tests/integration/scheduler-restart.test.ts
  git commit -m "feat: drive queued turns to atomic terminal states"
  ```

### Task 3: Launch the real Runner and authorize Tools only from complete SSE attempts

**Files:**
- Create: `runtimes/session-runner/package.json`
- Create: `runtimes/session-runner/tsconfig.json`
- Create: `runtimes/session-runner/src/index.ts`
- Create: `runtimes/session-runner/src/daemon-channel.ts`
- Create: `runtimes/session-runner/src/agent-loop.ts`
- Create: `runtimes/session-runner/src/agent-loop.test.ts`
- Create: `services/daemon/src/runtime/runner-channel.ts`
- Create: `services/daemon/src/runtime/runner-supervisor.ts`
- Modify: `services/daemon/src/runtime/execution-recovery.ts`
- Modify: `services/daemon/src/runtime/startup-recovery.ts`
- Create: `services/daemon/src/model/openai-sse-decoder.ts`
- Create: `services/daemon/src/model/openai-sse-decoder.test.ts`
- Create: `services/daemon/src/model/openai-compatible-adapter.ts`
- Create: `services/daemon/src/model/model-gateway.ts`
- Create: `services/daemon/src/tools/tool-gateway.ts`
- Create: `packages/testkit/src/fake-openai-server.ts`
- Create: `packages/testkit/src/fake-openai-server.test.ts`
- Modify: `packages/testkit/package.json`
- Create: `tests/integration/runner-binding.test.ts`
- Create: `tests/integration/model-tool-authorization.test.ts`
- Create: `tests/integration/runner-model-loop.test.ts`
- Create: `tests/integration/runner-restart.test.ts`
- Create: `tests/integration/runner-shutdown.test.ts`

- [ ] **Step 1: Write failing SSE and Fake Server tests**

  Use a real loopback HTTP server and native `fetch`. Cover:

  - UTF-8 and SSE lines split across arbitrary TCP chunks;
  - text deltas and Tool Call id/name/arguments split independently;
  - multiple Tool Calls indexed in returned order;
  - bounded non-2xx error body;
  - malformed JSON, duplicate/conflicting Tool indexes, invalid UTF-8, response-size overflow;
  - complete-looking Tool arguments followed by EOF before terminal finish and `[DONE]`;
  - terminal finish without `[DONE]`, `[DONE]` without terminal finish, and AbortSignal cancellation.

  All incomplete cases must return `MODEL_STREAM_INTERRUPTED` or `MODEL_RESPONSE_INVALID`, never a successful normalized response.

- [ ] **Step 2: Write failing ModelAttempt authorization tests**

  Assert exact durable order:

  1. one transaction creates ModelCall/Attempt=`running`, appends model start Events, and writes `audit_events phase=intent action=model.egress` with endpoint/model metadata and a normalized request hash but no prompt, message, Tool argument, or credential content;
  2. only then may Adapter fetch;
  3. streamed Tool fragments remain in memory;
  4. after terminal finish + `[DONE]` + Tool id allowlist + JSON parse + Tool input Schema validation, one transaction marks Attempt/Call succeeded, writes normalized `model_tool_calls`, model completion Event, and audit outcome;
  5. only a later `tool.execute {modelAttemptId,logicalCallId}` transaction may create ToolRun;
  6. ToolGateway loads Tool id/arguments from `model_tool_calls`, ignoring any Runner attempt to restate them.

  Prove malformed/interrupted/unauthorized/schema-invalid responses create zero `model_tool_calls` and zero ToolRuns. Prove a stale Lease, cross-Turn Attempt id, altered logical call id, and duplicate source call cannot dispatch a Tool.

- [ ] **Step 3: Write failing Runner binding and crash tests**

  Spawn the real Runner with inherited fd 3/4 pipes. No Turn identity or secret may appear in argv/environment. Assert:

  - first Daemon frame is exactly one `runner.bind`;
  - every Runner request echoes the immutable Binding;
  - capability comparison is constant-time and a wrong epoch/session/turn/lease closes the channel;
  - ready timeout and heartbeat timeout terminate/reap the direct child;
  - Runner channel EOF aborts in-flight model fetch, fences capability, marks running Model facts interrupted, and cannot authorize a late Tool Call;
  - Runner stdout/stderr are bounded and do not contain capability, API key, prompt, or Tool arguments.

  Add a Daemon restart case with a persisted active Runner/Model tuple. After the old direct child is confirmed reaped, startup recovery extends the Task 2 transaction-owned interruption path so nonterminal ModelCall/Attempt rows, Turn, Lease, slot, Session recovery projection, and Events commit together. Event order is: active ModelAttempt interruptions by Attempt number, ModelCall interruptions by ordinal, safe Tool terminal Events by Tool ordinal, `turn.interrupted`, then `recovery.detected`. `SessionEventWriter` always reserves that complete dynamic count. Repeating startup is a no-op and recovered-state validation checks the complete ordered set. An old Runner identity that is still live or ambiguous prevents ready with `ORPHAN_EXECUTOR_SUSPECTED` and makes zero recovery writes.

  Add an explicit shutdown case while the real Runner is blocked in a streamed model request. `DaemonServer.stop()` must quiesce scheduling, fence the channel, abort fetch, reap the Runner, invoke one atomic interruption transaction while SQLite is open, and only then close the database/runtime lock. No Model/Turn row may remain running and no database-closed callback may race the terminal transaction.

- [ ] **Step 4: Run focused tests and confirm RED**

  Run:

  ```bash
  pnpm test services/daemon/src/model/openai-sse-decoder.test.ts packages/testkit/src/fake-openai-server.test.ts tests/integration/runner-binding.test.ts tests/integration/model-tool-authorization.test.ts tests/integration/runner-model-loop.test.ts tests/integration/runner-restart.test.ts tests/integration/runner-shutdown.test.ts
  ```

  Expected: FAIL because Runner, Model Gateway, Fake Server, and Tool authorization do not exist.

- [ ] **Step 5: Implement the production Adapter and Model Gateway**

  The Adapter accepts an immutable `{baseUrl,modelId,apiKey,timeoutMs}` supplied in memory by `ExecutionDependencies`. It sends `stream:true` to `/v1/chat/completions`, injects Authorization only in the outbound header, and returns normalized content/tool calls/usage/provider request id. It contains no retry loop in this slice and no provider-specific fake logic.

  The Fake Server lives only in testkit and accepts an in-memory script of expected requests and SSE chunks. Daemon and Runner packages must not depend on testkit.

  `runtimes/session-runner/package.json` depends only on `@agent-workbench/protocol`. Add its build/typecheck scripts, add the Fake Server export to testkit, run `pnpm install`, and include the lockfile change in this Task.

  ModelGateway supplies the fixed builtin Tool schemas, validates the active Runner Binding before start and before success commit, coalesces visible text deltas at 50 ms or 4 KiB, and commits partial output as evidence on failure/interruption. An Audit intent failure returns `AUDIT_UNAVAILABLE` before fetch. Every committed model-egress intent receives exactly one outcome for success, failure, interruption, or cancellation in the same transaction as the ModelAttempt/ModelCall terminal state.

- [ ] **Step 6: Implement the Turn-scoped Runner channel and Agent Loop**

  Generate a random 32-byte base64url capability per Claim. Send it only over the inherited bind pipe. Each Runner request is authorized against both the immutable channel Binding and the current active Lease/Turn/Session/slot tuple, including the exact `executionFence`. A late response from an older execution fence is rejected even if it reuses valid-looking Turn ids.

  The Agent Loop is sequential and capped at 64 model/tool cycles:

  ```text
  turn.context.get
    -> model.call(messages)
    -> if Tool Calls: tool.execute(reference) in returned order, append Tool results, loop
    -> if final stop: turn.complete(modelAttemptId), await terminalized, exit 0
  ```

  Runner never constructs Tool schemas, opens files, or reads Provider configuration. `turn.complete` is rejected unless the referenced Attempt is the latest successful ModelCall and has no Tool Calls.

- [ ] **Step 7: Wire RunnerSupervisor to ExecutionCoordinator and confirm GREEN**

  RunnerSupervisor records `runner_instance_id/pid/process_start_identity` on the exact active Lease, resets a per-child 20-second expiry on valid 5-second heartbeats, and exposes one completion Promise to the coordinator. A Runner exit before committed Turn terminalization calls `TurnTerminalizer.interrupt(reason="runner_lost")`; after the child is confirmed reaped, the coordinator may wake again.

  Extend the Task 2 `ExecutionRecovery` policy here. Runner EOF, heartbeat timeout, explicit shutdown, and startup recovery all call `TurnTerminalizer.interrupt()`; none may pre-commit Model/Tool terminal rows. Task 5 later adds worker dispatch/effect resolution to the same transaction participant. No intermediate commit may leave a Turn interrupted while its Model/Tool children remain running.

  Run:

  ```bash
  pnpm test services/daemon/src/model/openai-sse-decoder.test.ts packages/testkit/src/fake-openai-server.test.ts tests/integration/runner-binding.test.ts tests/integration/model-tool-authorization.test.ts tests/integration/runner-model-loop.test.ts tests/integration/runner-restart.test.ts tests/integration/runner-shutdown.test.ts
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm build
  ```

  Expected: all pass, including a real Runner completing a no-ToolCall fake model Turn.

- [ ] **Step 8: Commit**

  ```bash
  git add runtimes/session-runner services/daemon/src/runtime/runner-channel.ts services/daemon/src/runtime/runner-supervisor.ts services/daemon/src/runtime/execution-recovery.ts services/daemon/src/runtime/startup-recovery.ts services/daemon/src/model services/daemon/src/tools/tool-gateway.ts packages/testkit/src/fake-openai-server.ts packages/testkit/src/fake-openai-server.test.ts packages/testkit/package.json tests/integration/runner-binding.test.ts tests/integration/model-tool-authorization.test.ts tests/integration/runner-model-loop.test.ts tests/integration/runner-restart.test.ts tests/integration/runner-shutdown.test.ts pnpm-lock.yaml
  git commit -m "feat: run craft turns through streamed model calls"
  ```

## Chunk 2: Safe files, Artifact delivery, and restart proof

### Task 4: Implement guarded `fs.read_text` and tracked file baselines

**Files:**
- Create: `packages/file-safety/package.json`
- Create: `packages/file-safety/tsconfig.json`
- Create: `packages/file-safety/src/index.ts`
- Create: `packages/file-safety/src/path-boundary.ts`
- Create: `packages/file-safety/src/path-boundary.test.ts`
- Create: `packages/file-safety/src/file-fingerprint.ts`
- Modify: `pnpm-lock.yaml`
- Create: `services/daemon/src/tools/path-guard.ts`
- Create: `services/daemon/src/tools/path-guard.test.ts`
- Create: `services/daemon/src/tools/fs-read-text.ts`
- Create: `services/daemon/src/tools/fs-read-text.test.ts`
- Modify: `services/daemon/src/tools/tool-gateway.ts`
- Modify: `services/daemon/src/db/execution-repository.ts`
- Create: `tests/integration/craft-read-text.test.ts`

- [ ] **Step 1: Write failing PathGuard tests**

  Test relative paths anchored to Workspace canonical path and absolute paths allowed under Full Access. Reject:

  - path traversal that escapes after normalization;
  - any path equal to or beneath Daemon `dataDir` or socket `runtimeDir`;
  - symlink components or final symlink;
  - non-regular files;
  - a regular file with `nlink>1`;
  - an inode/device mismatch between pre-open `lstat`, `open(O_RDONLY|O_NOFOLLOW)`, and `fstat`;
  - files larger than 1 MiB and invalid UTF-8.

  Tests use temp real files, symlinks, hard links, and replacement races; no test-only branch is added to PathGuard. The low-level descriptor and component checks live in `@agent-workbench/file-safety`; the Daemon wrapper only supplies Workspace and protected-root policy.

- [ ] **Step 2: Write failing Tool and tracked baseline tests**

  Authorize a persisted `fs.read_text` model call. Assert ToolGateway first commits ToolRun=`queued`, `dispatch_state=null`, `effect_state=not_applied`, and `tool.queued`; a second transaction CASes `queued->running` and appends `tool.started` before the handler opens the file; then the inline handler reads through the guarded descriptor; then one terminal transaction stores result, ToolRun=`succeeded`, `tool.succeeded`, and an upserted tracked fingerprint:

  ```ts
  {
    canonicalPath,
    contentSha256,
    size,
    mtimeMs,
    lastReadToolRunId
  }
  ```

  On read failure, ToolRun becomes failed/not_applied with a stable redacted error and no tracked baseline.

- [ ] **Step 3: Run focused tests and confirm RED**

  Run:

  ```bash
  pnpm test packages/file-safety/src/path-boundary.test.ts services/daemon/src/tools/path-guard.test.ts services/daemon/src/tools/fs-read-text.test.ts tests/integration/craft-read-text.test.ts
  ```

  Expected: FAIL because guarded file Tools are absent.

- [ ] **Step 4: Implement PathGuard and `fs.read_text` minimally**

  Use the shared descriptor-based checks, a fatal streaming `TextDecoder`, SHA-256 over the exact bytes, and bounded result JSON. Never expose the Blob/data/runtime paths. Return the user-requested path and resolved canonical path, but do not give Runner a reusable general filesystem capability.

  `packages/file-safety` has no Daemon, database, protocol, or testkit dependency. It exports small pure/path-FD primitives so the write worker in Task 5 can repeat the exact final checks instead of trusting a stale Daemon preflight.

  Add its build/typecheck scripts, run `pnpm install`, and include the lockfile importer update in this Task.

  Register only version `1.0.0` of `fs.read_text` in the fixed Tool catalog with side effect class `read` and execution mode `read_inline`.

- [ ] **Step 5: Run tests and confirm GREEN**

  Run:

  ```bash
  pnpm test packages/file-safety/src/path-boundary.test.ts services/daemon/src/tools/path-guard.test.ts services/daemon/src/tools/fs-read-text.test.ts tests/integration/craft-read-text.test.ts
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm build
  ```

  Expected: all pass; a fake model can read `notes.md` only through ToolGateway.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/file-safety services/daemon/src/tools/path-guard.ts services/daemon/src/tools/path-guard.test.ts services/daemon/src/tools/fs-read-text.ts services/daemon/src/tools/fs-read-text.test.ts services/daemon/src/tools/tool-gateway.ts services/daemon/src/db/execution-repository.ts tests/integration/craft-read-text.test.ts pnpm-lock.yaml
  git commit -m "feat: add guarded text reads"
  ```

### Task 5: Implement `fs.write_text` with durable READY/GO, Audit, CAS, and recovery

**Files:**
- Create: `packages/file-safety/src/atomic-text-writer.ts`
- Create: `packages/file-safety/src/atomic-text-writer.test.ts`
- Modify: `packages/file-safety/src/index.ts`
- Create: `runtimes/tool-worker/package.json`
- Create: `runtimes/tool-worker/tsconfig.json`
- Create: `runtimes/tool-worker/src/index.ts`
- Create: `runtimes/tool-worker/src/write-text-worker.ts`
- Create: `runtimes/tool-worker/src/write-text-worker.test.ts`
- Create: `services/daemon/src/tools/write-worker-supervisor.ts`
- Create: `services/daemon/src/tools/fs-write-text.ts`
- Create: `services/daemon/src/tools/fs-write-text.test.ts`
- Modify: `services/daemon/src/runtime/execution-recovery.ts`
- Modify: `services/daemon/src/tools/tool-gateway.ts`
- Modify: `services/daemon/src/runtime/startup-recovery.ts`
- Modify: `services/daemon/src/server.ts`
- Modify: `services/daemon/src/index.ts`
- Modify: `tests/integration/scheduler-restart.test.ts`
- Create: `tests/fixtures/crash-write-worker.ts`
- Create: `tests/integration/write-ready-go.test.ts`
- Create: `tests/integration/write-recovery.test.ts`
- Create: `tests/integration/craft-read-write.test.ts`

- [ ] **Step 1: Write failing READY/GO protocol tests**

  Spawn the real worker over inherited fd 3/4 pipes. Assert:

  - INIT carries target, expected baseline, intended bytes, nonce, and limits only through the pipe;
  - before GO, worker may decode and validate INIT but creates no temp file, opens no target for write, and returns READY;
  - READY with the wrong nonce is rejected;
  - Daemon persists `worker_ready`, then persists ToolRun=`running`, `dispatch_state=go_sent`, and `tool.started` before sending GO;
  - worker atomically consumes the first correct GO, sends ACK before executing, and returns `DUPLICATE_GO` without a second write for repeats;
  - Daemon persists `acknowledged` after ACK;
  - content, capability, and nonce never appear in argv, environment, stdout, or stderr.

- [ ] **Step 2: Write failing CAS and atomic-write tests**

  Cover:

  - existing target without this Session's tracked read returns `FILE_READ_REQUIRED_BEFORE_OVERWRITE` before worker spawn;
  - target changed after read returns `FILE_CHANGED_SINCE_READ` and preserves external bytes;
  - a nonexistent target is created without clobber using same-directory temp + fsync + atomic link-no-clobber + directory fsync;
  - an existing tracked target is written via same-directory temp + fsync + final hash recheck + rename + directory fsync while preserving its POSIX mode;
  - parent/target symlink, hard link, protected root, nonregular target, and content over 1 MiB fail closed;
  - success result includes canonical path, prior hash/null, final SHA-256, size, worker evidence, and a random opaque `sourceHandle` bound to the exact Turn, ToolRun, and execution fence; it never exposes the raw ToolRun id to Runner/model.

  The worker, not only the Daemon preflight, must call the shared file-safety primitives immediately before temp creation and again before atomic install. Tests replace a parent component, introduce a symlink/hard link, and change the target after READY but before GO; the worker must reject each case without modifying the target.

  Inject Audit intent insertion failure and prove the caller transaction rolls back completely: no ToolRun/Event, no worker spawn, no temp file, and no target change. Audit rows, logs, argv, environment, stdout, and stderr must not contain file content, capability, or dispatch nonce. SQLite may contain the specification-required normalized Tool input and durable dispatch nonce after a successful intent transaction, but it must never contain an API key or Runner capability; Snapshot/Main RPC projections must expose neither raw Tool input, `sourceHandle`, nor dispatch nonce. The surfaced error is `AUDIT_UNAVAILABLE`.

- [ ] **Step 3: Write failing crash and startup-recovery tests**

  Inject crashes at `prepared`, `worker_ready`, `go_sent`, after ACK, during temp write, and after final install before terminal DB commit. Lock these outcomes:

  | Durable state | Recovery |
  |---|---|
  | prepared / worker_ready | ToolRun canceled, effect not_applied, Audit outcome, no GO resend |
  | go_sent / acknowledged, target hash=intended | ToolRun interrupted/unknown plus `effect_resolutions=confirmed_applied` |
  | go_sent / acknowledged, target hash=baseline or target absent | ToolRun interrupted/unknown plus `confirmed_not_applied` |
  | go_sent / acknowledged, neither proof | ToolRun interrupted/unknown, no resolution, Session recovery_review |

  Recovery must also mark nonterminal Model facts interrupted and update Turn/Lease/slot/Session/Events in the same startup `BEGIN IMMEDIATE` transaction. It never changes a Terminal ToolRun.

  Before that transaction, verify persisted worker pid/owner/process-start identity is stale. Poll the exact identity for at most 3 seconds at 25 ms intervals; if still live or identity is ambiguous, fail startup with `ORPHAN_EXECUTOR_SUSPECTED`, make zero recovery writes, do not listen, and do not schedule.

- [ ] **Step 4: Run focused tests and confirm RED**

  Run:

  ```bash
  pnpm test packages/file-safety/src/atomic-text-writer.test.ts runtimes/tool-worker/src/write-text-worker.test.ts services/daemon/src/tools/fs-write-text.test.ts tests/integration/write-ready-go.test.ts tests/integration/write-recovery.test.ts tests/integration/craft-read-write.test.ts
  ```

  Expected: FAIL because the worker, write Tool, and expanded recovery do not exist.

- [ ] **Step 5: Implement the exact durable dispatch order**

  For a newly authorized `fs.write_text` call:

  1. one transaction writes Audit intent, ToolRun=`queued/prepared/unknown` with null worker identity, `fs_write_effects`, and `tool.queued`;
  2. spawn a worker that is blocked waiting for INIT, capture its pid/process-start identity, and transactionally CAS those values onto the exact prepared ToolRun;
  3. only after identity commit send INIT over the inherited pipe;
  4. on valid READY, transaction CAS `prepared->worker_ready`;
  5. transaction CAS ToolRun `queued->running`, `worker_ready->go_sent`, append `tool.started`;
  6. only after commit send GO once;
  7. on ACK, transaction CAS `go_sent->acknowledged`;
  8. the worker re-runs canonical/no-follow/protected-root/regular-file/link-count and baseline-hash checks at the final boundary, then uses the shared AtomicTextWriter;
  9. on verified success, one transaction writes Tool result, `succeeded/applied`, Audit outcome, the new tracked-file baseline with `baseline_source=write`, and `tool.succeeded`;
  10. after GO, any lost/ambiguous worker result runs the deterministic hash checker and never automatically resends GO.

  A crash after spawn but before identity commit leaves durable `prepared` with null pid/start identity and, by protocol, no INIT was sent. Startup may deterministically close it as canceled/not_applied after the old Daemon lock is stale; the unbound worker knows no target/content/capability and exits on pipe EOF. Once identity is persisted, every recovery/shutdown path must verify that exact identity is stale before writing recovery facts.

  Generate operation id, dispatch nonce, ToolRun id, and Event ids before each transaction. Every CAS checks exactly one changed row.

  `runtimes/tool-worker/package.json` depends only on `@agent-workbench/protocol` and `@agent-workbench/file-safety`. Add build/typecheck scripts, run `pnpm install`, and use the shared `ToolWorkerEnvelope` and file-safety implementations rather than duplicated private protocols/checks.

- [ ] **Step 6: Extend explicit shutdown safely**

  Coordinator quiesces first. Runner channel is fenced; in-flight model fetch is aborted; worker control pipe closes; direct children receive TERM, then KILL after a bounded condition wait. While SQLite remains open, use the same execution-recovery projection as startup. Only after all child identities are confirmed stale may cleanup close SQLite and release the runtime lock. A suspected live worker returns `ORPHAN_EXECUTOR_SUSPECTED` and prevents a success shutdown claim.

- [ ] **Step 7: Run tests and confirm GREEN**

  Run:

  ```bash
  pnpm test packages/file-safety/src/atomic-text-writer.test.ts runtimes/tool-worker/src/write-text-worker.test.ts services/daemon/src/tools/fs-write-text.test.ts tests/integration/write-ready-go.test.ts tests/integration/write-recovery.test.ts tests/integration/craft-read-write.test.ts tests/integration/scheduler-restart.test.ts
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm build
  ```

  Expected: all pass; the fake model reads notes and writes summary through a real one-shot worker.

- [ ] **Step 8: Commit**

  ```bash
  git add packages/file-safety/src/atomic-text-writer.ts packages/file-safety/src/atomic-text-writer.test.ts packages/file-safety/src/index.ts runtimes/tool-worker services/daemon/src/tools/write-worker-supervisor.ts services/daemon/src/tools/fs-write-text.ts services/daemon/src/tools/fs-write-text.test.ts services/daemon/src/tools/tool-gateway.ts services/daemon/src/runtime/execution-recovery.ts services/daemon/src/runtime/startup-recovery.ts services/daemon/src/server.ts services/daemon/src/index.ts tests/fixtures/crash-write-worker.ts tests/integration/write-ready-go.test.ts tests/integration/write-recovery.test.ts tests/integration/craft-read-write.test.ts tests/integration/scheduler-restart.test.ts pnpm-lock.yaml
  git commit -m "feat: add crash-safe text writes"
  ```

### Task 6: Register immutable Markdown Artifacts and expose consistent Outcome/Snapshot reads

**Files:**
- Modify: `packages/protocol/src/rpc.ts`
- Modify: `packages/protocol/src/rpc.test.ts`
- Modify: `packages/protocol/src/runtime.ts`
- Modify: `packages/protocol/src/execution.ts`
- Create: `services/daemon/src/db/artifact-repository.ts`
- Create: `services/daemon/src/artifacts/blob-store.ts`
- Create: `services/daemon/src/artifacts/blob-store.test.ts`
- Create: `services/daemon/src/artifacts/artifact-service.ts`
- Create: `services/daemon/src/artifacts/artifact-service.test.ts`
- Create: `services/daemon/src/artifacts/turn-outcome-service.ts`
- Create: `services/daemon/src/artifacts/turn-outcome-service.test.ts`
- Modify: `services/daemon/src/tools/tool-gateway.ts`
- Modify: `services/daemon/src/db/session-repository.ts`
- Modify: `services/daemon/src/runtime/session-service.ts`
- Modify: `services/daemon/src/rpc/router.ts`
- Modify: `services/daemon/src/server.ts`
- Create: `tests/integration/artifact-register.test.ts`
- Create: `tests/integration/artifact-get.test.ts`
- Create: `tests/integration/session-execution-snapshot.test.ts`

- [ ] **Step 1: Write failing Blob and Artifact registration tests**

  Register only `artifact.register` version `1.0.0`, mode `transactional_intrinsic`, and require exact input:

  ```ts
  {
    sourceHandle: string;
    logicalName: string;
    visibility: "final";
    artifactType: "markdown";
    registrationKey: string;
  }
  ```

  A successful `fs.write_text` result contains a random opaque `sourceHandle` bound to its Turn, ToolRun, canonical path, content hash, and current execution fence. Assert registration is allowed only when that opaque handle resolves to a succeeded `fs.write_text` from the same Turn/fence and the current guarded file SHA-256 still equals that Tool result. Runner/model never receives the raw ToolRun id. Reject current-file drift, another Turn's handle, a stale fence, non-Markdown input, non-final visibility, protected paths, and files over 1 MiB.

  The first lookup is `(source_turn_id,registration_key)`. An identical replay returns the existing ArtifactVersion without rereading a now-missing/changed workspace path; the same key with a different normalized input hash returns `ARTIFACT_REGISTRATION_CONFLICT`.

- [ ] **Step 2: Write failing atomic Blob installation tests**

  Store Blobs beneath `<dataDir>/blobs/sha256/<first-two>/<sha256>` with `0700` directories and `0600` files. Test temp write, file fsync, no-clobber atomic install, directory fsync, deduplication, hash/size verification, and cleanup of temp files. A crash after file install but before DB commit may leave only an unreferenced Blob file; it must expose no Artifact and may be collected later.

- [ ] **Step 3: Write failing `artifact.get`, Snapshot, and Outcome tests**

  Add Main RPC:

  ```ts
  artifact.get {
    sessionId: string;
    artifactVersionId: string;
  }
  ```

  Its result contains Artifact/Version metadata plus:

  ```ts
  preview: {
    kind: "markdown";
    text: string;
    truncated: boolean;
    returnedBytes: number;
    totalBytes: number;
  }
  ```

  Enforce top-level/payload Session equality, Artifact ownership by that Session, immutable Blob lookup, UTF-8 validation, hash/size verification, and a 256 KiB UTF-8-safe preview limit. Never return `storage_relpath`, the workspace path, or Blob bytes beyond the preview.

  Extend SessionSnapshot with strictly ordered `modelCalls`, `modelAttempts`, `toolRuns`, `artifacts`, `artifactVersions`, and terminal-only `turnOutcomes`. Read all arrays and `highWaterSeq` in one SQLite read transaction. Snapshot includes Artifact metadata and SHA-256/size, never preview text.

  TurnOutcome is derived in the same read transaction from terminal Turn, Message, Model/Tool facts, ArtifactVersions, and effect resolutions. Checklist and Skill summaries are zero in this slice. Usage sums all persisted ModelAttempt token columns for the Turn and sets `incomplete=true` if any terminal Attempt lacks final usage. It performs no writes and no model call. A Turn with any unresolved unknown effect cannot have `terminalStatus=succeeded`.

- [ ] **Step 4: Run focused tests and confirm RED**

  Run:

  ```bash
  pnpm test services/daemon/src/artifacts/blob-store.test.ts services/daemon/src/artifacts/artifact-service.test.ts services/daemon/src/artifacts/turn-outcome-service.test.ts tests/integration/artifact-register.test.ts tests/integration/artifact-get.test.ts tests/integration/session-execution-snapshot.test.ts
  ```

  Expected: FAIL because Blob, Artifact, preview, and expanded Snapshot services do not exist.

- [ ] **Step 5: Implement Artifact registration transaction**

  Before resolving `sourceHandle`, opening the workspace path, or installing a Blob, perform a read transaction lookup by `(source_turn_id,registration_key)` and normalized registration input hash. An identical hit returns the existing Version immediately even if the handle is no longer resolvable or the workspace file changed/disappeared; a different hash fails `ARTIFACT_REGISTRATION_CONFLICT`. Only a miss may resolve the handle and copy/install bytes.

  After a miss and Blob file installation, one `BEGIN IMMEDIATE` transaction must:

  - recheck registration replay/conflict;
  - validate the source handle, source ToolRun, execution fence, and that the single copied byte stream installed in Blob Store hashes to the successful write's expected SHA-256;
  - insert/reuse the Blob row;
  - create/reuse logical Artifact and allocate `version=MAX+1`;
  - insert ArtifactVersion and Daemon-generated provenance containing source Turn, resolved fs.write ToolRun, model call/attempt, exact Tool versions, and content hash;
  - update Artifact.current_version_id with compare-and-set;
  - set the free-Craft Markdown Version validation status to `unchecked`;
  - terminalize the `artifact.register` ToolRun as succeeded/not_applied;
  - append `tool.succeeded`, `artifact.created` when new, and `artifact.version_created` Events while advancing the Session event high-water/revision.

  No Artifact row or Event is visible before commit.

- [ ] **Step 6: Implement read models and confirm GREEN**

  Run:

  ```bash
  pnpm test packages/protocol/src/rpc.test.ts services/daemon/src/artifacts/blob-store.test.ts services/daemon/src/artifacts/artifact-service.test.ts services/daemon/src/artifacts/turn-outcome-service.test.ts tests/integration/artifact-register.test.ts tests/integration/artifact-get.test.ts tests/integration/session-execution-snapshot.test.ts tests/integration/session-persistence.test.ts
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm build
  ```

  Expected: all pass; legacy Session snapshots now contain empty execution arrays, and completed Craft snapshots contain consistent metadata and Outcome ids.

- [ ] **Step 7: Commit**

  ```bash
  git add packages/protocol/src/rpc.ts packages/protocol/src/rpc.test.ts packages/protocol/src/runtime.ts packages/protocol/src/execution.ts services/daemon/src/db/artifact-repository.ts services/daemon/src/artifacts services/daemon/src/tools/tool-gateway.ts services/daemon/src/db/session-repository.ts services/daemon/src/runtime/session-service.ts services/daemon/src/rpc/router.ts services/daemon/src/server.ts tests/integration/artifact-register.test.ts tests/integration/artifact-get.test.ts tests/integration/session-execution-snapshot.test.ts
  git commit -m "feat: register immutable markdown artifacts"
  ```

### Task 7: Add the full `smoke:craft` restart gate and development runbook

**Files:**
- Create: `scripts/craft-smoke.ts`
- Create: `tests/integration/craft-smoke.test.ts`
- Create: `docs/development/headless-craft-skeleton.md`
- Modify: `package.json`
- Modify: `docs/development/runtime-foundation.md`

- [ ] **Step 1: Write the failing end-to-end smoke test**

  Execute `pnpm smoke:craft -- --keep-data`. The harness must:

  - create a temp Workspace with a fixed UTF-8 `notes.md`;
  - start the loopback Fake OpenAI Server in the harness process;
  - construct DaemonServer with in-memory test model configuration and source Runner/worker launch commands;
  - authenticate over the normal Unix RPC socket;
  - create one Session whose prompt requests three bullet points in `summary.md` and a final Artifact;
  - keep the authenticated client connected until the Turn is Terminal;
  - use scripted SSE responses in this exact order: `fs.read_text`, `fs.write_text`, `artifact.register`, final text with finish reason `stop`; the Fake Server's second response builder must derive the three summary bullets from the actual preceding `fs.read_text` Tool result, and its third response builder must read the preceding write result and echo its opaque `sourceHandle` rather than relying on fixture bytes, a fixed handle, or a raw ToolRun id;
  - fetch and retain the completed Session Snapshot and `artifact.get` preview from the first Daemon;
  - replace `summary.md` with different bytes and fetch `artifact.get` again, proving the first Daemon still returns the registered Blob preview;
  - stop the first Daemon and every child cleanly;
  - start a replacement DaemonServer on the same data directory with a new daemon epoch;
  - authenticate and fetch the replacement Session Snapshot plus `artifact.get`, then compare both with the retained pre-restart values;
  - print exactly one final JSON object.

  Assert the JSON reports:

  - Turn `succeeded`, one completed assistant Message, and slot 1 free;
  - four succeeded ModelCalls/Attempts and three succeeded ToolRuns in the expected order;
  - the generated `summary.md` bytes and SHA-256 captured before external modification;
  - the later replacement workspace bytes/hash are different from the generated file and Artifact;
  - one final Markdown Artifact v1 whose Blob and preview remain equal to the pre-modification generated bytes/SHA-256;
  - `TurnOutcome.finalArtifactVersionIds` contains exactly that version and unresolved effects is empty;
  - pre/post-restart Snapshot metadata and artifact.get preview are deeply equal;
  - Snapshot JSON does not contain the Artifact body or Blob storage path;
  - SQLite `integrity_check=ok`, empty `foreign_key_check`, migrations `[1,2,3,4]`;
  - no live Runner/worker descendants, socket, or owner file after final stop;
  - Fake Server observed no request before model egress Audit intent and no API key outside its Authorization header.

- [ ] **Step 2: Run and confirm RED**

  Run: `pnpm test tests/integration/craft-smoke.test.ts`

  Expected: FAIL because `smoke:craft` is absent.

- [ ] **Step 3: Implement the smoke command without a production fake switch**

  `scripts/craft-smoke.ts` imports Fake Server from testkit and injects execution dependencies through the DaemonServer constructor. Do not modify `services/daemon/src/index.ts` CLI, environment parsing, or Main RPC to carry provider URL/key. `--keep-data` retains the temp root only after every process and socket is stopped; without it the command removes the complete fixture.

  Add root script:

  ```json
  "smoke:craft": "node --conditions=development --import tsx scripts/craft-smoke.ts"
  ```

- [ ] **Step 4: Write the development runbook**

  Document the component/process diagram, exact smoke command, expected JSON fields, retained data layout, how to inspect SQLite/Blob/Artifact metadata, why normal Daemon leaves Turns queued, and the locked deferred scope. State explicitly that Fake Server is test infrastructure and that this slice has no real credential path.

- [ ] **Step 5: Run the focused smoke and confirm GREEN**

  Run:

  ```bash
  pnpm test tests/integration/craft-smoke.test.ts
  pnpm smoke:craft -- --keep-data
  ```

  Expected: both exit 0; command prints one valid JSON object and retains only stopped, inspectable data.

- [ ] **Step 6: Run the complete release gate from a clean process state**

  Run:

  ```bash
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm build
  pnpm smoke:runtime -- --keep-data
  pnpm smoke:craft -- --keep-data
  git diff --check
  git status --short
  ```

  Expected:

  - every command exits 0;
  - runtime smoke still reports a queued Turn because ordinary Daemon has no execution dependencies;
  - craft smoke reports the completed restart-safe Artifact path;
  - retained SQLite databases pass integrity and foreign-key checks;
  - no Runner, worker, Daemon, lock helper, socket, owner file, WAL, or SHM remains live after each command;
  - `git status --short` contains only the intended implementation files.

- [ ] **Step 7: Commit**

  ```bash
  git add scripts/craft-smoke.ts tests/integration/craft-smoke.test.ts docs/development/headless-craft-skeleton.md docs/development/runtime-foundation.md package.json
  git commit -m "test: add headless craft restart smoke"
  ```

## Execution rules

- Execute Tasks 1–7 in order. Do not combine commits across Task boundaries.
- For every production behavior, write the focused test and observe the intended RED before implementation.
- Before every Task commit, run the focused GREEN command plus the full repository `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` gate shown in that Task.
- After each Chunk, run a plan/spec conformance review and a separate code-quality review; fix every Critical or Important finding before proceeding.
- Use `@test-driven-development` for each Task, `@condition-based-waiting` for child/worker/process tests, and `@verification-before-completion` before any completion claim.
- Use real Unix sockets, SQLite files, child processes, inherited pipes, filesystem operations, and native HTTP streaming. Only Provider behavior and model credentials are deterministic test fixtures.
- Never add a Fake Provider branch, scheduler RPC, Tool RPC, raw Blob path, or API key transport to production CLI/environment/Main RPC.
- Never release the scheduler slot while a Runner/worker identity or effect outcome remains unresolved.
- Never derive final assistant text, Tool authorization, Artifact visibility, or Turn success from uncommitted model stream content.
- Before claiming the slice complete, independently inspect the final smoke JSON, SQLite facts, Blob hash, Artifact preview, process table, and retained fixture paths in addition to running the automated gate.
