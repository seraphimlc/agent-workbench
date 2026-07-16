import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDaemon } from '@agent-workbench/daemon/composition';
import { OpenAiCompatibleAdapter } from '@agent-workbench/daemon/model/openai-compatible-adapter';

import { parseProviderConfig } from './config.js';
import { createWorkspaceReadHandler } from './workspace-read-tool.js';

const MODEL_TIMEOUT_MS = 45_000;

type DaemonCliOptions = {
  readonly socketPath: string;
  readonly dataDir: string;
};

const parseDaemonCli = (arguments_: readonly string[]): DaemonCliOptions => {
  let socketPath: string | undefined;
  let dataDir: string | undefined;

  const assign = (name: '--socket' | '--data-dir', value: string): void => {
    if (value.length === 0 || value.startsWith('--')) {
      throw new Error('Configured daemon option is invalid');
    }
    if (name === '--socket') {
      if (socketPath !== undefined) throw new Error('Configured daemon option is duplicated');
      socketPath = value;
      return;
    }
    if (dataDir !== undefined) throw new Error('Configured daemon option is duplicated');
    dataDir = value;
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--socket' || argument === '--data-dir') {
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error('Configured daemon option is missing');
      assign(argument, value);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--socket=')) {
      assign('--socket', argument.slice('--socket='.length));
      continue;
    }
    if (argument?.startsWith('--data-dir=')) {
      assign('--data-dir', argument.slice('--data-dir='.length));
      continue;
    }
    throw new Error('Configured daemon option is unknown');
  }

  if (socketPath === undefined || dataDir === undefined) {
    throw new Error('Configured daemon options are incomplete');
  }
  return { socketPath, dataDir };
};

const main = async (): Promise<void> => {
  const options = parseDaemonCli(process.argv.slice(2));
  const provider = parseProviderConfig(process.env).privateConfig;
  if (provider.modelId === null) {
    throw new Error('Configured daemon model must be explicit');
  }
  const workspacePath = process.env.AGENT_WORKBENCH_DEMO_WORKSPACE?.trim();
  if (!workspacePath) {
    throw new Error('Configured daemon workspace is missing');
  }
  const runnerEntryPoint = fileURLToPath(
    import.meta.resolve('@agent-workbench/session-runner'),
  );
  const readText = createWorkspaceReadHandler({
    workspacePath,
    controlPlanePaths: [options.dataDir, dirname(options.socketPath)],
  });

  await runDaemon({
    runner: {
      runnerEntryPoint,
      modelAdapter: new OpenAiCompatibleAdapter({ timeoutMs: MODEL_TIMEOUT_MS }),
      provider: {
        endpoint: `${provider.baseUrl}/chat/completions`,
        modelId: provider.modelId,
        apiKey: provider.apiKey,
      },
      toolHandlers: {
        'fs.read_text': readText,
      },
    },
  });
};

void main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({ event: 'startup_error', code: 'DAEMON_STARTUP_FAILED' })}\n`,
  );
  process.exitCode = 1;
});
