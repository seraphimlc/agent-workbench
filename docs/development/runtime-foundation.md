# Runtime foundation smoke check

## Run

```bash
pnpm smoke:runtime
pnpm smoke:runtime -- --keep-data
```

The first command deletes its temporary root after every client and daemon has stopped. `--keep-data` preserves the temporary root, database, and workspace for inspection. Unknown options and repeated `--keep-data` options fail before runtime data is created.

The root package entry enables the `development` export condition before loading `tsx`, so the smoke check resolves workspace source files and does not require prebuilt `dist` output.

For a machine-readable capture without pnpm lifecycle output, use:

```bash
pnpm --silent smoke:runtime -- --keep-data
```

The script itself writes exactly one JSON object to stdout after cleanup. Daemon ready output is captured internally. Failures and diagnostics go to stderr.

## Result fields

- `health`: parsed `app.health` result from the first source Daemon.
- `workspaceId`, `sessionId`, `turnId`: persisted identifiers returned by `workspace.register` and `session.create`.
- `highWaterSeq`: event high-water mark before restart.
- `restoredSnapshot`: the complete protocol-validated `session.getSnapshot` result after restart, including the Session, ordered Messages and Turns, continuous Events, and `highWaterSeq`.
- `restoredSessionId`, `restoredRuntimeStatus`, `restoredMessageCount`, `restoredTurnCount`, `restoredEventCount`: convenience summaries derived from `restoredSnapshot`; consumers can verify they match the full snapshot.
- `databasePath`, `dataDir`, `rootDir`: absolute inspection paths. They no longer exist after a default run.
- `keptData`: whether `--keep-data` preserved those paths.

`status: "ok"` means the command authenticated twice with one script-generated secret, restarted the Daemon with the same socket/data paths, and recovered an identical queued Session/Message/Turn/Event snapshot with an unchanged continuous event high-water mark.

## Current boundary

This check covers the source Daemon, fd 3 challenge-response authentication, migrations `001` through `004`, workspace registration, creation of the first queued craft turn with execution fence `0`, graceful restart, and durable snapshot recovery.

Migrations `003` and `004` install the durable execution ledger and immutable Markdown Artifact store. The ordinary Daemon still has no execution dependencies in this slice: it does not call `Scheduler.claimNext`, the Turn remains queued across restart, and all execution and Artifact tables remain empty. The smoke check does not execute turns or validate Electron, Runner, model, tool, Blob content, or Artifact preview paths. A successful result is evidence for the runtime foundation only, not an end-to-end product run.

## Failure checks

- fd 3 secret: the Daemon requires exactly 32 bytes followed by EOF on fd 3. The launcher must not move the secret into argv or environment variables. Authentication/startup errors must be investigated without printing the secret.
- Socket/data permissions: the temporary root, data directory, and runtime directory must remain owned by the current user with mode `0700`; the socket and SQLite file must remain `0600`. Ownership, symlink, permission, or overlong Unix-socket paths fail closed.
- Migration or recovery failure: the Daemon does not emit ready and the smoke command does not emit an `ok` object. Inspect stderr; use `--keep-data` when retained files are needed for SQLite inspection. Do not edit historical migrations `001` through `004` to repair an existing database.
- Non-clean shutdown: both Daemon generations must stop with exit code `0` and no signal. A non-zero exit or forced-signal fallback makes the smoke command fail without an `ok` JSON object.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm smoke:runtime -- --keep-data
```

After a retained run, inspect `databasePath`, then remove only the reported `rootDir` after confirming it is inside an operating-system temporary directory.
