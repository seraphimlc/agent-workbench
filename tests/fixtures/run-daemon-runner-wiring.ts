import { fileURLToPath } from 'node:url';

import { runDaemon } from '../../services/daemon/src/index.js';

const providerApiKey = 'production-wiring-key';
const toolResultHex = process.env.TEST_TOOL_RESULT_HEX;
if (!toolResultHex) throw new Error('Tool result fixture value is required');

let modelCallCount = 0;

await runDaemon({
  runner: {
    runnerEntryPoint: fileURLToPath(
      new URL('../../runtimes/session-runner/src/index.ts', import.meta.url),
    ),
    modelAdapter: {
      call: async (input) => {
        modelCallCount += 1;
        if (modelCallCount === 1) {
          return {
            finishReason: 'tool_calls' as const,
            content: null,
            toolCalls: [
              {
                logicalCallId: 'production-wiring-tool-call',
                toolId: 'fs.read_text',
                argumentsJson: '{"path":"notes.md"}',
              },
            ],
            providerRequestId: 'production-wiring-tool-provider',
            usage: null,
          };
        }

        const toolMessage = (
          input.messages as unknown as Array<{ readonly role: string; readonly content: string }>
        ).find((message) => message.role === 'tool');
        if (!toolMessage) throw new Error('Runner Tool context is missing');
        return {
          finishReason: 'stop' as const,
          content: toolMessage.content,
          toolCalls: [],
          providerRequestId: 'production-wiring-stop-provider',
          usage: null,
        };
      },
    },
    provider: {
      endpoint: 'https://provider.example.test/v1/chat/completions',
      modelId: 'production-wiring-model',
      apiKey: providerApiKey,
    },
    toolHandlers: {
      'fs.read_text': async () => ({
        content: `${providerApiKey}:${toolResultHex}:visible`,
      }),
    },
  },
});
