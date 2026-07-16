import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { createApiClient } from './api.js';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Web console root element is missing');
const root = createRoot(rootElement);

try {
  root.render(<App api={createApiClient()} />);
} catch {
  root.render(
    <main className="boot-state">
      <section role="alert">
        <h1>Agent Workbench</h1>
        <p>The secure browser session could not be initialized.</p>
      </section>
    </main>,
  );
}
