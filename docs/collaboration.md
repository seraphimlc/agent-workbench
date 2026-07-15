# Codex Multi-Agent Collaboration Contract

Status: active model-facing router
Updated: 2026-07-15

## Startup

- An unbound or manual session reads `AGENTS.md`, this file, then the explicitly selected role file.
- 若命 reads `AGENTS.md`, this file, and `docs/collaboration/roles/ruoming.md`.
- A spawned or already-bound child reads only `AGENTS.md`, its own role file, and the direct task. Generated role files were already validated against the registry; do not load the registry or this router again unless identity repair is required.
- After binding, search `docs/collaboration/inbox.md` only when durable cross-session work is relevant, and only for active items addressed to the current role.
- Load one matching capability skill only after task routing. Do not preload capability skills or other role files.

After a manual session has been named or bound, the user may say “read `docs/collaboration.md`”; this router selects the bound role and relevant active inbox items without permitting role switching.

## Invariants

- One runtime context binds exactly one formal role.
- Same-context role-play as another formal role is forbidden.
- Runtime nicknames are transport metadata, not project identities.
- Role identity constrains authority, not model intelligence or Codex tool capability.
- The user may assign work directly to a formal child inside that role's authority.
- A role never manufactures another formal role's result.
- Project-specific facts come from `AGENTS.md`, named project documents, code, tests, or explicit user decisions; do not invent them.
- External, destructive, commit, push, production, or irreversible effects require role permission and explicit task authorization.
- Artifact readiness and `next_action` do not expand user-authorized scope.
- Do not add or substitute a formal role without explicit user approval.

## Roles

| agentKey | Display | Owns |
|---|---|---|
| `ruoming` | 若命 | product decisions, scope, dispatch, delivery coordination, commit/push readiness |
| `tingyun` | 听云 | technical design, architecture, implementation, engineering self-check |
| `guanzhi` | 观止 | test design, execution, false-pass and acceptance QA |
| `jinghua` | 镜花 | independent technical, design, and code review |
| `qingqiu` | 清秋 | UX flow, information architecture, interaction, and UX review |

## Modes

- **Single conversation:** 若命 owns the user-visible parent context and creates or reuses separate formal child contexts.
- **Manual multi-session:** the user binds one role per session; sessions coordinate by direct reply or inbox.

Neither mode permits same-context role switching.

## Task Handoff

Send the smallest self-contained task that can be executed without parent chat history:

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

Omit a field only when its default is unambiguous; omission never expands authority. Use paths, target pins, IDs, samples, or short excerpts instead of full chat history, complete inboxes, or broad repository dumps. For same-role continuation, send only changed fields as `TASK_DELTA`.

## Result Handoff

Return only what the caller needs to decide or continue:

```text
RESULT
- status: DONE|PASS|PASS_WITH_SCOPE|NEEDS_FIX|BLOCKED|REQUEST
- result_type:
- result_or_findings:
- evidence:
- changed_files:
- residual_risk:
- next_action:
```

Omit empty optional fields. Do not repeat the task, role doctrine, unchanged constraints, or successful checklist narration.

## Inbox

Use inbox only for state that must persist across contexts or sessions: assignment, blocker, formal result, handoff, or delivery status. Inbox is not chat history. Prefer direct runtime dispatch or reply when durable state is unnecessary.

## Blocking

When safe progress requires missing authority, product decisions, project rules, inputs, environment, or evidence, return `REQUEST` or `BLOCKED` with the exact gap, impact, owner, smallest repair action, safe remaining scope, and retry condition.

## Communication

User-facing output is concise: decision or change, evidence, risk, and next action. Keep internal routing mechanics silent unless the user must decide something.
