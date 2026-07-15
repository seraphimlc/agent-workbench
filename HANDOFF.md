# Agent Workbench 开发交接

更新时间：2026-07-15（Asia/Shanghai）

## 1. 新会话先做什么

不要在 Codex 会话默认目录 `new-chat` 中开发。这个仓库专用于 Agent Workbench，后续直接在正式仓库主工作树开发。

正式仓库：

```text
/Users/liuchang/Documents/gitproject/agent-workbench
```

原 `feat/foundation-slice-1` 已快进合并到 `main`，旧 worktree 和功能分支均已删除。新会话的所有检查、测试和代码修改都应显式使用正式仓库作为工作目录。

先执行：

```bash
cd /Users/liuchang/Documents/gitproject/agent-workbench
git status --short --branch
git log --oneline -8
```

交接时的预期状态：

```text
branch: main
HEAD:   49e74c6 fix: quiesce execution before releasing runtime ownership
status: 包含尚未提交的协作初始化、PRD 路径迁移和 fresh-install 测试可复现性修复
```

本文件放在主仓库根目录，方便新会话发现。

## 2. 用户目标与已经锁定的产品决策

目标是做一个类似 WorkBuddy 的本地优先 Agent 工作台。产品分为两层：

1. 通用基础框架：Session、Turn、Runner、模型、Tool、Artifact、恢复、审计和桌面工作台。
2. 业务场景：后续叠加电商 Listing 等 Skill/Scenario/Connector。

当前只做通用工作台；业务层暂时只需要少量 Mock 场景。

已锁定：

- 暂不做团队和云同步。
- 保留 Ask / Plan / Craft 三种模式，当前只实现 Craft。
- 本地工具按 Full Access 产品方向设计，但执行事实必须可审计、可恢复、fail closed。
- 海外文本模型只考虑 ChatGPT / OpenAI-compatible；国内模型以后接入；视觉模型以后使用豆包系列。
- TikTok Shop 美国站、Amazon 美国站 Listing 是后续业务场景。
- `fbm-pipeline` 不复制进内核，未来作为 Connector / Skill / Scenario Adapter 接入。
- 不建设通用 Planner Runtime 或通用 DAG。
- Runtime 只提供可靠原语；业务步骤和交付门由 Skill / Scenario / Validator 定义。
- 最终自然语言回复、TurnOutcome、Artifact 是三种独立事实，不能互相替代。
- UI Timeline 和模型上下文分层。
- 恢复创建新 Turn，不修改历史 Turn。

## 3. 关键文档

PRD：

```text
/Users/liuchang/Documents/gitproject/agent-workbench/docs/specs/2026-07-13-agent-workbench-foundation-design.md
```

当前 7 Task 实施计划：

```text
/Users/liuchang/Documents/gitproject/agent-workbench/.agents/superpowers/specs/2026-07-14-headless-craft-skeleton.md
```

执行时必须按 Task 1 → 7 顺序推进，不合并 Task commit，不提前做后续 Task。

## 4. 已完成内容

### Foundation 前置底座

- 本地 Daemon、Unix RPC、鉴权。
- Workspace / Session / Turn / Event SQLite 持久化。
- 单槽 durable Scheduler。
- Runtime smoke 和重启持久化。

### Task 1：执行协议与账本

主提交：

```text
5faaf71 feat: define craft execution ledger
```

完成：

- 严格 Runner request / response / error 协议。
- Tool Worker INIT / READY / GO / ACK / RESULT / ERROR 协议。
- ModelCall、ModelAttempt、ToolRun、Artifact、TurnOutcome 安全投影。
- migration 003 / 004。
- Turn `execution_fence`。
- 普通 `runDaemon()` 仍无执行能力，不存在生产 Fake 开关。

### Task 2：原子终结、恢复、调度和停机所有权

提交序列：

```text
fdc553a feat: drive queued turns to atomic terminal states
66c7d7a fix: enforce terminalization fail-closed invariants
79fcef0 fix: validate recovered subexecution state
49e74c6 fix: quiesce execution before releasing runtime ownership
```

完成：

- `SessionEventWriter` 只能参与 caller-owned transaction。
- `TurnTerminalizer.succeed/fail/interrupt` 原子收口：
  - ModelCall / ModelAttempt / ToolRun
  - Turn
  - Runner Lease
  - Scheduler slot
  - Session projection
  - Session Events
- Scheduler claim 将 fence `0 → 1`，终结再 fence，迟到回复失效。
- 跨 Session / Turn ownership、Tool source linkage、assistant source 全部 fail closed。
- `fail()` 不允许 applied / confirmed_applied effect 伪装成普通失败。
- Startup recovery 复用同一 terminalization path。
- READY/GO 基础恢复语义：pre-GO 可确定性 not-applied；GO 后 unknown + append-only Resolution。
- Level-triggered ExecutionCoordinator；无轮询、无公开 scheduler/tool executor RPC。
- 只有认证控制连接和执行依赖同时存在时才 claim。
- stop 同步 quiesce，等待 pending start 和 active completion。
- driver shutdown 无法证明退出时保留 SQLite、socket 和 runtime ownership，新 Daemon 不能接管。

## 5. 最近一次已验证门禁

代码迁移到正式仓库后，主代理 fresh 运行：

```text
pnpm test       -> 27 files / 466 tests passed
pnpm typecheck  -> passed
pnpm lint       -> passed
pnpm build      -> passed
git diff --check -> passed
```

不要把这份历史结果当成后续提交的完成证据；每个新提交前必须重新运行完整门禁。

## 6. 当前唯一阻塞项：Task 2 还不能正式关闭

最终代码质量复验已确认此前五个恢复/停机问题关闭，但发现一个 READY/GO truth matrix 缺口。

当前 HEAD `49e74c6` 仍会错误接受：

- worker `queued + go_sent/acknowledged`；
- worker `running/cancel_requested + prepared/worker_ready`；
- already-recovered `transactional_intrinsic + failed/interrupted + unknown`。

现有两个 fixture 还把非法 `queued + GO` 固化成了合法状态：

```text
services/daemon/src/runtime/turn-terminalizer.test.ts（约 1490 行）
tests/integration/scheduler-restart.test.ts（约 1002 行）
```

需要先完成一个独立修复提交：

```text
fix: enforce ready-go status matrix
```

### 最小合法矩阵

Active recovery：

- worker：
  - 仅 `queued + prepared/worker_ready + unknown` 合法，终结为 `canceled/not_applied`；
  - 仅 `running|cancel_requested + go_sent|acknowledged + unknown` 合法，终结为 `interrupted/unknown`；
  - 其它 status × dispatch × effect 组合在任何写入前拒绝。
- read_inline：dispatch 必须 null、effect 必须 not_applied；queued → canceled，其余 active → interrupted。
- transactional_intrinsic：dispatch 必须 null；active 可为 unknown 或 not_applied，但绝不能 applied，恢复时归一为 not_applied；queued → canceled，其余 active → interrupted。

Terminal validation（兼容后续 Task 5）：

- read_inline / transactional_intrinsic：所有 Terminal 状态都必须 null dispatch + not_applied。
- worker succeeded：必须 `acknowledged + applied`。
- worker failed：允许 pre-GO + not_applied；也允许 go/ack + unknown/applied/not_applied，以兼容执行器证据。
- worker canceled：允许任一 durable dispatch + not_applied。
- worker interrupted：至少允许 go/ack + unknown/applied。
- Terminal ToolRun 不回写；effect resolution 始终 append-only。

### 修复方式

1. 先列 test list。
2. 改正错误 fixture。
3. 写 status × mode × dispatch × effect 交叉矩阵测试并观察 RED。
4. 将 active classification 与 already-recovered terminal validation 收成共享纯 validator，避免 TS 判断与 SQL 判断漂移。
5. explicit interrupt 和 first startup 遇到非法 active tuple 都必须零写入失败。
6. 运行 focused、全量 test、typecheck、lint、build、diff-check。
7. 独立提交。
8. 重新做代码质量复验；APPROVE 后才能把 Task 2 标为完成。

交接时 worktree clean，没有正在运行的子代理，也没有未提交的 READY/GO 修复代码。

## 7. Task 2 关闭后的下一步：Task 3

Task 3 目标：打通真实短生命周期 Runner、OpenAI-compatible SSE、Model Gateway 和权威 ToolCall 授权；仍不实现文件读写和 Artifact。

核心要求：

- 新建 `runtimes/session-runner`，只依赖 `@agent-workbench/protocol`。
- Runner 使用 inherited fd 3/4 framed pipes；argv/env 不出现 Turn 身份、capability、API key、Prompt 或 Tool 参数。
- 每个 Claim 生成随机 32-byte base64url capability，只通过 bind pipe 发送。
- 每个 Runner request 回显完整 immutable Binding；capability constant-time compare。
- ready timeout、5 秒 heartbeat / 20 秒 expiry、EOF/crash 都要终止并 reap direct child。
- OpenAI-compatible adapter 使用 native `fetch` 和 `/v1/chat/completions`，只在 Authorization header 放 API key，无重试、无 fake 分支。
- SSE decoder 必须同时看到 terminal finish 和 `[DONE]` 才成功；处理 chunk split、UTF-8、ToolCall fragments、malformed JSON、大小上限和 AbortSignal。
- Fake OpenAI Server 只能放在 `packages/testkit`，使用真实 loopback HTTP；Daemon/Runner 不得依赖 testkit。
- Audit intent 必须在 model fetch 前提交；intent 失败返回 `AUDIT_UNAVAILABLE` 且不发网络请求。
- Tool fragments 只存在内存；完整流结束、allowlist/JSON/Schema 校验成功后才能持久化 `model_tool_calls`。
- `tool.execute` 只接收 `{modelAttemptId, logicalCallId}`，ToolGateway 从持久事实加载 Tool id/arguments。
- stale Lease、cross-Turn Attempt、篡改 logicalCallId、duplicate source 均拒绝。
- Runner Agent Loop 最多 64 个 model/tool cycle；Runner 不构造 Tool schema、不读文件、不接触 Provider 配置。
- final completion 只引用最新成功、stop、无 ToolCall 的 ModelAttempt。
- startup 遇到旧 Runner identity 必须先证明 exact pid/start identity 已退出；live/ambiguous 返回 `ORPHAN_EXECUTOR_SUSPECTED` 且零恢复写入。
- explicit shutdown 在 SQLite 关闭前 fence channel、abort fetch、reap Runner、原子 interrupt。
- Task 3 同时补齐 ModelCall/ModelAttempt terminal Event payload 的 modelCallId、modelAttemptId、ordinal/attempt，便于 replay 和诊断。

Task 3 不得提前实现：

- `fs.read_text`
- `fs.write_text`
- Tool Worker
- Artifact 注册/预览
- UI / Electron
- Keychain / 真实凭据设置页
- Skill / Scenario Loader

Task 3 计划提交信息：

```text
feat: run craft turns through streamed model calls
```

## 8. 开发纪律

- 直接在 `/Users/liuchang/Documents/gitproject/agent-workbench` 的 `main` 工作树开发；除非用户以后明确要求，不再创建项目外部 worktree。
- 每个行为严格 TDD：test list → RED → minimal GREEN → refactor。
- 子进程、HTTP、socket 和异步测试使用 Event/Promise barrier 或条件等待，不使用猜测性 sleep。
- 一次只允许一个写代码的实现代理；审查代理只读。
- 每个 Task 先规格审查，再代码质量审查；Critical/Important 未关闭不能进入下一 Task。
- 不信任代理自述；主代理必须检查 git diff 并 fresh 重跑门禁。
- 不把 Fake Provider、API key、scheduler tick、tool executor RPC 暴露到生产 CLI/env/Main RPC。
- 不把 Task3/4/5 合并成一个大提交。

## 9. 新会话建议的首条指令

可以直接对新会话说：

> 阅读 `/Users/liuchang/Documents/gitproject/agent-workbench/HANDOFF.md`，并在 `/Users/liuchang/Documents/gitproject/agent-workbench` 的 `main` 工作树继续。先按 TDD 修复 HANDOFF 第 6 节的 READY/GO status matrix，完成代码质量复验并关闭 Task 2；通过后按实施计划开始 Task 3。不要在 `new-chat` 目录开发，也不要另建项目外部 worktree。
