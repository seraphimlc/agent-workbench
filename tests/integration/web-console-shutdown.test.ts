import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createConnection } from 'node:net';
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
import { openRuntimeDatabase } from '../../services/daemon/src/db/database.js';

const encoder = new TextEncoder();
const PROVIDER_API_KEY = 'web-console-shutdown-secret-key';
const MODEL_ID = 'web-console-shutdown-model';
const PROMPT = 'Keep this model request active until shutdown.';
const PROVIDER_READ_TOOL = {
  type: 'function',
  function: {
    name: 'fs.read_text',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
    },
  },
} as const;

type Deferred = {
  readonly promise: Promise<void>;
  resolve(): void;
};

type ProcessIdentity = {
  readonly pid: number;
  readonly processStartIdentity: string;
};

const deferred = (): Deferred => {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

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

const toolResponse = (requestId: string): Uint8Array =>
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
                id: 'call-probe-readme',
                type: 'function',
                function: {
                  name: 'fs.read_text',
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

const within = async <Value>(
  operation: Promise<Value>,
  description: string,
  timeoutMs: number,
): Promise<Value> =>
  await new Promise<Value>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`Timed out waiting for ${description}`)),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });

const waitFor = async (
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 20);
    });
  }
};

const normalizeProcessStartIdentity = (value: string): string =>
  value.trim().replace(/\s+/g, ' ');

const readProcessStartIdentity = (pid: number): string => {
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to inspect process ${String(pid)}`);
  }
  const identity = normalizeProcessStartIdentity(result.stdout);
  if (identity.length === 0) {
    throw new Error(`Process ${String(pid)} has no start identity`);
  }
  return identity;
};

const processIdentityIsLive = (identity: ProcessIdentity): boolean => {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(identity.pid)], {
    encoding: 'utf8',
    shell: false,
  });
  return (
    result.status === 0 &&
    normalizeProcessStartIdentity(result.stdout) === identity.processStartIdentity
  );
};

const captureProcessTreeIdentities = (
  parentIdentity: ProcessIdentity,
): ProcessIdentity[] => {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error('Unable to inspect the owned process tree');
  }
  const processes = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match?.[1] || !match[2] || !match[3]) {
        throw new Error('Unable to parse an owned process identity');
      }
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processStartIdentity: normalizeProcessStartIdentity(match[3]),
      };
    });
  const descendants: ProcessIdentity[] = [];
  const pendingParents = [parentIdentity.pid];
  while (pendingParents.length > 0) {
    const parentPid = pendingParents.shift() as number;
    for (const processEntry of processes) {
      if (processEntry.parentPid !== parentPid) continue;
      descendants.push({
        pid: processEntry.pid,
        processStartIdentity: processEntry.processStartIdentity,
      });
      pendingParents.push(processEntry.pid);
    }
  }
  return [...descendants.reverse(), parentIdentity];
};

const forceKillProcesses = async (
  identities: readonly ProcessIdentity[],
): Promise<void> => {
  const uniqueIdentities = [
    ...new Map(
      identities.map((identity) => [
        `${String(identity.pid)}\0${identity.processStartIdentity}`,
        identity,
      ]),
    ).values(),
  ];
  for (const identity of uniqueIdentities) {
    if (!processIdentityIsLive(identity)) continue;
    try {
      process.kill(identity.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  await waitFor(
    () => uniqueIdentities.every((identity) => !processIdentityIsLive(identity)),
    'forced owned process cleanup',
    2_000,
  );
};

const csrfTokenFrom = (html: string): string => {
  const match =
    /<meta name="agent-workbench-csrf" content="([^"]+)">/.exec(html);
  if (!match?.[1]) throw new Error('Web Console HTML did not contain a CSRF token');
  return match[1];
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

const expectSocketRefused = async (socketPath: string): Promise<void> => {
  const connection = new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise();
    });
    socket.once('error', rejectPromise);
  });
  await expect(within(connection, 'the daemon socket connection result', 1_000)).rejects.toMatchObject(
    { code: expect.stringMatching(/^(?:ECONNREFUSED|ENOENT)$/) },
  );
};

describe('Web Console shutdown with an active Runner', () => {
  let rootDir: string | undefined;
  let provider: FakeOpenAiServer | undefined;
  let server: WebConsoleServerHandle | undefined;
  let releaseHangingResponse: Deferred | undefined;
  let daemonHandle: DaemonProcessHandle | undefined;
  let daemonIdentity: ProcessIdentity | undefined;
  let runnerIdentity: ProcessIdentity | undefined;

  afterEach(async () => {
    const failures: unknown[] = [];
    releaseHangingResponse?.resolve();
    const activeServer = server;
    server = undefined;
    if (activeServer !== undefined) {
      try {
        await within(activeServer.stop(), 'Web Console test cleanup', 8_000);
      } catch (error) {
        failures.push(error);
        try {
          const identities = [
            ...(daemonIdentity
              ? captureProcessTreeIdentities(daemonIdentity)
              : []),
            ...(runnerIdentity ? [runnerIdentity] : []),
          ];
          await forceKillProcesses(identities);
          if (daemonHandle !== undefined) {
            rmSync(dirname(daemonHandle.socketPath), {
              force: true,
              recursive: true,
            });
          }
        } catch (fallbackError) {
          failures.push(fallbackError);
        }
      }
    }
    releaseHangingResponse = undefined;
    if (provider !== undefined) {
      try {
        await within(provider.close(), 'Fake Provider cleanup', 2_000);
      } catch (error) {
        failures.push(error);
      }
    }
    provider = undefined;
    daemonHandle = undefined;
    daemonIdentity = undefined;
    runnerIdentity = undefined;
    if (rootDir !== undefined) {
      rmSync(rootDir, { force: true, recursive: true });
      rootDir = undefined;
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Web Console shutdown test cleanup failed');
    }
  });

  it('normalizes persisted and live ps identities with repeated date whitespace', () => {
    expect(
      normalizeProcessStartIdentity('Mon Jul  7 09:08:06 2026\n'),
    ).toBe('Mon Jul 7 09:08:06 2026');
  });

  it('aborts a hanging model call and reaps daemon and Runner resources idempotently', async () => {
    rootDir = mkdtempSync(join(realpathSync('/tmp'), 'aws-'));
    const workspacePath = join(rootDir, 'workspace');
    const dataDir = join(rootDir, 'data');
    const runtimeRoot = join(rootDir, 'runtime');
    mkdirSync(workspacePath, { mode: 0o700 });
    const requestMatched = deferred();
    const requestAborted = deferred();
    releaseHangingResponse = deferred();

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
            chunks: [toolResponse('probe-tool')],
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
          onRequestMatched: requestMatched.resolve,
          onRequestAborted: requestAborted.resolve,
          response: {
            headers: { 'content-type': 'text/event-stream' },
            chunks: [
              {
                bytes: new Uint8Array(),
                waitFor: releaseHangingResponse.promise,
              },
            ],
          },
        },
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
          start: async (options) => {
            daemonHandle = await daemonManager.start({
              ...options,
              dataDir,
              runtimeDir: runtimeRoot,
            });
            daemonIdentity = {
              pid: daemonHandle.pid,
              processStartIdentity: readProcessStartIdentity(daemonHandle.pid),
            };
            return daemonHandle;
          },
        }),
        writeReady: () => undefined,
      },
    });

    const origin = new URL(server.url).origin;
    const csrfToken = csrfTokenFrom(await (await fetch(server.url)).text());
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

    await within(requestMatched.promise, 'the hanging Provider request', 10_000);
    if (daemonHandle === undefined || daemonIdentity === undefined) {
      throw new Error('The real daemon identity was not captured');
    }
    const capturedDaemonHandle = daemonHandle;
    const capturedDaemonIdentity = daemonIdentity;
    const inspection = await openRuntimeDatabase({ dataDir });
    try {
      const lease = inspection
        .prepare(
          `SELECT pid, process_start_identity AS processStartIdentity
           FROM runner_leases
           WHERE current_turn_id = ? AND status = 'active'`,
        )
        .get(created.turnId) as
        | { readonly pid: number | null; readonly processStartIdentity: string | null }
        | undefined;
      if (lease?.pid === null || lease?.pid === undefined || !lease.processStartIdentity) {
        throw new Error('The active Runner identity was not persisted');
      }
      runnerIdentity = {
        pid: lease.pid,
        processStartIdentity: normalizeProcessStartIdentity(
          lease.processStartIdentity,
        ),
      };
    } finally {
      inspection.close();
    }
    if (runnerIdentity === undefined) {
      throw new Error('The real Runner identity was not captured');
    }
    const capturedRunnerIdentity = runnerIdentity;

    const stoppedServer = server;
    await within(stoppedServer.stop(), 'Web Console shutdown', 8_000);
    server = undefined;
    await within(requestAborted.promise, 'the hanging Provider request abort', 1_000);
    await within(stoppedServer.stop(), 'idempotent Web Console shutdown', 1_000);

    await waitFor(
      () =>
        !processIdentityIsLive(capturedDaemonIdentity) &&
        !processIdentityIsLive(capturedRunnerIdentity),
      'daemon and Runner process exit',
    );
    expect(existsSync(capturedDaemonHandle.socketPath)).toBe(false);
    expect(existsSync(dirname(capturedDaemonHandle.socketPath))).toBe(false);
    expect(readdirSync(runtimeRoot)).toEqual([]);
    await expectSocketRefused(capturedDaemonHandle.socketPath);

    releaseHangingResponse.resolve();
    await within(provider.completed, 'the Fake Provider request drain', 1_000);
  }, 20_000);
});
