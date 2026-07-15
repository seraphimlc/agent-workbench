import { fileURLToPath } from 'node:url';

import { runDaemon } from '../../services/daemon/src/index.js';

await runDaemon({
  runner: {
    runnerEntryPoint: fileURLToPath(
      new URL('../../runtimes/session-runner/src/index.ts', import.meta.url),
    ),
    modelAdapter: {
      call: async () => ({
        finishReason: 'stop' as const,
        content: 'Production wiring complete',
        toolCalls: [],
        providerRequestId: 'production-wiring-provider',
        usage: null,
      }),
    },
    provider: {
      endpoint: 'https://provider.example.test/v1/chat/completions',
      modelId: 'production-wiring-model',
      apiKey: 'production-wiring-key',
    },
  },
});
