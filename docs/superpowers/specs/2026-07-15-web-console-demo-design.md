# Agent Workbench 本机 Web Console 演示版设计

## 1. 背景

Agent Workbench 已完成 Daemon、Session Runner、SQLite 持久化、调度、模型网关、Tool Gateway 和恢复边界，但尚无桌面 Renderer。当前需要一个可向伙伴现场演示的本机 Web UI，证明现有执行链可以通过真实模型接口完成真实 Turn，而不是制作静态效果图。

本设计继承 `docs/specs/2026-07-13-agent-workbench-foundation-design.md` 中基于 WorkBuddy 研究确定的三栏工作区、Timeline、Inspector 和本地优先边界。Web Console 是桌面 UI 前的临时产品入口，不建立第二套运行时语义。

## 2. 目标

演示者只需：

1. 配置本机 Provider 环境变量。
2. 运行一条启动命令。
3. 在 `127.0.0.1` 页面输入任务并点击运行。
4. 看到真实 Session、Turn、模型调用、`fs.read_text`、最终回复和失败状态。

第一版的成功标准是“真实、稳定、像一个认真做的产品”，不是覆盖完整桌面 MVP。

## 3. 非目标

- 不支持公网或局域网访问。
- 不实现账号、团队、同步或云端部署。
- 不实现完整 Session 历史查询；现有 RPC 尚无列表接口。
- 不实现 Artifact、附件、Scenario、Ask、Plan 或设置中心。
- 不实现 Token 级流式回复。当前权威协议只在模型调用和 Turn 事件粒度更新；UI 不伪造流式文字。
- 不实现桌面打包、Keychain 或 Electron Main。

## 4. 产品与视觉设计

### 4.1 设计语言

采用 WorkBuddy 类专业任务工作台，而不是终端皮肤或营销大屏：

- 暖灰应用画布、白色工作面板、深墨色正文。
- 靛蓝作为唯一主强调色；绿色、琥珀色、红色只表达状态。
- 清晰的排版层级、稳定网格、克制阴影和 8–14 px 圆角。
- 动效只用于状态变化、Timeline 插入和 Inspector 切换。
- 不依赖外部字体或 CDN，保证本机离线加载 UI。

### 4.2 三栏工作区

左栏：

- 产品标识和 Daemon 状态。
- 当前 workspace。
- “新建任务”。
- 当前 Session 摘要。
- 不展示无法从权威 RPC 获取的虚假历史列表。

中栏：

- Session 标题、模型、Craft / Full Access 和运行状态。
- 用户消息、Agent 最终回复、模型事件、Tool 卡片和错误卡片组成的 Timeline。
- 底部多行 Composer 和运行按钮。
- Turn 运行期间可继续提交，沿用现有 `turn.enqueue` FIFO 语义。

右栏：

- 当前选中事件的 Inspector。
- 显示事件时间、Turn、模型、调用阶段、Tool 输入/输出摘要和错误码。
- 右栏可折叠；窄窗口降级为抽屉。

### 4.3 状态呈现

- `queued`：中性队列标记。
- `running`：蓝色活动标记和真实事件进度。
- `succeeded`：绿色完成标记及最终回复。
- `failed` / `error`：红色结构化错误卡片，保留错误码。
- RPC 断开：顶部状态条降级，不把旧数据显示为正在运行。

## 5. 系统架构

```text
Browser
  │ localhost HTTP/JSON
  ▼
Web Console Server
  ├─ serves React UI
  ├─ owns Daemon RPC client and bootstrap secret
  ├─ launches configured Daemon child
  └─ exposes sanitized runtime metadata
        │ authenticated Unix socket RPC
        ▼
      Daemon ── Session Runner
        │             │
        ├─ SQLite     ├─ model.call
        ├─ Model Gateway ── OpenAI-compatible Provider
        └─ Tool Gateway ── workspace-scoped fs.read_text
```

新增 `apps/web-console`。它是唯一 HTTP 进程，同时负责 UI 资源、HTTP Bridge 和演示运行时生命周期。浏览器永远不直接连接 Unix Socket，也不接触 Daemon bootstrap secret 或 Provider API Key。

## 6. 运行时启动

根命令 `pnpm demo:web` 启动 Web Console。启动器：

1. 校验 Provider 配置和 workspace。
2. 解析并探测模型能力。
3. 生成 32 字节 Daemon bootstrap secret。
4. 启动 `apps/web-console/src/server/configured-daemon-entry.ts`；该专用子入口读取已校验的 Provider/workspace 配置，构造 `OpenAiCompatibleAdapter`、Session Runner 和 Tool handler，再调用 `runDaemon({ runner })`。
5. 通过 fd 3 把 secret 传给配置后的 Daemon 子进程；Provider 配置通过受控子进程环境传入，bootstrap secret 仍禁止进入环境。
6. 连接并认证 Daemon RPC。
7. 仅在 `127.0.0.1` 启动 HTTP 服务。
8. 输出可打开的本机 URL。

Web Console 收到 `SIGINT` / `SIGTERM` 时先停止 HTTP ingress，再关闭 RPC，最后等待 Daemon、Runner 和子进程退出，避免现场演示留下孤儿进程。

## 7. Provider 配置

环境变量：

- `AGENT_WORKBENCH_PROVIDER_BASE_URL`：OpenAI-compatible `/v1` 基地址。
- `AGENT_WORKBENCH_PROVIDER_API_KEY`：Provider Key，必填。
- `AGENT_WORKBENCH_PROVIDER_MODEL`：可选；显式指定时优先。
- `AGENT_WORKBENCH_DEMO_WORKSPACE`：可选；默认当前仓库根目录。

Key 只存在于 Web Console 和 Daemon 的进程内存/环境中，不写入仓库、数据库、URL、浏览器、响应体或日志。Daemon bootstrap secret 继续只走 fd 3，禁止改为环境变量。

模型解析规则：

1. 若设置 `AGENT_WORKBENCH_PROVIDER_MODEL`，把该模型作为唯一候选，但仍必须通过能力探测。
2. 否则请求 Provider `/models`，过滤明显的 embedding、rerank、image、audio 模型，并最多探测前三个候选。
3. 每个候选先执行普通 chat probe，再使用与生产一致的 `fs.read_text` Tool Schema 执行 tool-call probe。
4. 单次请求和整个探测流程都有明确超时；失败后尝试下一个候选。
5. 选择第一个同时通过 chat 和 tool-call probe 的模型。
6. 无兼容模型时启动失败并显示可操作错误，不静默回退到假模型。

Provider chat endpoint 由 base URL 拼接 `/chat/completions`。UI 只显示 base host、选中模型和健康状态，不显示 Key。

## 8. Daemon 与 Tool 配置

现有默认 Daemon 入口在缺少生产配置时使用 `RUNNER_CONFIGURATION_REQUIRED`。Web Console 提供显式配置入口，注入：

- `OpenAiCompatibleAdapter`。
- 解析后的 endpoint、model 和 API Key。
- Session Runner 入口。
- `fs.read_text` handler。

模型网关不得继续向模型宣告当前 Tool Gateway 无法执行的 `fs.write_text`。第一版只发布已安装的 `fs.read_text` 定义。

`fs.read_text` handler：

- 只接受 workspace 相对路径。
- 拒绝绝对路径、空路径和 `..` 越界。
- 启动时拒绝 workspace 与 Daemon data/runtime/control-plane 目录重叠。
- 打开文件时使用 no-follow 标志；打开后用 `fstat` 验证普通文件，并复核 canonical 路径与设备/inode 身份仍属于 workspace，拒绝通过符号链接或检查/使用竞态逃离 workspace。
- 最多读取 `256 KiB + 1` 字节；超过 256 KiB 立即失败，不先把完整文件载入内存。
- 使用严格 UTF-8 解码，拒绝替换字符式容错。
- 错误以稳定错误码返回，不泄露 workspace 外路径。

## 9. HTTP Bridge

HTTP API 只监听 loopback，并设置 `Cache-Control: no-store`。Server 只接受启动时确定的 `127.0.0.1:<port>` / `localhost:<port>` Host；拒绝其他 Host、所有 CORS 请求和跨源 Origin。写请求必须使用 `application/json`、携带精确同源 `Origin`，并提交每次启动随机生成的 CSRF token。token 只通过同源 HTML bootstrap 数据交给页面，不写入 URL、日志或持久化存储。页面同时使用限制脚本来源的 CSP。第一版接口：

- `GET /api/runtime`：Daemon、Provider、模型和 workspace 的脱敏状态。
- `POST /api/sessions`：注册 workspace 并调用 `session.create`；请求包含浏览器为本次逻辑提交生成的 UUID `submissionId`。
- `POST /api/sessions/:sessionId/turns`：调用 `turn.enqueue`；请求包含浏览器为本次逻辑提交生成的 UUID `submissionId`。
- `GET /api/sessions/:sessionId/snapshot`：调用 `session.getSnapshot`。
- `GET /api/sessions/:sessionId/events?afterSeq=<n>&limit=<n>`：调用 `event.listAfter`。

所有请求和响应使用 Zod 校验。Bridge 只接受规范 UUID `submissionId`，并稳定映射为方法域隔离的 `clientRequestId`；同一逻辑提交的 HTTP 重试必须复用同一 `submissionId`，从而命中 Daemon 幂等语义。浏览器不能控制其余 Daemon RPC envelope、trace、认证状态或 socket 路径。

Browser 将当前 Session ID 保存在 `localStorage`。页面刷新后先请求 Snapshot；Session 不存在或数据目录已重置时回到新建任务页。

## 10. 实时数据流

1. 用户提交首个任务。
2. Bridge 注册默认 workspace，创建 Session 和首个 Turn。
3. Browser 获取 Snapshot，记录 `highWaterSeq`。
4. Browser 每 500 ms 调用 `event.listAfter`。
5. 新事件按 `seq` 追加到 Timeline，并触发 Snapshot 刷新以获取权威 Message/Turn 投影。
6. `turn.succeeded` 后从 Snapshot 的 `resultMessageId` 展示最终回复。

若事件序列出现缺口、游标倒退或响应校验失败，Browser 停止增量应用并重新请求完整 Snapshot。UI 不从日志文本推断状态。

## 11. Tool 可观察性

当前 ToolRun 已持久化，但 Renderer Event 中没有正常执行的 Tool 事件。为了真实展示既有能力，Tool Gateway 将 ToolRun 状态变化与对应 Event 放在同一个 SQLite 事务中提交：

- `tool.started`：`toolRunId`、`toolId`、脱敏输入摘要。
- `tool.succeeded`：`toolRunId`、输出字节数、截断后的输出摘要。
- `tool.failed`：`toolRunId`、稳定错误码。

`tool.started` 与 ToolRun `running` 插入原子提交；`tool.succeeded` / `tool.failed` 与对应终态更新原子提交。崩溃后不得出现没有 ToolRun 的幽灵事件，也不得出现已经提交终态但缺少对应 Renderer Event 的状态。

Provider Key、Daemon secret 和其他启动时登记的 secret 在 Tool 结果持久化、Event 构造和 HTTP 响应之前做精确值脱敏。事件 payload 不保存 workspace 外路径。输出摘要有严格长度上限；脱敏后的完整 Tool 结果继续以数据库执行记录为权威，不复制到浏览器事件中。

## 12. 错误处理

启动错误：

- Provider 配置缺失、模型探测失败、端口占用、Daemon 启动失败均在终端输出稳定错误码。
- HTTP 服务未就绪前不输出演示 URL。

运行错误：

- Provider 非 2xx、SSE 无效、Runner 失败和 Tool 失败沿用现有错误码。
- UI 显示错误卡片和可重试的新 Turn Composer，不把失败包装成最终答案。
- RPC 断开后 Bridge 尝试有限重连；失败则将 Runtime 标记为 unavailable。

浏览器错误：

- HTTP 非 2xx、Schema 不匹配和事件缺口进入明确错误态。
- 用户输入在请求期间锁定对应按钮，防止重复提交；网络层重试复用原 `submissionId`，Daemon 幂等键是最终防线。

## 13. 技术选择

- React + TypeScript：符合既定桌面 Renderer 方向，组件可迁移。
- Vite middleware：开发时由同一 Node 进程提供 UI，保持一条启动命令。
- 原生 CSS variables：不引入大型组件库，直接实现 WorkBuddy 风格视觉系统。
- Node HTTP：第一版接口很小，不引入 Web 框架。
- Browser polling：复用现有 `event.listAfter`，不新增伪实时协议。

## 14. 测试策略

单元测试：

- Provider URL、模型选择和配置脱敏。
- workspace/control-plane 重叠拒绝、no-follow/canonical/文件身份边界、严格 UTF-8 和读取大小限制。
- HTTP 请求/响应 Schema。
- Host、Origin、Content-Type、CORS 和 CSRF 拒绝矩阵。
- `submissionId` 到 `clientRequestId` 的稳定幂等映射。
- Event 到 Timeline view model 的确定性映射。

集成测试：

- Fake OpenAI Server → configured Daemon → Runner → model → `fs.read_text` → final reply。
- Tool started/succeeded/failed 事件顺序和重连 Snapshot。
- ToolRun 状态与 Tool Event 的事务原子性和崩溃恢复。
- HTTP Bridge 不返回 Key、bootstrap secret 或未脱敏路径。
- Tool 读取内容中包含已登记 secret 时，数据库、Event、模型上下文和 HTTP 均只出现脱敏值。
- SIGINT 关闭后 Daemon 和 Runner 全部退出。

浏览器测试：

- 新建任务、Timeline 更新、Inspector 选择、最终回复和错误卡片。
- 刷新页面后从 Snapshot 恢复当前 Session。
- 窄窗口右栏抽屉行为。

真实接口 smoke：

- 使用本机环境变量执行，不进入默认 CI。
- 读取仓库 `README.md`，要求至少一次真实模型调用、一次成功 `fs.read_text` 和成功 Turn。
- 只报告模型名、状态和调用链，不打印 Key 或完整 Provider 响应。

完成前执行现有 `typecheck`、`lint`、`test` 和 `build`。

## 15. 验收标准

1. `pnpm demo:web` 一条命令启动完整演示链并输出 loopback URL。
2. 页面具有专业三栏工作台视觉，不是测试夹具页面。
3. 用户输入任务后创建真实 Session/Turn。
4. UI 展示真实 queued/running/model/tool/terminal 事件，不伪造 Token 流。
5. 真实 Provider 可调用，兼容模型可自动解析或显式配置。
6. `fs.read_text` 只能读取当前 workspace 内文本文件。
7. 最终回复来自持久化 assistant Message，刷新后可恢复。
8. Provider、Runner 或 Tool 失败时 UI 明确显示失败。
9. API Key 和 bootstrap secret 不出现在仓库、数据库、浏览器、URL 或日志中。
10. 退出 Web Console 后不遗留 Daemon 或 Runner 子进程。

## 16. 分支与交付

Web Console 在 `codex/web-ui-preview` 开发，不直接修改 `main`。该分支基于当前 Runner/Model Gateway 分支形成 stacked change；上游合并后再 rebase 或调整 PR base。
