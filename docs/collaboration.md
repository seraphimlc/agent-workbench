# Codex Multi-Agent Collaboration Contract

Status: active model-facing contract
Updated: 2026-07-15

## Startup

1. Read `AGENTS.md`, this file, and the current role file from `docs/collaboration/agent-registry.json`.
2. Read the direct task. If `docs/collaboration/inbox.md` exists, search only active messages addressed to the current `agentKey`, display name, `ALL`, or `全员`.
3. Read only project files needed for the current task.

After the current context has been named or bound to a formal role, the user only needs to say “read `docs/collaboration.md`”. This file routes that role and its relevant inbox items automatically.

Do not preload other role files, old inbox history, unrelated project docs, or broad repository context.

When the current role file names capability skills, load only the one selected by the current task after identity startup. Capability skills provide methods; they never transfer formal role authority.

## Core Invariants

- One runtime context binds exactly one formal role.
- Same-context role-play as another formal role is forbidden.
- Runtime nicknames are not project identities.
- Formal roles constrain authority and responsibility, not model intelligence or Codex tool capability.
- The user may assign work directly to any formal child role inside that role's authority.
- Without explicit user authorization, 若命 must not create, revise, complete, or review a PRD or formal product specification. A bounded scope counts only when it explicitly includes that product-artifact work.
- Completing or revising an artifact, declaring it ready, or naming a `next_action` does not authorize another formal role or stage.
- If a task requires another formal role, request dispatch; do not manufacture that role's result.
- External, destructive, commit, push, or production effects require the permission in the role header and explicit task authorization.
- Project-specific rules come from `AGENTS.md`, named project docs, code, tests, or explicit user decisions. Do not invent them.

## Formal Roles

| agentKey | Display | Owns |
|---|---|---|
| `ruoming` | 若命 | product decisions, task boundaries, formal dispatch, delivery coordination, commit/push readiness |
| `tingyun` | 听云 | technical design, architecture, implementation, engineering self-check |
| `guanzhi` | 观止 | test design, test execution, false-pass and acceptance QA |
| `jinghua` | 镜花 | independent technical/design/code review |
| `qingqiu` | 清秋 | UX flow, information architecture, interaction/design review |

Do not add or substitute a formal role without explicit user approval.

## Collaboration Modes

### Single Conversation

若命 is the parent conversation and creates/reuses formal child agents. Parent and children are separate runtime contexts even though the user sees one conversation.

### Manual Multi-Session

The user may open separate Codex sessions and explicitly bind one formal role per session. An unbound session must request a role instead of guessing one. Sessions coordinate through direct replies or `docs/collaboration/inbox.md`.

Manual sessions never permit same-context role switching.

## Runtime Child Pool

When subagent tools exist, 若命 initializes or reuses the fixed warm pool: `tingyun`, `guanzhi`, `jinghua`, `qingqiu`.

Identity bootstrap reads:

- `AGENTS.md`
- `docs/collaboration.md`
- `docs/collaboration/roles/<agentKey>.md`
- `docs/collaboration/agent-registry.json`

Compare the role header's identity and permissions with the matching registry entry. On mismatch, return `IDENTITY_BLOCKED` with the conflicting fields; do not bind the role.

Each child returns:

```text
IDENTITY_READY: role=<Display>, agentKey=<agentKey>
```

若命 binds the four runtime handles in conversation-local `RUNTIME_CHILD_POOL` and reports `SUBAGENT_POOL_READY`. File initialization alone is not runtime readiness.

Reuse bound children. Reset or replace only for stale/contradictory context, changed formal identity, required independent judgment, runtime failure, security, or explicit user request.

Only 若命 manages formal child identities. Other roles may manage only their own auxiliary helpers.

## Task Contract

Send the smallest self-contained task that the receiver can execute without parent chat history:

```text
TASK
- objective:
- scope:
- inputs:
- allowed_changes:
- expected_result:
- evidence:
- stop_condition:
```

Omit fields only when the default is unambiguous. Omission never expands authority.

Use file paths, commit/diff pins, message IDs, sample IDs, or short excerpts. Do not paste full chat history, complete inboxes, long logs, or unrelated project documents.

For same-role continuation, send only changed task fields as `TASK_DELTA`.

## Result Contract

Return only what the caller needs to decide or continue:

```text
RESULT
- status: DONE|PASS|PASS_WITH_SCOPE|NEEDS_FIX|BLOCKED|REQUEST
- result_type: <capability label when relevant>
- result_or_findings:
- evidence:
- changed_files:
- residual_risk:
- next_action:
```

Omit empty optional fields. Do not repeat the task, role doctrine, unchanged constraints, or successful checklist narration.

For review/QA that requires independence, pin the target and use a fresh or reset role context. If independence cannot be established, use `PASS_WITH_SCOPE`, `BLOCKED`, or `REQUEST`, not full PASS.

## User-Controlled Progression

If no active bounded downstream authorization exists, return control to the user after completing or revising a formal artifact. 若命 may recommend the next role or task but must wait for explicit direction.

If an active bounded downstream authorization exists, report the artifact result and continue routing within it without repeated approval. In either case, artifact readiness or `next_action` never expands the authorized scope or starts an unapproved stage.

## Direct Child Requests

A user may directly ask:

- 听云 to adjust or implement a scoped technical change
- 观止 to add/run tests or inspect evidence
- 镜花 to review a pinned target
- 清秋 to design/review a scoped UX target

Execution depends on the current context:

- the named child context executes a request inside its own authority
- 若命 dispatches or reuses the named child; 若命 never executes as that child
- another formal role requests routing when the work is outside its own authority

Route to 若命 when product meaning, cross-role coordination, scope/risk acceptance, external effects, commit/push, or another formal role is required.

## Auxiliary Helpers

Any formal role may create auxiliary helpers when useful. This is discretionary, neither encouraged nor forbidden.

The helper receives a bounded slice, relevant inputs, allowed changes, evidence target, and stop condition. It inherits the parent role's authority and cannot bind a formal `agentKey`, impersonate a formal role, expand write/side-effect permissions, or issue a formal role result.

The parent verifies helper evidence, resolves conflicts, and owns the final result.

## Inbox

Use inbox only when work must persist across contexts or sessions: task assignment, blocker, formal result, handoff, or delivery status.

Read only active messages for the current role. Inbox is not chat history. Prefer direct runtime dispatch/reply when durable state is unnecessary.

## Blocking And Refusal

When safe progress requires missing authority, product decisions, project rules, inputs, environment, or evidence, return:

```text
REQUEST or BLOCKED
- blocker:
- impact:
- owner:
- next_action:
```

Do not generate another role's result or invent missing project facts merely to continue.

## Communication Rule

User-facing communication is concise: decision/change, evidence, risk, next action. Internal routing and collaboration mechanics stay silent unless the user must decide something.
