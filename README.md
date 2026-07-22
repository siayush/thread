<p align="center">
  <img src="resources/icon.png" alt="Thread" width="128" height="128" />
</p>

<h1 align="center">Thread</h1>

A desktop client for the **Claude coding agent** — Electron + a local event-sourced
server + a WebSocket RPC, driving the Claude Agent SDK.

Pick a project folder, open a thread, and pair with the agent: streaming responses,
live tool calls and reasoning, tool-use approvals, Plan/Build modes, and a per-turn
git diff viewer. Local only — no cloud, no auth.

## Run

```bash
pnpm install
pnpm run dev
```

Auth reuses your logged-in **Claude Code CLI** credentials — no `ANTHROPIC_API_KEY`
needed if `claude` already works in your terminal.

## Features

- **Streaming chat** — token-level assistant output, thinking blocks, tool calls and
  file edits shown live as work items
- **Approvals** — the agent pauses for permission (Approve / Always allow / Decline);
  runtime modes: Supervised, Auto-accept edits, Full access
- **Plan mode** — read-only planning (Shift+Tab to toggle)
- **Diffs** — per-turn git checkpoints and a working-tree diff panel (inline/split),
  without ever touching your real index
- **Model picker** — Opus / Sonnet / Haiku or your CLI default
- **Multi-turn sessions** — SDK session resume per thread; auto-generated thread titles

## Architecture

```
Electron main
  └─ local server (in-process)
      ├─ sql.js event log + projections (rebuilt on schema changes)
      ├─ engine: command → events → projections → broadcast
      ├─ Claude Agent SDK adapter (streaming, tools, approvals, plans)
      ├─ git checkpoints via temp-index snapshots
      └─ WebSocket RPC ← React renderer (Zustand stores)
```

The renderer never touches Node/OS directly (`contextIsolation: true`); everything
flows over the WS RPC, with a minimal preload bridge for dialogs and links.

## Scripts

```bash
pnpm run dev        # Vite dev server + Electron with HMR
pnpm run build      # bundle main / preload / renderer into out/
pnpm run start      # preview the production build
pnpm run typecheck  # tsc over both tsconfigs
pnpm run lint       # eslint
```
