# Web Console Demo

The Web Console demo starts the real local HTTP console, Daemon, Session Runners, and workspace-scoped `fs.read_text` tool.

## Prerequisites

Run from the repository root on macOS with a compatible local provider configuration already available to the demo process. This guide intentionally contains no provider configuration commands or credential material.

## Start

```bash
pnpm demo:web
```

Open the printed `127.0.0.1` URL. The workspace defaults to the repository root.

## Three-Session Concurrency Demo

1. Click **New task**, enter a non-destructive task prompt, then click **Run task**. This creates Session A.
2. While Session A is still running, click **New task** again and submit Session B. Repeat once more for Session C.
3. Open **Sessions**. The list should show two rows as **Running** and one as **Queued**. If one of the first two finishes before Session C is submitted, create another Session until two rows remain running at the same time.
4. Click a different Session row while the others are running. Switching changes only the visible Session; it does not stop, cancel, reorder, or resubmit work in any other Session.
5. Select the queued Session. In its Timeline, find the queued Turn and click **Cancel queued turn**. The authoritative Timeline updates to the canceled state.

Only a queued Turn can be canceled in this slice. A running Turn cannot be canceled.

For a single-session tool demonstration, use this prompt:

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

The smoke command prints one compact JSON summary with status, selected model ID, event type counts, Turn status, and duration. It never prints private workspace paths or socket paths.

## Current Limits

- macOS only; secure descriptor verification currently depends on the local Darwin implementation.
- Loopback-only; this is not a LAN, public, or hosted console.
- No token-stream UI; the timeline reports real model lifecycle events without inventing token deltas.
- Sessions are listed only for the active local runtime; this is not a cross-workspace history browser.
- Running Turns cannot be canceled.
- No fake-model fallback; missing credentials, incompatible models, tool failures, and timeouts fail explicitly.
