# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Thread — an Electron desktop client for coding agents (Claude and OpenAI Codex) with a local event-sourced server. No cloud backend; everything runs in the Electron main process against a local SQLite file.

## Commands

Uses **pnpm**.

```bash
pnpm run dev        # Vite dev server + Electron with HMR
pnpm run build      # bundle main/preload/renderer into out/
pnpm run typecheck  # tsc over both tsconfigs (node + web)
pnpm run lint       # eslint src
```

There is no test suite. Verify changes with `pnpm run typecheck` and `pnpm run lint`.

## Architecture

Three Electron processes with shared types, wired by path aliases (`@shared/*` → `src/shared`, `@/*` → `src/renderer/src`). `tsconfig.node.json` covers `src/main` + `src/preload`; `tsconfig.web.json` covers `src/renderer` + `src/shared`.

### The event-sourced core (CQRS)

The main process hosts a local server (`src/main/server/`) built around an append-only event log:

- **`src/shared/commands.ts`** — write-side `Command` union the renderer dispatches (`project.add`, `turn.send`, `approval.respond`, …).
- **`src/shared/events.ts`** — the `OrchestrationEvent` union, the single source of truth. Events get a monotonic `seq` from the store and a `streamId` (threadId, projectId, or `'root'`).
- **`engine.ts`** — runs each command through decider → append events → apply projections → broadcast to subscribers. Also owns agent turns and pending approvals.
- **`db.ts`** — synchronous SQLite via Node's built-in `node:sqlite` (no native deps). Corrupt DB files are set aside and recreated.
- **`projections.ts`** — folds events into read-model tables. Bump `PROJECTION_VERSION` whenever projector semantics change; the log replays on next launch.
- **`src/renderer/src/state/threadReducer.ts`** — the *client mirror* of the projector, folding streamed events into `ThreadDetail`.

**When adding or changing an event type, update all three in lockstep: `events.ts`, `projections.ts`, and `threadReducer.ts`.**

### Provider adapters

`src/main/server/provider/types.ts` defines a provider-neutral contract (`ProviderAdapter` + `AgentHost` callbacks) so the engine never special-cases a vendor. `claudeAdapter.ts` drives the Claude Agent SDK; `codexAppServerAdapter.ts` drives the `codex` CLI app-server. `models.ts` maps the selected model to a provider per turn. New vendors implement the same contract and feed normalized results through `AgentHost`.

### Renderer ↔ main RPC

The renderer never touches Node/OS (`contextIsolation: true`). Everything crosses via `window.native` exposed in `src/preload/index.ts`:

- **request/response** (`dispatchCommand`, `getDiff`, `listModels`, …) over `ipcRenderer.invoke`
- **subscriptions** (`subscribeShell`, `subscribeThread`) — main pushes a snapshot, then live events on a stream channel; the renderer folds them with `threadReducer`

The surface is typed in `src/shared/rpc.ts`; the renderer-side client is `src/renderer/src/rpc/client.ts`.

### Renderer state

Zustand stores in `src/renderer/src/state/`:
- `serverStore.ts` — mirror of server state (shell snapshot, open thread details), owns subscriptions
- `uiStore.ts` — UI-only state; a subset persists to localStorage under `thread:ui` (edit the `partialize` list when adding persisted keys)
- `diffStore.ts` — diff panel state
- `explorerStore.ts` — the file explorer's per-project directory listings

### Git integration

`src/main/server/git.ts` shells out to `git` (async, so main never blocks). Per-turn checkpoints and diffs never touch the user's real index. `isGitRepo` is intentionally sync (called on the command-dispatch path).

### Reading the working tree

`src/main/server/files.ts` lists one directory at a time for the explorer dock; `readProjectFile` in the engine reads a single file for `FileView`. Both are plain filesystem reads behind request/response RPC — no command, no event, no projection, nothing to replay. Both go through `resolveInside` in `files.ts`, which resolves a path against the project root and refuses it if it escapes — following symlinks, not just comparing strings.

## UI conventions

- **shadcn** (style `base-nova`, see `components.json`) with **@base-ui/react** primitives. Reusable primitives live in `src/renderer/src/components/ui/` as thin wrappers over base-ui (see `select.tsx`, `dialog.tsx` for the pattern) — don't hand-roll widgets base-ui already provides.
- **Tailwind CSS v4** — no tailwind config file; theme tokens are CSS variables in `src/renderer/src/styles.css`. Panel colors derive from `--background` via `color-mix`, so themes override only `--background` (see `[data-theme]`).
- Icons: **lucide-react**. Class merging: `cn()` from `@/lib/utils`.
- Feature components sit directly in `src/renderer/src/components/`; only generic primitives go in `components/ui/`.
