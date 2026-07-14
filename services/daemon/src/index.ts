import { closeSync, readSync } from 'node:fs';

import { DaemonServer } from './server.js';

type CliOptions = {
  readonly socketPath: string;
  readonly dataDir: string;
};

const parseCli = (arguments_: readonly string[]): CliOptions => {
  let socketPath: string | undefined;
  let dataDir: string | undefined;

  const assign = (name: 'socket' | 'data-dir', value: string): void => {
    if (value.length === 0) {
      throw new Error('Daemon option value must not be empty');
    }

    if (name === 'socket') {
      if (socketPath !== undefined) {
        throw new Error('Duplicate daemon option');
      }
      socketPath = value;
    } else {
      if (dataDir !== undefined) {
        throw new Error('Duplicate daemon option');
      }
      dataDir = value;
    }
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (
      argument === '--bootstrap-secret' ||
      argument?.startsWith('--bootstrap-secret=')
    ) {
      throw new Error('Bootstrap secret transport is forbidden');
    }

    if (argument === '--socket' || argument === '--data-dir') {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error('Missing required daemon option value');
      }
      assign(argument.slice(2) as 'socket' | 'data-dir', value);
      index += 1;
      continue;
    }

    if (argument?.startsWith('--socket=')) {
      assign('socket', argument.slice('--socket='.length));
      continue;
    }

    if (argument?.startsWith('--data-dir=')) {
      assign('data-dir', argument.slice('--data-dir='.length));
      continue;
    }

    throw new Error('Unknown daemon option');
  }

  if (socketPath === undefined || dataDir === undefined) {
    throw new Error('Missing required daemon option');
  }

  return { socketPath, dataDir };
};

const rejectBootstrapSecretEnvironment = (environment: NodeJS.ProcessEnv): void => {
  const forbiddenKey = Object.keys(environment).find((key) => {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const bootstrapIndex = normalizedKey.indexOf('bootstrap');
    return (
      bootstrapIndex >= 0 &&
      normalizedKey.indexOf('secret', bootstrapIndex + 'bootstrap'.length) >= 0
    );
  });

  if (forbiddenKey !== undefined) {
    throw new Error('Bootstrap secret environment transport is forbidden');
  }
};

const readBootstrapSecret = (): Buffer => {
  const boundedInput = Buffer.alloc(33);
  let offset = 0;
  let reachedEof = false;

  try {
    while (offset < boundedInput.byteLength) {
      const bytesRead = readSync(
        3,
        boundedInput,
        offset,
        boundedInput.byteLength - offset,
        null,
      );

      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      offset += bytesRead;
    }

    if (!reachedEof || offset !== 32) {
      throw new Error('Bootstrap secret must be exactly 32 bytes followed by EOF');
    }

    return Buffer.from(boundedInput.subarray(0, 32));
  } finally {
    boundedInput.fill(0);
  }
};

const readStartupInputs = (): { options: CliOptions; bootstrapSecret: Buffer } => {
  try {
    const options = parseCli(process.argv.slice(2));
    rejectBootstrapSecretEnvironment(process.env);
    const bootstrapSecret = readBootstrapSecret();
    return { options, bootstrapSecret };
  } finally {
    closeSync(3);
  }
};

const main = async (): Promise<void> => {
  const { options, bootstrapSecret } = readStartupInputs();
  let shutdownPromise: Promise<void> | undefined;
  let requestedExitCode = 0;
  const server = new DaemonServer({
    socketPath: options.socketPath,
    dataDir: options.dataDir,
    bootstrapSecret,
    onFatal: () => {
      void shutdown(1).catch(() => {
        process.exitCode = 1;
      });
    },
  });
  bootstrapSecret.fill(0);
  const shutdown = async (exitCode: number): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    shutdownPromise ??= server.stop();
    await shutdownPromise;
    process.exitCode = requestedExitCode;
  };

  process.once('SIGTERM', () => {
    void shutdown(0).catch(() => {
      process.exitCode = 1;
    });
  });
  process.once('SIGINT', () => {
    void shutdown(0).catch(() => {
      process.exitCode = 1;
    });
  });

  try {
    await server.start();
  } catch (error) {
    await shutdown(1);
    throw error;
  }

  process.stdout.write(
    `${JSON.stringify({ event: 'ready', protocolVersion: 1, pid: process.pid })}\n`,
  );
};

void main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({ event: 'startup_error', code: 'DAEMON_STARTUP_FAILED' })}\n`,
  );
  process.exitCode = 1;
});
