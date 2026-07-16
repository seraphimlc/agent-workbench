import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const encoder = new TextEncoder();
const PROVIDER_API_KEY = 'web-console-runtime-secret-key';
const MODEL_ID = 'web-console-runtime-model';
const PROMPT = 'Read README.md and summarize it.';
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
                { role: 'assistant', content: null, toolCalls: [TOOL_CALL] },
                {
                  role: 'tool',
                  logicalCallId: TOOL_CALL.logicalCallId,
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
    const htmlResponse = await fetch(server.url);
    const html = await htmlResponse.text();
    expect(htmlResponse.status).toBe(200);
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
});
