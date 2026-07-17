import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DaemonProcessManager,
  type DaemonProcessHandle,
} from '../../apps/web-console/src/server/daemon-process.js';
import {
  startWebConsoleServer,
  type WebConsoleServerHandle,
} from '../../apps/web-console/src/server/index.js';
import {
  startFakeOpenAiServer,
  type FakeOpenAiServer,
} from '../../packages/testkit/src/fake-openai-server.js';
import type {
  RendererSessionEventEnvelope,
  SessionSnapshot,
} from '../../packages/protocol/src/index.js';

const requireFromDaemon = createRequire(
  new URL('../../services/daemon/package.json', import.meta.url),
);
const Database = requireFromDaemon('better-sqlite3') as typeof import('better-sqlite3');

const encoder = new TextEncoder();
const PROVIDER_API_KEY = 'web-console-runtime-secret-key';
const MODEL_ID = 'web-console-runtime-model';
const PROMPT = 'Read README.md and summarize it.';
const CONCURRENT_PROMPT = 'Keep this concurrent Session running.';
const README_CONTENT = '# Runtime E2E\n\nThe real Web Console executed this turn.\n';
const FINAL_SUMMARY = 'README.md confirms the real Web Console executed this turn.';
const PROVIDER_READ_TOOL_NAME = 'fs_read_text';
const TOOL_CALL = {
  logicalCallId: 'call-runtime-readme',
  toolId: 'fs.read_text',
  argumentsJson: '{"path":"README.md"}',
} as const;
const PROVIDER_READ_TOOL = {
  type: 'function',
  function: {
    name: PROVIDER_READ_TOOL_NAME,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
    },
  },
} as const;

const providerEvent = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

const stopResponse = (requestId: string, content: string): Uint8Array =>
  encoder.encode(
    providerEvent({
      id: requestId,
      choices: [{ index: 0, delta: { content } }],
    }) +
      providerEvent({
        id: requestId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) +
      'data: [DONE]\n\n',
  );

const toolResponse = (requestId: string, logicalCallId: string): Uint8Array =>
  encoder.encode(
    providerEvent({
      id: requestId,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: logicalCallId,
                type: 'function',
                function: {
                  name: PROVIDER_READ_TOOL.function.name,
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
        },
      ],
    }) +
      providerEvent({
        id: requestId,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }) +
      'data: [DONE]\n\n',
  );

const waitFor = async <Value>(
  read: () => Promise<Value>,
  predicate: (value: Value) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;
  let latest: Value | undefined;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 20);
    });
  }
  throw new Error(
    `Timed out waiting for ${description}. Latest value: ${JSON.stringify(latest)}`,
  );
};

const readJson = async <Value>(response: Response): Promise<Value> => {
  const body = (await response.json()) as Value;
  if (!response.ok) {
    throw new Error(
      `HTTP ${String(response.status)} ${response.url}: ${JSON.stringify(body)}`,
    );
  }
  return body;
};

const csrfTokenFrom = (html: string): string => {
  const match =
    /<meta name="agent-workbench-csrf" content="([^"]+)">/.exec(html);
  if (!match?.[1]) throw new Error('Web Console HTML did not contain a CSRF token');
  return match[1];
};

const cspNonceFrom = (contentSecurityPolicy: string | null): string => {
  const match = /(?:^|; )style-src 'self' 'nonce-([^']+)'(?:;|$)/.exec(
    contentSecurityPolicy ?? '',
  );
  if (!match?.[1]) throw new Error('Web Console CSP did not contain a style nonce');
  return match[1];
};

const readSecuredHtml = async (
  response: Response,
): Promise<{ readonly html: string; readonly cspNonce: string }> => {
  const html = await response.text();
  expect(response.status).toBe(200);
  const cspNonce = cspNonceFrom(
    response.headers.get('content-security-policy'),
  );
  const htmlNonceValues = [
    ...html.matchAll(/\snonce=(["'])([^"']+)\1/g),
  ].map((match) => match[2]);
  expect(htmlNonceValues.length).toBeGreaterThan(0);
  expect(new Set(htmlNonceValues)).toEqual(new Set([cspNonce]));
  expect(html).not.toContain('agent-workbench-csp-nonce-placeholder');
  return { html, cspNonce };
};

describe('Web Console real execution lifecycle', () => {
  let rootDir: string | undefined;
  let provider: FakeOpenAiServer | undefined;
  let server: WebConsoleServerHandle | undefined;

  afterEach(async () => {
    await server?.stop().catch(() => undefined);
    server = undefined;
    await provider?.close().catch(() => undefined);
    provider = undefined;
    if (rootDir !== undefined) {
      rmSync(rootDir, { force: true, recursive: true });
      rootDir = undefined;
    }
  });

  it('executes a persisted Tool turn through HTTP, daemon, Runner, and Provider', async () => {
    rootDir = mkdtempSync(join(realpathSync('/tmp'), 'awr-'));
    const workspacePath = join(rootDir, 'workspace');
    const dataDir = join(rootDir, 'data');
    const runtimeRoot = join(rootDir, 'runtime');
    mkdirSync(workspacePath, { mode: 0o700 });
    writeFileSync(join(workspacePath, 'README.md'), README_CONTENT, {
      mode: 0o600,
    });

    provider = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'GET',
            path: '/v1/models',
            headers: { authorization: `Bearer ${PROVIDER_API_KEY}` },
          },
          response: {
            headers: { 'content-type': 'application/json' },
            chunks: [
              encoder.encode(JSON.stringify({ data: [{ id: MODEL_ID }] })),
            ],
          },
        },
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: `Bearer ${PROVIDER_API_KEY}`,
              'content-type': 'application/json',
            },
            jsonBody: {
              model: MODEL_ID,
              stream: true,
              messages: [
                { role: 'user', content: 'Reply with the single word OK.' },
              ],
              tools: [],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [stopResponse('probe-chat', 'OK')],
          },
        },
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: `Bearer ${PROVIDER_API_KEY}`,
              'content-type': 'application/json',
            },
            jsonBody: {
              model: MODEL_ID,
              stream: true,
              messages: [
                {
                  role: 'user',
                  content:
                    'Call fs.read_text with {"path":"README.md"}. Do not answer with text.',
                },
              ],
              tools: [PROVIDER_READ_TOOL],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [toolResponse('probe-tool', 'call-probe-readme')],
          },
        },
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: `Bearer ${PROVIDER_API_KEY}`,
              'content-type': 'application/json',
            },
            jsonBody: {
              model: MODEL_ID,
              stream: true,
              messages: [{ role: 'user', content: PROMPT }],
              tools: [PROVIDER_READ_TOOL],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [toolResponse('runtime-tool', TOOL_CALL.logicalCallId)],
          },
        },
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: `Bearer ${PROVIDER_API_KEY}`,
              'content-type': 'application/json',
            },
            jsonBody: {
              model: MODEL_ID,
              stream: true,
              messages: [
                { role: 'user', content: PROMPT },
                {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: TOOL_CALL.logicalCallId,
                      type: 'function',
                      function: {
                        name: PROVIDER_READ_TOOL_NAME,
                        arguments: TOOL_CALL.argumentsJson,
                      },
                    },
                  ],
                },
                {
                  role: 'tool',
                  tool_call_id: TOOL_CALL.logicalCallId,
                  content: README_CONTENT,
                },
              ],
              tools: [PROVIDER_READ_TOOL],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [stopResponse('runtime-final', FINAL_SUMMARY)],
          },
        },
      ],
    });

    let daemon: DaemonProcessHandle | undefined;
    let bootstrapSecret: Buffer | undefined;
    const daemonManager = new DaemonProcessManager();
    server = await startWebConsoleServer({
      cwd: workspacePath,
      environment: {
        AGENT_WORKBENCH_PROVIDER_BASE_URL: provider.baseUrl,
        AGENT_WORKBENCH_PROVIDER_API_KEY: PROVIDER_API_KEY,
      },
      dependencies: {
        createDaemonManager: () => ({
          start: async (options) => {
            daemon = await daemonManager.start({
              ...options,
              dataDir,
              runtimeDir: runtimeRoot,
            });
            bootstrapSecret = Buffer.from(daemon.bootstrapSecret);
            return daemon;
          },
        }),
        writeReady: () => undefined,
      },
    });

    const origin = new URL(server.url).origin;
    const repeatedHtml = [
      await readSecuredHtml(await fetch(server.url)),
      await readSecuredHtml(await fetch(server.url)),
    ];
    const concurrentHtml = await Promise.all(
      Array.from({ length: 8 }, async () =>
        await readSecuredHtml(await fetch(server.url)),
      ),
    );
    const htmlResponses = [...repeatedHtml, ...concurrentHtml];
    expect(new Set(htmlResponses.map(({ cspNonce }) => cspNonce))).toHaveProperty(
      'size',
      htmlResponses.length,
    );
    const html = repeatedHtml[0]?.html ?? '';
    const csrfToken = csrfTokenFrom(html);

    const runtime = await readJson<unknown>(await fetch(`${origin}/api/runtime`));
    const created = await readJson<{ readonly sessionId: string; readonly turnId: string }>(
      await fetch(`${origin}/api/sessions`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-agent-workbench-csrf': csrfToken,
        },
        body: JSON.stringify({ submissionId: randomUUID(), prompt: PROMPT }),
      }),
    );

    const events = await waitFor(
      async () =>
        await readJson<{
          readonly events: readonly RendererSessionEventEnvelope[];
          readonly highWaterSeq: number;
        }>(
          await fetch(
            `${origin}/api/sessions/${encodeURIComponent(created.sessionId)}/events?afterSeq=0&limit=1000`,
          ),
        ),
      (value) => value.events.some((event) => event.type === 'turn.succeeded'),
      'the real turn.succeeded event',
    );
    const snapshot = await waitFor(
      async () =>
        await readJson<{ readonly snapshot: SessionSnapshot }>(
          await fetch(
            `${origin}/api/sessions/${encodeURIComponent(created.sessionId)}/snapshot`,
          ),
        ),
      (value) =>
        value.snapshot.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.status === 'completed' &&
            message.content === FINAL_SUMMARY,
        ),
      'the persisted final assistant message',
    );

    await provider.completed;

    expect(events.events.map((event) => event.seq)).toEqual(
      Array.from({ length: events.highWaterSeq }, (_, index) => index + 1),
    );
    const eventTypes = events.events.map((event) => event.type);
    let previousIndex = -1;
    for (const requiredType of [
      'turn.queued',
      'model.started',
      'model.completed',
      'tool.started',
      'tool.succeeded',
      'turn.succeeded',
    ]) {
      const index = eventTypes.indexOf(requiredType, previousIndex + 1);
      expect(index, `${requiredType} should follow the prior lifecycle event`).toBeGreaterThan(
        previousIndex,
      );
      previousIndex = index;
    }
    expect(
      snapshot.snapshot.messages.find((message) => message.role === 'assistant'),
    ).toMatchObject({ status: 'completed', content: FINAL_SUMMARY });
    expect(snapshot.snapshot.turns).toContainEqual(
      expect.objectContaining({ id: created.turnId, status: 'succeeded' }),
    );

    if (daemon === undefined || bootstrapSecret === undefined) {
      throw new Error('The real daemon handle was not captured');
    }
    const browserVisible = JSON.stringify({ html, runtime, created, events, snapshot });
    for (const privateValue of [
      PROVIDER_API_KEY,
      bootstrapSecret.toString('hex'),
      bootstrapSecret.toString('base64'),
      daemon.socketPath,
      dirname(daemon.socketPath),
      dataDir,
      workspacePath,
    ]) {
      expect(browserVisible).not.toContain(privateValue);
    }
  });

  it('runs two Sessions while a third Turn remains queued and cancelable', async () => {
    rootDir = mkdtempSync(join(realpathSync('/tmp'), 'awr-'));
    const workspacePath = join(rootDir, 'workspace');
    const dataDir = join(rootDir, 'data');
    const runtimeRoot = join(rootDir, 'runtime');
    mkdirSync(workspacePath, { mode: 0o700 });
    let matchedConcurrentRequests = 0;
    const unresolvedResponse = new Promise<void>(() => undefined);

    provider = await startFakeOpenAiServer({
      scripts: [
        {
          expectedRequest: {
            method: 'GET',
            path: '/v1/models',
            headers: { authorization: `Bearer ${PROVIDER_API_KEY}` },
          },
          response: {
            headers: { 'content-type': 'application/json' },
            chunks: [
              encoder.encode(JSON.stringify({ data: [{ id: MODEL_ID }] })),
            ],
          },
        },
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: `Bearer ${PROVIDER_API_KEY}`,
              'content-type': 'application/json',
            },
            jsonBody: {
              model: MODEL_ID,
              stream: true,
              messages: [
                { role: 'user', content: 'Reply with the single word OK.' },
              ],
              tools: [],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [stopResponse('probe-chat', 'OK')],
          },
        },
        {
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: `Bearer ${PROVIDER_API_KEY}`,
              'content-type': 'application/json',
            },
            jsonBody: {
              model: MODEL_ID,
              stream: true,
              messages: [
                {
                  role: 'user',
                  content:
                    'Call fs.read_text with {"path":"README.md"}. Do not answer with text.',
                },
              ],
              tools: [PROVIDER_READ_TOOL],
            },
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [toolResponse('probe-tool', 'call-probe-readme')],
          },
        },
        ...Array.from({ length: 2 }, () => ({
          expectedRequest: {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              authorization: `Bearer ${PROVIDER_API_KEY}`,
              'content-type': 'application/json',
            },
            jsonBody: {
              model: MODEL_ID,
              stream: true,
              messages: [{ role: 'user', content: CONCURRENT_PROMPT }],
              tools: [PROVIDER_READ_TOOL],
            },
          },
          onRequestMatched: () => {
            matchedConcurrentRequests += 1;
          },
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [
              {
                bytes: new Uint8Array(),
                waitFor: unresolvedResponse,
              },
            ],
          },
        })),
      ],
    });

    const daemonManager = new DaemonProcessManager({ stopTimeoutMs: 5_000 });
    server = await startWebConsoleServer({
      cwd: workspacePath,
      environment: {
        AGENT_WORKBENCH_PROVIDER_BASE_URL: provider.baseUrl,
        AGENT_WORKBENCH_PROVIDER_API_KEY: PROVIDER_API_KEY,
      },
      dependencies: {
        createDaemonManager: () => ({
          start: async (options) =>
            await daemonManager.start({
              ...options,
              dataDir,
              runtimeDir: runtimeRoot,
            }),
        }),
        writeReady: () => undefined,
      },
    });

    const origin = new URL(server.url).origin;
    const csrfToken = csrfTokenFrom(await (await fetch(server.url)).text());
    const createSession = async () =>
      await readJson<{ readonly sessionId: string; readonly turnId: string }>(
        await fetch(`${origin}/api/sessions`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-agent-workbench-csrf': csrfToken,
          },
          body: JSON.stringify({
            submissionId: randomUUID(),
            prompt: CONCURRENT_PROMPT,
          }),
        }),
      );

    const first = await createSession();
    const second = await createSession();
    const third = await createSession();
    await waitFor(
      async () => matchedConcurrentRequests,
      (count) => count === 2,
      'two concurrent Runner Provider requests',
    );

    const inspection = new Database(join(dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(
        inspection
          .prepare(
            `SELECT id, status, execution_fence AS executionFence,
                    started_at AS startedAt
             FROM turns
             WHERE id IN (?, ?, ?)
             ORDER BY id`,
          )
          .all(first.turnId, second.turnId, third.turnId),
      ).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.turnId, status: 'running', executionFence: 1 }),
        expect.objectContaining({ id: second.turnId, status: 'running', executionFence: 1 }),
        {
          id: third.turnId,
          status: 'queued',
          executionFence: 0,
          startedAt: null,
        },
      ]));
      expect(
        inspection
          .prepare(
            `SELECT COUNT(*) AS count FROM runner_leases
             WHERE status = 'active' AND current_turn_id IN (?, ?, ?)`,
          )
          .get(first.turnId, second.turnId, third.turnId),
      ).toEqual({ count: 2 });
      expect(
        inspection
          .prepare(
            `SELECT COUNT(*) AS count FROM session_events
             WHERE turn_id = ? AND type = 'turn.started'`,
          )
          .get(third.turnId),
      ).toEqual({ count: 0 });
    } finally {
      inspection.close();
    }

    expect(
      await readJson<{ readonly turnId: string; readonly status: string }>(
        await fetch(
          `${origin}/api/sessions/${encodeURIComponent(third.sessionId)}/turns/${encodeURIComponent(third.turnId)}/cancel`,
          {
            method: 'POST',
            headers: {
              origin,
              'content-type': 'application/json',
              'x-agent-workbench-csrf': csrfToken,
            },
            body: JSON.stringify({ submissionId: randomUUID() }),
          },
        ),
      ),
    ).toEqual({ turnId: third.turnId, status: 'canceled' });

    const canceled = await readJson<{ readonly snapshot: SessionSnapshot }>(
      await fetch(
        `${origin}/api/sessions/${encodeURIComponent(third.sessionId)}/snapshot`,
      ),
    );
    expect(canceled.snapshot.turns).toContainEqual(
      expect.objectContaining({
        id: third.turnId,
        status: 'canceled',
        executionFence: 0,
        startedAt: null,
      }),
    );
    const canceledInspection = new Database(join(dataDir, 'runtime.sqlite3'), {
      readonly: true,
    });
    try {
      expect(
        canceledInspection
          .prepare(
            `SELECT COUNT(*) AS count FROM runner_leases
             WHERE current_turn_id = ?`,
          )
          .get(third.turnId),
      ).toEqual({ count: 0 });
      expect(
        canceledInspection
          .prepare(
            `SELECT COUNT(*) AS count FROM session_events
             WHERE turn_id = ? AND type = 'turn.started'`,
          )
          .get(third.turnId),
      ).toEqual({ count: 0 });
    } finally {
      canceledInspection.close();
    }
  }, 20_000);
});
