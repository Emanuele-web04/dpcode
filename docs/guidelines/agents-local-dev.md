# Local Dev Runbook for Agents

Use this when you need to run DP Code locally and verify thread behavior.

## Goal

- Start a clean local server.
- Keep thread state isolated from the user's long-lived DP Code data.
- Verify that threads load in the browser from SQL-backed projections.

## Recommended Startup

1. Use a fresh home directory for the run.
2. Do not pass or inherit `T3CODE_AUTH_TOKEN` / `DPCODE_AUTH_TOKEN` for local browser work.
3. Start the dev stack from the repo root with `bun run dev`.
4. If you need to avoid port collisions, set `T3CODE_PORT_OFFSET` to a free offset.

Example:

```bash
T3CODE_HOME=/Users/ibrahime/Documents/Projects/dpcode/.dpcode-pr84-fresh \
T3CODE_PORT_OFFSET=20 \
T3CODE_NO_BROWSER=1 \
bun run dev
```

## Why Fresh Home Matters

- The server writes projection state to `T3CODE_HOME/dev/state.sqlite`.
- Reusing an older home directory can surface legacy schema or legacy event data.
- Fresh state avoids false failures from old `projection_threads` rows, provider state, or migration drift.

## Auth Expectations

- Local web development should run without websocket auth.
- If the browser sees `401` on `/ws`, the run is not set up correctly for local thread verification.
- Avoid manual token wiring unless you are explicitly testing auth behavior.

## Thread Verification

1. Open the local web URL printed by the dev runner.
2. Confirm the sidebar renders.
3. Confirm threads appear in the sidebar.
4. If the UI is empty, inspect `projection_threads` in the SQLite DB under `T3CODE_HOME/dev/state.sqlite`.
5. Verify with the browser, not only the database, because the UI must hydrate the SQL-backed projections correctly.

Example SQL:

```sql
select count(*) from projection_threads;
select thread_id, title, created_at from projection_threads order by created_at desc;
```

## Failure Modes

- `Unexpected token` in Vite usually means a frontend syntax error is blocking module load.
- `401` on `/ws` means auth is enabled for the local browser path.
- `port ... already in use` means an older dev process is still running.
- Empty threads with non-empty SQL often means the projection pipeline has not replayed or the browser is pointed at the wrong `T3CODE_HOME`.

## Practical Rule

- For thread testing, prefer a clean isolated home directory and a browser-visible local dev run over reusing the user's existing state.
- If you need to seed a thread for verification, seed `projection_threads` in the fresh SQLite DB and refresh the browser to confirm the row appears.
