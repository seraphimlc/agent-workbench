# Web Console Demo

The Web Console demo starts the real local HTTP console, configured Daemon, Session Runner, Provider adapter, and workspace-scoped `fs.read_text` tool.

## Configure

Run from the repository root on macOS. Use placeholders in documentation and set the real key only in your local shell:

```bash
export AGENT_WORKBENCH_PROVIDER_BASE_URL='https://provider.example/v1'
export AGENT_WORKBENCH_PROVIDER_API_KEY='<replace-with-a-local-demo-key>'

# Optional overrides
# export AGENT_WORKBENCH_PROVIDER_MODEL='<compatible-chat-model-id>'
# export AGENT_WORKBENCH_DEMO_WORKSPACE="$PWD"
```

The base URL must be OpenAI-compatible. If no model is specified, startup probes available models for both chat and `fs.read_text` tool-call support. The workspace defaults to the repository root.

## Start

```bash
pnpm demo:web
```

Open the printed `127.0.0.1` URL. Recommended prompt:

> Use fs.read_text to read package.json, then summarize the repository's current capabilities in 3 concise bullets. Do not answer before reading the file.

Expected timeline cards:

- Session and queued/running Turn state.
- Model started and completed.
- `fs.read_text` started and succeeded for `package.json`.
- Persisted assistant final response.
- Turn succeeded.

For a terminal-only verification using the same environment:

```bash
pnpm smoke:web-real
```

The smoke command prints one compact JSON summary with status, selected model ID, event type counts, Turn status, and duration. It never prints the Provider key, Provider URL path, tool content, private workspace path, bootstrap secret, or socket path.

## Current Limits

- macOS only; secure descriptor verification currently depends on the local Darwin implementation.
- Loopback-only; this is not a LAN, public, or hosted console.
- No token-stream UI; the timeline reports real model lifecycle events without inventing token deltas.
- No session history browser; the current RPC surface has no session-list API.
- No fake-model fallback; missing credentials, incompatible models, tool failures, and timeouts fail explicitly.

## Key Safety

Never commit a real Provider key or paste it into documentation, screenshots, issue reports, or shared shell transcripts. Unset the variables after the demo. If a key may have been exposed, revoke and rotate it before running the demo again.
