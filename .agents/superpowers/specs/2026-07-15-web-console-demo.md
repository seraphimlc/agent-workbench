# Agent Workbench Web Console Demo Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished localhost Web Console that launches the configured Daemon/Runner chain, calls a real OpenAI-compatible provider, executes workspace-scoped `fs.read_text`, and displays authoritative Session/Turn/model/tool/final-result state.

**Architecture:** Add `apps/web-console` as a single Node process that serves a React UI, enforces browser-origin security, owns the authenticated Daemon RPC connection, and supervises a configured Daemon child. Keep execution truth in the existing Daemon/SQLite/Event model; the browser polls `event.listAfter`, rebuilds from Snapshot on gaps, and never fabricates token streaming.

**Tech Stack:** TypeScript, Node HTTP, React, Vite middleware, Zod, existing Daemon RPC/frame protocol, Vitest, React Testing Library, SQLite integration fixtures.

---

## File Map

### Existing files to modify

- `package.json` — add `demo:web` root command.
- `.gitignore` — ignore `.superpowers/`, `.DS_Store`, and local preview runtime output.
- `services/daemon/package.json` — expose the supported Daemon composition entry.
- `services/daemon/src/index.ts` — pass registered secret encodings into the execution driver and export composition types.
- `services/daemon/src/model/model-gateway.ts` — publish only configured builtin Tool definitions.
- `services/daemon/src/runtime/runner-supervisor.ts` — derive model Tool definitions from installed handlers and pass the shared redactor into Tool Gateway.
- `services/daemon/src/tools/tool-gateway.ts` — commit ToolRun state and renderer Tool Events atomically; redact Tool results before persistence and Runner return.
- `tests/integration/model-tool-authorization.test.ts` — cover Tool Event atomicity, configured Tool exposure, and redaction.
- `packages/testkit/src/fake-openai-server.ts` — support `GET /models` and reusable request matching for probe/integration tests.
- `packages/testkit/package.json` — retain the fake provider export after extension.
- `runtimes/session-runner/package.json` — add an export so the configured Daemon can resolve the Runner entry without importing it.
- `vitest.config.ts` — include `.tsx` tests and jsdom test files.
- `pnpm-lock.yaml` — lock React/Vite/testing dependencies.

### New Daemon support files

- `services/daemon/src/security/secret-redactor.ts` — exact-value secret redaction shared by process output and Tool results.
- `services/daemon/src/security/secret-redactor.test.ts` — redaction edge cases.

### New Web Console server files

- `apps/web-console/package.json` — package scripts and dependencies.
- `apps/web-console/tsconfig.server.json` — Node server build/typecheck.
- `apps/web-console/tsconfig.client.json` — React client typecheck.
- `apps/web-console/vite.config.ts` — client build and middleware configuration.
- `apps/web-console/index.html` — local application shell.
- `apps/web-console/src/shared/contracts.ts` — Zod HTTP payload/result contracts.
- `apps/web-console/src/server/config.ts` — environment parsing and sanitized runtime metadata.
- `apps/web-console/src/server/model-probe.ts` — `/models`, chat probe, and Tool capability probe.
- `apps/web-console/src/server/workspace-read-tool.ts` — no-follow, bounded, strict UTF-8 workspace reads.
- `apps/web-console/src/server/daemon-rpc-client.ts` — authenticated Unix socket RPC client.
- `apps/web-console/src/server/configured-daemon-entry.ts` — real Adapter/Runner/Tool composition passed to `runDaemon`.
- `apps/web-console/src/server/daemon-process.ts` — bootstrap fd, child supervision, readiness, and shutdown.
- `apps/web-console/src/server/http-security.ts` — Host/Origin/CORS/Content-Type/CSRF/CSP enforcement.
- `apps/web-console/src/server/http-api.ts` — sanitized HTTP-to-RPC routing and idempotency mapping.
- `apps/web-console/src/server/index.ts` — Vite middleware, API, process lifecycle, and startup URL.
- `apps/web-console/src/server/*.test.ts` — focused server tests next to each module.

### New Web Console client files

- `apps/web-console/src/client/main.tsx` — React mount.
- `apps/web-console/src/client/api.ts` — typed HTTP client, CSRF, polling, and submission IDs.
- `apps/web-console/src/client/view-model.ts` — deterministic Snapshot/Event to Timeline projection.
- `apps/web-console/src/client/view-model.test.ts` — projection and event-gap tests.
- `apps/web-console/src/client/App.tsx` — application state and three-column composition.
- `apps/web-console/src/client/components/NavigationRail.tsx` — workspace/current Session navigation.
- `apps/web-console/src/client/components/SessionHeader.tsx` — model/mode/runtime status.
- `apps/web-console/src/client/components/Composer.tsx` — initial Session and queued Turn submission.
- `apps/web-console/src/client/components/Timeline.tsx` — message/model/tool/error/final cards.
- `apps/web-console/src/client/components/Inspector.tsx` — selected item details and narrow-screen drawer.
- `apps/web-console/src/client/App.test.tsx` — user-flow tests under jsdom.
- `apps/web-console/src/client/styles.css` — WorkBuddy-style design tokens and responsive layout.

### New integration and operator files

- `tests/fixtures/run-web-console-daemon.ts` — configured Daemon fixture for process tests.
- `tests/integration/web-console-runtime.test.ts` — fake provider end-to-end execution.
- `tests/integration/web-console-shutdown.test.ts` — no orphan Daemon/Runner after shutdown.
- `scripts/web-console-real-smoke.ts` — opt-in real-provider smoke without secret output.
- `scripts/web-console-real-smoke.test.ts` — smoke configuration and output-redaction tests.
- `docs/development/web-console-demo.md` — exact local demo instructions and limitations.

---

## Chunk 1: Authoritative Runtime and Tool Visibility

### Task 1: Add shared secret redaction

**Files:**
- Create: `services/daemon/src/security/secret-redactor.ts`
- Create: `services/daemon/src/security/secret-redactor.test.ts`
- Modify: `services/daemon/src/runtime/runner-supervisor.ts`

- [ ] **Step 1: Write failing redactor tests**

  Cover empty secrets, repeated values, overlapping values, UTF-8 text, and output truncation after redaction:

  ```ts
  expect(redactSecrets('key-a:key-a', ['key-a'])).toBe('[REDACTED]:[REDACTED]');
  expect(redactSecrets('prefix secret-long suffix', ['secret', 'secret-long']))
    .toBe('prefix [REDACTED] suffix');
  expect(redactAndLimit('token-value', ['token-value'], 8)).toBe('[REDACT');
  ```

- [ ] **Step 2: Run the focused test and verify failure**

  Run: `pnpm vitest run services/daemon/src/security/secret-redactor.test.ts`

  Expected: FAIL because `secret-redactor.ts` does not exist.

- [ ] **Step 3: Implement deterministic longest-first redaction**

  Export:

  ```ts
  export const redactSecrets = (value: string, secrets: readonly string[]): string => {
    const ordered = [...new Set(secrets.filter((secret) => secret.length > 0))]
      .sort((left, right) => right.length - left.length);
    return ordered.reduce(
      (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
      value,
    );
  };

  export const redactAndLimit = (
    value: string,
    secrets: readonly string[],
    maxBytes: number,
  ): string => Buffer.from(redactSecrets(value, secrets), 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8');
  ```

  Replace the private process-output redaction loop in `runner-supervisor.ts` with this helper.

- [ ] **Step 4: Run focused and supervisor tests**

  Run: `pnpm vitest run services/daemon/src/security/secret-redactor.test.ts tests/integration/runner-production-wiring.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add services/daemon/src/security services/daemon/src/runtime/runner-supervisor.ts
  git commit -m "feat: centralize daemon secret redaction"
  ```

### Task 2: Publish only installed model Tools

**Files:**
- Modify: `services/daemon/src/model/model-gateway.ts`
- Modify: `services/daemon/src/runtime/runner-supervisor.ts`
- Modify: `tests/integration/model-tool-authorization.test.ts`

- [ ] **Step 1: Write failing Tool exposure tests**

  Add a test that constructs the production driver with only `fs.read_text`, captures the provider request, and asserts:

  ```ts
  expect(request.tools).toEqual([
    expect.objectContaining({ toolId: 'fs.read_text' }),
  ]);
  expect(request.tools).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ toolId: 'fs.write_text' })]),
  );
  ```

- [ ] **Step 2: Verify the test fails**

  Run: `pnpm vitest run tests/integration/model-tool-authorization.test.ts -t "publishes only installed Tool definitions"`

  Expected: FAIL because `ModelGateway` always sends both builtin definitions.

- [ ] **Step 3: Make Tool definitions explicit**

  Replace the array constant with an immutable record and selector:

  ```ts
  export const selectBuiltinToolDefinitions = (
    toolIds: readonly string[],
  ): readonly unknown[] => toolIds.map((toolId) => {
    const definition = BUILTIN_TOOL_DEFINITIONS[toolId];
    if (!definition) throw new ModelGatewayError('MODEL_TOOL_UNAUTHORIZED', 'Unknown Tool');
    return definition;
  });
  ```

  Add `tools?: readonly unknown[]` to `ModelGateway` options. Direct tests retain the current default; `RunnerExecutionDriver` derives definitions from `Object.keys(toolHandlers)` and passes only those definitions.

- [ ] **Step 4: Run authorization and model tests**

  Run: `pnpm vitest run tests/integration/model-tool-authorization.test.ts services/daemon/src/model/openai-compatible-adapter.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add services/daemon/src/model/model-gateway.ts services/daemon/src/runtime/runner-supervisor.ts tests/integration/model-tool-authorization.test.ts
  git commit -m "fix: advertise only executable model tools"
  ```

### Task 3: Make Tool Events atomic and redacted

**Files:**
- Modify: `services/daemon/src/tools/tool-gateway.ts`
- Modify: `services/daemon/src/runtime/runner-supervisor.ts`
- Modify: `services/daemon/src/index.ts`
- Modify: `tests/integration/model-tool-authorization.test.ts`

- [ ] **Step 1: Write failing Tool Event tests**

  Add cases for:

  ```ts
  expect(events.map((event) => event.type)).toEqual([
    'tool.started',
    'tool.succeeded',
  ]);
  expect(events[0]).toMatchObject({ toolRunId, actor: 'tool', audience: 'both' });
  expect(persistedResult).not.toContain(providerKey);
  expect(returned.content).toContain('[REDACTED]');
  ```

  Add a failure-injection hook after ToolRun update but before Event append and assert the transaction rolls back both changes.

- [ ] **Step 2: Verify the tests fail**

  Run: `pnpm vitest run tests/integration/model-tool-authorization.test.ts -t "Tool Event|redacts Tool results"`

  Expected: FAIL because normal Tool execution writes no Session Events and persists raw handler content.

- [ ] **Step 3: Implement transactional Tool Events**

  In `ToolGateway`:

  - Create `SessionEventWriter` once in the constructor.
  - Insert `tool_runs(status='running')` and append `tool.started` inside the existing immediate transaction.
  - Execute the handler outside the transaction.
  - Redact handler content before any persistence or Runner response.
  - Update success/failure and append `tool.succeeded`/`tool.failed` inside one immediate transaction.
  - Include bounded summaries only; keep full redacted content in `result_json`.

  Add options:

  ```ts
  readonly secrets?: readonly string[];
  readonly hooks?: { readonly beforeTerminalEvent?: () => void };
  ```

  In `runDaemon`, register Provider key plus bootstrap-secret hex/base64 encodings with the execution driver before zeroing the input buffer. Pass the copied secret list to `ToolGateway`.

- [ ] **Step 4: Run Tool and recovery tests**

  Run: `pnpm vitest run tests/integration/model-tool-authorization.test.ts services/daemon/src/runtime/turn-terminalizer.test.ts`

  Expected: PASS; event sequence remains consecutive.

- [ ] **Step 5: Commit**

  ```bash
  git add services/daemon/src/tools/tool-gateway.ts services/daemon/src/runtime/runner-supervisor.ts services/daemon/src/index.ts tests/integration/model-tool-authorization.test.ts
  git commit -m "feat: emit atomic redacted tool events"
  ```

### Task 4: Add secure workspace read handler

**Files:**
- Create: `apps/web-console/src/server/workspace-read-tool.ts`
- Create: `apps/web-console/src/server/workspace-read-tool.test.ts`
- Create: `apps/web-console/package.json`
- Create: `apps/web-console/tsconfig.server.json`
- Modify: `.gitignore`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Scaffold only the package metadata and server test target**

  Add `@agent-workbench/web-console` with direct server dependencies plus direct `typescript`, `tsx`, and `vitest` dev dependencies, and these initial scripts:

  ```json
  {
    "typecheck:server": "tsc -p tsconfig.server.json --noEmit",
    "typecheck": "pnpm typecheck:server",
    "test": "vitest run src/server"
  }
  ```

  The complete `dev`/`build`/client scripts are added only when the runnable client shell exists in Task 8. Add `.superpowers/`, `.DS_Store`, and `.agent-workbench-preview/` to `.gitignore`.

- [ ] **Step 2: Write failing file-boundary tests**

  Cover:

  - valid `README.md` read;
  - absolute path rejection;
  - `../` escape rejection;
  - final-component symlink rejection;
  - intermediate symlink escape rejection;
  - path identity swap via injected hook;
  - directory rejection;
  - `256 KiB + 1` rejection;
  - malformed UTF-8 rejection;
  - workspace/control-plane overlap rejection.

  Expected stable codes include `WORKSPACE_PATH_INVALID`, `WORKSPACE_PATH_ESCAPE`, `WORKSPACE_FILE_CHANGED`, `WORKSPACE_FILE_TOO_LARGE`, and `WORKSPACE_FILE_NOT_UTF8`.

- [ ] **Step 3: Verify focused failure**

  Run: `pnpm vitest run apps/web-console/src/server/workspace-read-tool.test.ts`

  Expected: FAIL because the handler does not exist.

- [ ] **Step 4: Implement no-follow bounded reads**

  The handler must:

  ```ts
  const descriptor = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = await descriptor.stat({ bigint: true });
  if (!opened.isFile()) throw codedError('WORKSPACE_PATH_INVALID');
  const bytes = await readAtMost(descriptor, MAX_BYTES + 1);
  if (bytes.byteLength > MAX_BYTES) throw codedError('WORKSPACE_FILE_TOO_LARGE');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  ```

  After open, compare canonical path and path `lstat` device/inode to the opened descriptor; reject any mismatch. Always close the descriptor in `finally`.

- [ ] **Step 5: Run the focused tests**

  Run: `pnpm vitest run apps/web-console/src/server/workspace-read-tool.test.ts`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add .gitignore apps/web-console/package.json apps/web-console/tsconfig.server.json apps/web-console/src/server/workspace-read-tool.* pnpm-lock.yaml
  git commit -m "feat: add workspace-scoped read tool"
  ```

---

## Chunk 2: Provider, Daemon, and Secure HTTP Bridge

### Task 5: Parse Provider config and probe a compatible model

**Files:**
- Create: `apps/web-console/src/server/config.ts`
- Create: `apps/web-console/src/server/config.test.ts`
- Create: `apps/web-console/src/server/model-probe.ts`
- Create: `apps/web-console/src/server/model-probe.test.ts`
- Modify: `packages/testkit/src/fake-openai-server.ts`
- Modify: `packages/testkit/src/fake-openai-server.test.ts`

- [ ] **Step 1: Extend Fake OpenAI Server tests first**

  Add support for `GET /v1/models`, optional request JSON, and exact request-count completion while preserving existing POST scripts.

- [ ] **Step 2: Run current fake-provider users**

  Run: `pnpm vitest run services/daemon/src/model/openai-compatible-adapter.test.ts tests/integration/model-tool-authorization.test.ts`

  Expected: PASS after the backward-compatible testkit extension.

- [ ] **Step 3: Write failing config/probe tests**

  Assert:

  ```ts
  expect(parseProviderConfig(env).publicConfig).toEqual({
    baseHost: 'api.example.test',
    modelId: null,
  });
  expect(JSON.stringify(parseProviderConfig(env).publicConfig)).not.toContain('secret-key');
  ```

  Script `/models`, a chat SSE response, and a Tool-call SSE response. Verify explicit models also run both probes, automatic selection checks at most three candidates, and timeouts return `PROVIDER_MODEL_PROBE_FAILED`.

- [ ] **Step 4: Verify the tests fail**

  Run: `pnpm vitest run apps/web-console/src/server/config.test.ts apps/web-console/src/server/model-probe.test.ts`

  Expected: FAIL because config/probe modules do not exist.

- [ ] **Step 5: Implement config and two-stage probing**

  Keep API Key only in the private config object. Use the production `fs.read_text` schema for the Tool probe. Candidate filtering must be deterministic and bounded.

- [ ] **Step 6: Run focused tests**

  Run: `pnpm vitest run apps/web-console/src/server/config.test.ts apps/web-console/src/server/model-probe.test.ts packages/testkit/src/fake-openai-server.test.ts`

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add apps/web-console/src/server/config.* apps/web-console/src/server/model-probe.* packages/testkit/src/fake-openai-server.ts packages/testkit/src/fake-openai-server.test.ts
  git commit -m "feat: resolve compatible provider models"
  ```

### Task 6: Add configured Daemon entry and process supervisor

**Files:**
- Modify: `services/daemon/package.json`
- Modify: `services/daemon/src/index.ts`
- Modify: `runtimes/session-runner/package.json`
- Create: `apps/web-console/src/server/configured-daemon-entry.ts`
- Create: `apps/web-console/src/server/daemon-process.ts`
- Create: `apps/web-console/src/server/daemon-process.test.ts`
- Create: `tests/fixtures/run-web-console-daemon.ts`

- [ ] **Step 1: Write failing process lifecycle test**

  Start the fixture through `DaemonProcessManager`, wait for the structured Daemon `ready` line, send shutdown, and assert the child exits without leaving the socket or a live descendant. RPC authentication is intentionally deferred to Task 7, after the production RPC client exists.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run apps/web-console/src/server/daemon-process.test.ts`

  Expected: FAIL because the process manager and configured entry do not exist.

- [ ] **Step 3: Expose supported composition entrypoints**

  Add package exports for `runDaemon` and the OpenAI-compatible adapter. Add a development/default export for the Session Runner so `import.meta.resolve('@agent-workbench/session-runner')` yields an entry path without executing it.

- [ ] **Step 4: Implement configured child entry**

  `configured-daemon-entry.ts` must parse the already validated child environment, construct:

  ```ts
  await runDaemon({
    runner: {
      runnerEntryPoint,
      modelAdapter: new OpenAiCompatibleAdapter({ timeoutMs: 60_000 }),
      provider: { endpoint, modelId, apiKey },
      toolHandlers: { 'fs.read_text': createWorkspaceReadHandler(boundary) },
    },
  });
  ```

  It must not accept bootstrap secret argv/env options.

- [ ] **Step 5: Implement parent supervision**

  Generate 32 random bytes, spawn with fd 3, wait for the structured `ready` line, return a handle containing the socket path and an in-memory copy of the bootstrap secret to the owning server, and redact bounded child stderr. Do not authenticate here. On shutdown: quiesce callers, signal Daemon, wait, then escalate once if needed.

- [ ] **Step 6: Run process and production wiring tests**

  Run: `pnpm vitest run apps/web-console/src/server/daemon-process.test.ts tests/integration/runner-production-wiring.test.ts`

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add services/daemon/package.json services/daemon/src/index.ts runtimes/session-runner/package.json apps/web-console/src/server/configured-daemon-entry.ts apps/web-console/src/server/daemon-process.* tests/fixtures/run-web-console-daemon.ts
  git commit -m "feat: launch configured daemon for web console"
  ```

### Task 7: Add authenticated RPC client and HTTP contracts

**Files:**
- Create: `apps/web-console/src/shared/contracts.ts`
- Create: `apps/web-console/src/server/daemon-rpc-client.ts`
- Create: `apps/web-console/src/server/daemon-rpc-client.test.ts`
- Create: `apps/web-console/src/server/http-security.ts`
- Create: `apps/web-console/src/server/http-security.test.ts`

- [ ] **Step 1: Write failing RPC and security tests**

  Reuse protocol frame schemas. Test challenge-response, request timeout, close failure, exact Host acceptance, cross-origin rejection, missing/wrong CSRF, `text/plain` rejection, OPTIONS rejection, and no CORS response headers.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run apps/web-console/src/server/daemon-rpc-client.test.ts apps/web-console/src/server/http-security.test.ts`

  Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the minimal production RPC client**

  Port only challenge/auth/send/close behavior from `packages/testkit/src/rpc-client.ts`; do not import production code from `@agent-workbench/testkit`.

- [ ] **Step 4: Implement request security**

  Export a pure decision function:

  ```ts
  validateBrowserRequest({ method, host, origin, contentType, csrfToken }, runtimeSecurity)
  ```

  Mutations require exact same-origin `Origin`, `application/json`, and `x-agent-workbench-csrf`. All API responses use `no-store`; HTML receives a meta CSRF token and `Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:`.

- [ ] **Step 5: Run focused tests**

  Run: `pnpm vitest run apps/web-console/src/server/daemon-rpc-client.test.ts apps/web-console/src/server/http-security.test.ts`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/web-console/src/shared/contracts.ts apps/web-console/src/server/daemon-rpc-client.* apps/web-console/src/server/http-security.*
  git commit -m "feat: secure web console bridge transport"
  ```

### Task 8: Implement HTTP-to-RPC API and one-command server

**Files:**
- Create: `apps/web-console/src/server/http-api.ts`
- Create: `apps/web-console/src/server/http-api.test.ts`
- Create: `apps/web-console/src/server/index.ts`
- Create: `apps/web-console/src/client/main.tsx`
- Create: `apps/web-console/tsconfig.client.json`
- Create: `apps/web-console/index.html`
- Create: `apps/web-console/vite.config.ts`
- Modify: `apps/web-console/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing API tests with an injected RPC fake**

  Cover `GET /api/runtime`, Session creation, Turn enqueue, Snapshot, Event polling, invalid Session IDs, schema failures, and HTTP retry idempotency:

  ```ts
  await postSession({ submissionId, prompt });
  await postSession({ submissionId, prompt });
  expect(rpcRequests[0]?.clientRequestId).toBe(rpcRequests[1]?.clientRequestId);
  ```

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run apps/web-console/src/server/http-api.test.ts`

  Expected: FAIL because the API router does not exist.

- [ ] **Step 3: Implement typed HTTP routing**

  Validate all paths, query values, bodies, RPC responses, and public errors. Map UUID `submissionId` to `web:session:<uuid>` or `web:turn:<uuid>`. Never expose RPC envelope fields, socket paths, Key, or bootstrap secret.

- [ ] **Step 4: Add the minimal runnable React shell and complete package scripts**

  Add React, ReactDOM, Vite, the Vite React plugin, and their type packages as direct dependencies/devDependencies. `main.tsx` renders only a branded loading shell that calls `GET /api/runtime`; Task 10 replaces it with the full workbench.

  Finalize package scripts:

  ```json
  {
    "dev": "node --conditions=development --import tsx src/server/index.ts",
    "typecheck:server": "tsc -p tsconfig.server.json --noEmit",
    "typecheck:client": "tsc -p tsconfig.client.json --noEmit",
    "typecheck": "pnpm typecheck:server && pnpm typecheck:client",
    "build:server": "tsc -p tsconfig.server.json",
    "build:client": "vite build",
    "build": "pnpm build:server && pnpm build:client"
  }
  ```

- [ ] **Step 5: Implement the application server**

  Startup order:

  1. parse config;
  2. probe model;
  3. launch Daemon and receive its socket/bootstrap handle;
  4. connect and authenticate with the Task 7 RPC client;
  5. bind loopback HTTP on an available port;
  6. attach Vite middleware;
  7. output the URL only after `/api/runtime` is ready.

  Add root script:

  ```json
  "demo:web": "pnpm --filter @agent-workbench/web-console dev"
  ```

- [ ] **Step 6: Run API tests, package typecheck, build, and startup smoke**

  Run: `pnpm vitest run apps/web-console/src/server/http-api.test.ts apps/web-console/src/server/daemon-process.test.ts && pnpm --filter @agent-workbench/web-console typecheck && pnpm --filter @agent-workbench/web-console build`

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add apps/web-console/src/server/http-api.* apps/web-console/src/server/index.ts apps/web-console/src/client/main.tsx apps/web-console/tsconfig.client.json apps/web-console/index.html apps/web-console/vite.config.ts apps/web-console/package.json package.json pnpm-lock.yaml
  git commit -m "feat: add localhost web console server"
  ```

---

## Chunk 3: Professional React Workbench and End-to-End Demo

### Task 9: Build deterministic client API and Timeline projection

**Files:**
- Create: `apps/web-console/src/client/api.ts`
- Create: `apps/web-console/src/client/view-model.ts`
- Create: `apps/web-console/src/client/view-model.test.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Write failing view-model tests**

  Cover ordering and projection for user Message, `turn.queued`, `model.started`, `model.completed`, `tool.started`, `tool.succeeded`, `turn.succeeded`, assistant result, redacted Event placeholders, failures, and sequence gaps.

- [ ] **Step 2: Verify failure**

  Run: `pnpm vitest run apps/web-console/src/client/view-model.test.ts`

  Expected: FAIL because the projection does not exist.

- [ ] **Step 3: Implement typed API and projection**

  `api.ts` reads the CSRF token from the HTML meta tag, generates one UUID per logical submission, and reuses it for retries. `view-model.ts` returns immutable `TimelineItem[]` and throws `EVENT_SEQUENCE_GAP` rather than guessing missing state.

- [ ] **Step 4: Run focused tests**

  Run: `pnpm vitest run apps/web-console/src/client/view-model.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/web-console/src/client/api.ts apps/web-console/src/client/view-model.* vitest.config.ts
  git commit -m "feat: project authoritative execution timeline"
  ```

### Task 10: Implement the WorkBuddy-style three-column UI

**Files:**
- Modify: `apps/web-console/src/client/main.tsx`
- Create: `apps/web-console/src/client/App.tsx`
- Create: `apps/web-console/src/client/App.test.tsx`
- Create: `apps/web-console/src/client/components/NavigationRail.tsx`
- Create: `apps/web-console/src/client/components/SessionHeader.tsx`
- Create: `apps/web-console/src/client/components/Composer.tsx`
- Create: `apps/web-console/src/client/components/Timeline.tsx`
- Create: `apps/web-console/src/client/components/Inspector.tsx`
- Create: `apps/web-console/src/client/styles.css`
- Modify: `apps/web-console/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add client test dependencies**

  React/ReactDOM/Vite are already present from Task 8. Add only jsdom, React Testing Library, and user-event test dependencies.

- [ ] **Step 2: Write failing user-flow tests**

  Test:

  - runtime ready status and sanitized model display;
  - first prompt creates a Session;
  - second prompt enqueues a Turn;
  - polling adds model/tool cards;
  - final assistant Message appears only after authoritative Snapshot;
  - clicking a card populates Inspector;
  - failure cards retain stable error code;
  - narrow layout opens Inspector as a drawer.

- [ ] **Step 3: Verify failure**

  Run: `pnpm vitest run apps/web-console/src/client/App.test.tsx --environment jsdom`

  Expected: FAIL because the components do not exist.

- [ ] **Step 4: Implement state and components**

  Keep `App.tsx` responsible for orchestration only. Components receive typed props and emit actions. Poll at 500 ms while queued/running and slower while idle; on sequence gap, discard incremental state and fetch Snapshot.

- [ ] **Step 5: Implement the visual system**

  Use CSS variables for warm-gray canvas, white panels, ink text, indigo action, and semantic statuses. Desktop grid: `240px minmax(480px, 1fr) 320px`; right panel collapses below 1100 px and becomes a drawer below 820 px. Include focus rings, reduced-motion support, empty/loading/error states, and no external assets.

- [ ] **Step 6: Run component tests and client build**

  Run: `pnpm vitest run apps/web-console/src/client/App.test.tsx --environment jsdom && pnpm --filter @agent-workbench/web-console build`

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add apps/web-console/src/client apps/web-console/package.json pnpm-lock.yaml
  git commit -m "feat: add professional web workbench interface"
  ```

### Task 11: Add full fake-provider runtime and shutdown coverage

**Files:**
- Create: `tests/integration/web-console-runtime.test.ts`
- Create: `tests/integration/web-console-shutdown.test.ts`
- Modify: `packages/testkit/src/fake-openai-server.ts`
- Modify: `apps/web-console/src/server/daemon-process.ts`
- Modify: `apps/web-console/src/server/http-api.ts`
- Modify: `apps/web-console/src/server/index.ts`

- [ ] **Step 1: Write failing end-to-end test**

  Script:

  1. `/models` returns one compatible model;
  2. chat probe succeeds;
  3. Tool probe returns `fs.read_text`;
  4. actual Turn model call requests `README.md`;
  5. Tool result is fed into the second model call;
  6. final model call returns a summary.

  Assert HTTP-visible Events contain queued/model/tool/terminal states and Snapshot contains the persisted final assistant Message.

- [ ] **Step 2: Write failing shutdown test**

  Start a Turn, stop Web Console, then assert Daemon and Runner pids exit within the bounded grace period and the socket no longer accepts connections.

- [ ] **Step 3: Verify failures**

  Run: `pnpm vitest run tests/integration/web-console-runtime.test.ts tests/integration/web-console-shutdown.test.ts`

  Expected: FAIL until all runtime wiring is integrated.

- [ ] **Step 4: Implement only missing integration seams in the named orchestration files**

  Fix orchestration, readiness, shutdown, or response mapping issues only in `daemon-process.ts`, `http-api.ts`, or `server/index.ts`. If a failure points outside these files, stop and amend the plan before editing. Do not add new product scope.

- [ ] **Step 5: Run all Web Console and affected integration tests**

  Run: `pnpm vitest run apps/web-console tests/integration/web-console-runtime.test.ts tests/integration/web-console-shutdown.test.ts tests/integration/model-tool-authorization.test.ts tests/integration/runner-production-wiring.test.ts`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add tests/integration/web-console-runtime.test.ts tests/integration/web-console-shutdown.test.ts packages/testkit/src/fake-openai-server.ts apps/web-console/src/server/daemon-process.ts apps/web-console/src/server/http-api.ts apps/web-console/src/server/index.ts
  git commit -m "test: cover web console execution lifecycle"
  ```

### Task 12: Add real-provider smoke and demo documentation

**Files:**
- Create: `scripts/web-console-real-smoke.ts`
- Create: `scripts/web-console-real-smoke.test.ts`
- Create: `docs/development/web-console-demo.md`
- Modify: `package.json`

- [ ] **Step 1: Write smoke-script self-tests**

  Test config validation and output sanitization without making a real network call. The script must refuse to run if required env vars are missing and must never print the Key or raw provider response.

- [ ] **Step 2: Implement the opt-in smoke**

  Add:

  ```json
  "smoke:web-real": "node --conditions=development --import tsx scripts/web-console-real-smoke.ts"
  ```

  The script launches the Web Console, submits “读取 README.md，总结当前能力”, waits for one successful `fs.read_text` and a succeeded Turn, prints only model/status/event counts, then shuts down cleanly.

- [ ] **Step 3: Document the exact demo flow**

  Include environment exports using placeholders, `pnpm demo:web`, the loopback URL, a recommended prompt, expected Timeline cards, current limitations, and Key rotation guidance. Never include the user-provided credential.

- [ ] **Step 4: Run documentation smoke tests**

  Run: `pnpm vitest run scripts/web-console-real-smoke.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/web-console-real-smoke.ts scripts/web-console-real-smoke.test.ts docs/development/web-console-demo.md package.json
  git commit -m "docs: add web console demo workflow"
  ```

### Task 13: Verify behavior and visual quality

**Files:**
- Modify only files required by verification findings.

- [ ] **Step 1: Run focused Web Console tests**

  Run: `pnpm vitest run apps/web-console tests/integration/web-console-runtime.test.ts tests/integration/web-console-shutdown.test.ts`

  Expected: PASS.

- [ ] **Step 2: Run full repository gates**

  Run:

  ```bash
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm build
  ```

  Expected: all commands exit 0; unrelated failures are reported but not patched.

- [ ] **Step 3: Run the real-provider smoke locally**

  Supply the rotated Key through the shell environment, not a file committed to the repo:

  ```bash
  AGENT_WORKBENCH_PROVIDER_BASE_URL='<base-url>' \
  AGENT_WORKBENCH_PROVIDER_API_KEY='<rotated-key>' \
  pnpm smoke:web-real
  ```

  Expected: one compatible model selected, at least one successful model call, one successful `fs.read_text`, succeeded Turn, and clean shutdown. Output contains no Key.

- [ ] **Step 4: Perform browser visual verification**

  Start `pnpm demo:web`, open the printed URL, and verify at desktop and narrow widths:

  - polished three-column hierarchy;
  - no clipped cards or horizontal overflow;
  - visible focus states;
  - real queued/model/tool/final transitions;
  - Inspector selection and drawer behavior;
  - no fake streaming text.

- [ ] **Step 5: Request independent QA and code review**

  Dispatch the software QA role for acceptance evidence and the independent review role for security/architecture/code findings. Fix only actionable issues and rerun affected gates.

- [ ] **Step 6: Commit final verification fixes**

  ```bash
  git add <only-files-changed-by-verification>
  git commit -m "fix: finalize web console demo"
  ```

- [ ] **Step 7: Push the stacked branch and open/update a draft PR**

  ```bash
  git push -u origin codex/web-ui-preview
  gh pr create --draft --base codex/task-3-runner-model-gateway --head codex/web-ui-preview
  ```

  Expected: a draft stacked PR that does not target `main` until the Runner/Model Gateway branch is merged.
