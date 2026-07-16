import { createRoot } from 'react-dom/client';

import {
  RuntimePublicInfoSchema,
  type RuntimePublicInfo,
} from '../shared/contracts.js';

type ShellState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly runtime: RuntimePublicInfo }
  | { readonly status: 'error'; readonly message: string };

const readCsrfToken = (): string | null => {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="agent-workbench-csrf"]',
  );
  const token = meta?.content.trim();
  return token && token.length > 0 ? token : null;
};

const loadRuntime = async (): Promise<RuntimePublicInfo> => {
  const response = await fetch('/api/runtime', {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Runtime request failed');
  const runtime = RuntimePublicInfoSchema.parse(await response.json());
  if (runtime.daemon.status !== 'ready') {
    throw new Error('Runtime is unavailable');
  }
  return runtime;
};

const StatusShell = ({ state }: { readonly state: ShellState }) => (
  <main aria-labelledby="agent-workbench-title">
    <header>
      <p>Agent Workbench</p>
      <h1 id="agent-workbench-title">Local Web Console</h1>
      <p>Private, loopback-only access to the local agent runtime.</p>
    </header>

    {state.status === 'loading' ? (
      <section aria-live="polite" aria-busy="true">
        <h2>Connecting</h2>
        <p>Checking the local daemon and selected model…</p>
      </section>
    ) : null}

    {state.status === 'ready' ? (
      <section aria-live="polite">
        <h2>Runtime ready</h2>
        <dl>
          <dt>Daemon</dt>
          <dd>{state.runtime.daemon.status}</dd>
          <dt>Model</dt>
          <dd>{state.runtime.provider.modelId}</dd>
          <dt>Provider</dt>
          <dd>{state.runtime.provider.baseHost}</dd>
          <dt>Workspace</dt>
          <dd>{state.runtime.workspace.name}</dd>
        </dl>
      </section>
    ) : null}

    {state.status === 'error' ? (
      <section role="alert">
        <h2>Console unavailable</h2>
        <p>{state.message}</p>
      </section>
    ) : null}
  </main>
);

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Web console root element is missing');
const root = createRoot(rootElement);
const render = (state: ShellState): void => {
  root.render(<StatusShell state={state} />);
};

render({ status: 'loading' });

void (async () => {
  if (readCsrfToken() === null) {
    render({
      status: 'error',
      message: 'The secure browser session could not be initialized.',
    });
    return;
  }

  try {
    render({ status: 'ready', runtime: await loadRuntime() });
  } catch {
    render({
      status: 'error',
      message: 'The local runtime did not return a valid public status.',
    });
  }
})();
