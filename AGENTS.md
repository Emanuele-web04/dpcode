# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- Treat `bun fmt`, `bun lint`, and `bun typecheck` as heavyweight workspace checks: bundle them into one final verification pass per task whenever possible, and avoid rerunning the full set repeatedly during iteration.
- If a user asks for a small follow-up right after a recent full verification pass, prefer no rerun or the smallest reasonable re-check unless the user explicitly asks for full validation again.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

DP Code is a minimal web GUI for using coding agents like Codex, Claude, and Gemini.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps provider runtimes (Codex app-server, Claude Code, and Gemini CLI ACP), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Provider Runtimes (Important)

DP Code is still Codex-first, but the app now supports three provider backends through the same orchestration boundary:

- Codex via `codex app-server` (JSON-RPC over stdio)
- Claude via the Claude Code / Agent SDK integration
- Gemini via Gemini CLI ACP (`gemini --acp`)

How we use them in this codebase:

- Provider session startup/resume, turn lifecycle, and runtime event mapping live in `apps/server/src/provider/Layers/CodexAdapter.ts`, `apps/server/src/provider/Layers/ClaudeAdapter.ts`, and `apps/server/src/provider/Layers/GeminiAdapter.ts`.
- Provider health and runtime model discovery live under `apps/server/src/provider/Layers/ProviderHealth.ts` and `apps/server/src/provider/Layers/ProviderDiscoveryService.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server
- Gemini CLI ACP docs: https://www.geminicli.com/docs/cli/acp-mode/

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
