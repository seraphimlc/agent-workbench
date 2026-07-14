import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  encodeFrame,
  MAX_FRAME_BYTES,
} from '../../packages/protocol/src/index.js';
import {
  createTempRuntime,
  DaemonProcess,
} from '../../packages/testkit/src/temp-runtime.js';
import { RpcClient } from '../../packages/testkit/src/rpc-client.js';
import { getProcessStartIdentity } from '../../services/daemon/src/runtime/runtime-lock.js';

const CAPTURE_LIMIT_BYTES = 64 * 1024;
const RPC_ENVELOPE_LIMIT = 1_024;

const waitForCondition = async (
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
};

const findDirectChildPids = (parentPid: number): number[] => {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error('Unable to inspect daemon child processes');
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === parentPid)
    .map(([pid]) => pid)
    .filter((pid): pid is number => Number.isInteger(pid) && pid > 0);
};

const processIdentityIsLive = (
  identity: { readonly pid: number; readonly processStartIdentity: string },
): boolean => {
  try {
    process.kill(identity.pid, 0);
    return getProcessStartIdentity(identity.pid) === identity.processStartIdentity;
  } catch {
    return false;
  }
};

describe('testkit resource bounds', () => {
  it('hard-caps and redacts stdout, stderr, and an unterminated stdout line', async () => {
    const bootstrapSecret = Buffer.alloc(32, 0x73);
    const secretForms = [
      bootstrapSecret.toString('utf8'),
      bootstrapSecret.toString('hex'),
      bootstrapSecret.toString('base64'),
    ];
    const stdoutPayload = `${secretForms.join('|')}|STDOUT_DONE`;
    const stderrPayload = `${secretForms.join('|')}|STDERR_DONE`;
    const script = [
      `const stdoutPayload = ${JSON.stringify(stdoutPayload)};`,
      `const stderrPayload = ${JSON.stringify(stderrPayload)};`,
      `process.stdout.write('x'.repeat(${CAPTURE_LIMIT_BYTES + 8_192}));`,
      `process.stderr.write('y'.repeat(${CAPTURE_LIMIT_BYTES + 8_192}));`,
      'process.stdout.write(stdoutPayload.slice(0, 10));',
      'process.stderr.write(stderrPayload.slice(0, 10));',
      'setImmediate(() => {',
      '  process.stdout.write(stdoutPayload.slice(10));',
      '  process.stderr.write(stderrPayload.slice(10));',
      '});',
      'setInterval(() => undefined, 1_000);',
    ].join('\n');
    const launchArguments = ['-e', script];
    const child = spawn(process.execPath, launchArguments, {
      env: {},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const daemon = new DaemonProcess(
      child,
      bootstrapSecret,
      launchArguments,
      {},
    );

    try {
      await waitForCondition(
        () =>
          daemon.stdout.includes('STDOUT_DONE') &&
          daemon.stderr.includes('STDERR_DONE'),
        'synthetic child output markers',
      );

      const partialLine = (
        daemon as unknown as { readonly stdoutLineBuffer: string }
      ).stdoutLineBuffer;
      expect(Buffer.byteLength(daemon.stdout, 'utf8')).toBeLessThanOrEqual(
        CAPTURE_LIMIT_BYTES,
      );
      expect(Buffer.byteLength(daemon.stderr, 'utf8')).toBeLessThanOrEqual(
        CAPTURE_LIMIT_BYTES,
      );
      expect(Buffer.byteLength(partialLine, 'utf8')).toBeLessThanOrEqual(
        CAPTURE_LIMIT_BYTES,
      );
      for (const secret of secretForms) {
        expect(daemon.stdout).not.toContain(secret);
        expect(daemon.stderr).not.toContain(secret);
        expect(partialLine).not.toContain(secret);
      }
    } finally {
      await daemon.stop('SIGKILL');
    }
  });

  it('fails and closes an RPC client before its public envelope capture can grow without bound', async () => {
    let acceptedSocket: Socket | undefined;
    const server = createServer((socket) => {
      acceptedSocket = socket;
      const frames = Array.from({ length: RPC_ENVELOPE_LIMIT + 1 }, (_, index) =>
        encodeFrame({
          kind: 'response',
          protocolVersion: 1,
          requestId: randomUUID(),
          traceId: randomUUID(),
          ok: true,
          result: { index },
        }),
      );
      socket.write(Buffer.concat(frames));
    });
    await new Promise<void>((resolvePromise) => {
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test RPC server did not publish a TCP address');
    }
    const socket = createConnection(address.port, '127.0.0.1');
    const client = new RpcClient(socket);

    try {
      await once(socket, 'connect');
      await client.waitForClose(1_500);

      expect(client.receivedEnvelopes).toHaveLength(RPC_ENVELOPE_LIMIT);
    } finally {
      socket.destroy();
      acceptedSocket?.destroy();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it(
    'fails before retaining envelopes whose combined serialized bytes exceed the capture budget',
    async () => {
      let acceptedSocket: Socket | undefined;
      const largePayload = 'z'.repeat(Math.floor(MAX_FRAME_BYTES * 0.7));
      const server = createServer((socket) => {
        acceptedSocket = socket;
        const frames = Array.from({ length: 3 }, (_, index) =>
          encodeFrame({
            kind: 'response',
            protocolVersion: 1,
            requestId: randomUUID(),
            traceId: randomUUID(),
            ok: true,
            result: { index, largePayload },
          }),
        );
        socket.write(Buffer.concat(frames));
      });
      await new Promise<void>((resolvePromise) => {
        server.listen(0, '127.0.0.1', resolvePromise);
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test RPC server did not publish a TCP address');
      }
      const socket = createConnection(address.port, '127.0.0.1');
      const client = new RpcClient(socket);

      try {
        await once(socket, 'connect');
        await client.waitForClose(5_000);

        expect(client.receivedEnvelopes).toHaveLength(2);
      } finally {
        socket.destroy();
        acceptedSocket?.destroy();
        await new Promise<void>((resolvePromise) =>
          server.close(() => resolvePromise()),
        );
      }
    },
    10_000,
  );

  it('waits for a captured lock-helper identity after forced daemon termination', async () => {
    const runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const helperPids = findDirectChildPids(daemon.child.pid as number);
    expect(helperPids).toHaveLength(1);
    const helperIdentity = {
      pid: helperPids[0] as number,
      processStartIdentity: getProcessStartIdentity(helperPids[0] as number),
    };
    process.kill(helperIdentity.pid, 'SIGSTOP');

    try {
      await daemon.stop('SIGKILL');

      expect(processIdentityIsLive(helperIdentity)).toBe(false);
      await runtime.cleanup();
    } finally {
      if (processIdentityIsLive(helperIdentity)) {
        process.kill(helperIdentity.pid, 'SIGKILL');
        await waitForCondition(
          () => !processIdentityIsLive(helperIdentity),
          'stopped lock helper cleanup',
        );
      }
      await runtime.cleanup();
    }
  });

  it('reaps a cached lock helper when cleanup follows an external daemon SIGKILL', async () => {
    const runtime = createTempRuntime();
    const daemon = runtime.spawnDaemon();
    await daemon.waitForReady();
    const helperPids = findDirectChildPids(daemon.child.pid as number);
    expect(helperPids).toHaveLength(1);
    const helperIdentity = {
      pid: helperPids[0] as number,
      processStartIdentity: getProcessStartIdentity(helperPids[0] as number),
    };
    process.kill(helperIdentity.pid, 'SIGSTOP');

    try {
      process.kill(daemon.child.pid as number, 'SIGKILL');
      await daemon.waitForExit();
      await runtime.cleanup();

      expect(processIdentityIsLive(helperIdentity)).toBe(false);
    } finally {
      if (processIdentityIsLive(helperIdentity)) {
        process.kill(helperIdentity.pid, 'SIGKILL');
        await waitForCondition(
          () => !processIdentityIsLive(helperIdentity),
          'externally orphaned lock helper cleanup',
        );
      }
      await runtime.cleanup();
    }
  });
});
