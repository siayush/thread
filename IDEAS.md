# Thread — Product Ideas & Differentiators

Compiled from brainstorming on 2026-07-22/23. Thread's unfair advantages, which most
of these build on: **local-first, event-sourced history, multi-provider (Claude + Codex),
per-turn git checkpoints, approvals as a first-class primitive**.

---

## 1. Round one — gaps in existing tools (Cursor, Claude Code, Codex app, Conductor, Crystal, Cline, Warp)

### Exploit what only Thread's architecture can do

1. **Cross-provider continuity in one thread** — every tool locks a session to one
   provider. Thread's event log is provider-neutral, so support mid-thread handoff
   ("continue with Codex") and a one-click **second opinion** (the other model reviews
   the current turn's diff). This is the moat — a single-provider tool can never copy it.
2. **Same task, both models, in parallel** — run one prompt on Claude and Codex in two
   throwaway worktrees, show the diffs side by side, apply the winner (or have each
   critique the other). Cross-provider A/B on one task doesn't exist anywhere.
3. **Time travel + conversation forking** — per-turn checkpoints + event sourcing make
   "rewind code *and* conversation to turn 4, try a different prompt" cheap. Show the
   thread as a visible tree; diff branches against each other.

### Experience gaps in every existing client

4. **Review comments as prompts** — click a line in the per-turn diff, leave a
   PR-style comment; submitting the comments becomes the next turn's prompt with exact
   file:line anchors.
5. **"While you were away" digest** — after auto-accept runs, a compact summary:
   files touched, commands run, tests passed/failed, decisions made, anything done
   that wasn't asked for. The biggest trust gap in agent UIs.
6. **Cross-project local search** — full-text search across all threads in all
   projects ("what did I ask about auth last month, in any repo?"). Local-first as a
   retrieval feature, not just a privacy bullet.

### Smaller but sticky

7. **Unified cost meter** — tokens/spend per thread and per project across both providers.
8. **Editable approval policy** — surface accumulated "Always allow" rules as a
   per-project policy file the user can review and edit.
9. **Exportable thread replays** — render a finished thread (prompts, reasoning, diffs)
   as a self-contained HTML file a teammate can scrub through. No accounts needed.
10. **Prompt queue** — stack 2–3 follow-up prompts while a turn runs; fire the next
    automatically.

**First picks:** #4 (pure UX win on existing diff infra) and #2 (the feature no
single-provider tool can copy).

---

## 2. T3 Code "inbox" analysis (Theo's sidebar)

Why it works — it reframes threads from *chat history* into **work items with a lifecycle**:

- **Explicit "settle" (done) signal** — email-archive psychology; top of list = live
  dashboard, tail = history.
- **Recency-first, project demoted to metadata** — one global list, project as a chip.
- **"Row height is earned by state"** — running threads get rich cards (spinner,
  current tool, elapsed timer); settled threads collapse to one-liners. Last
  *assistant message* is the context line, not an invented title.
- Their design doc's best concept — **Attention Tiers** ("Needs you" pinned, with
  "how long you've been the bottleneck") — was *not* shipped. Open territory.

### If adapting (table stakes + Thread twists)

- **Attention tiers with inline approvals** — Needs you → Running → Recent → Settled,
  Approve/Decline directly on the sidebar card, "bottleneck for 12m" timer.
- **Make settle mean something** — a thread with an unreviewed/uncommitted diff can't
  settle silently; settle offers review → commit / discard. "Everything settled" =
  clean, reviewed tree.
- **Cross-project inbox by default.**
- **Cheap details:** unread bolding, last-message context lines, spinner + tool +
  elapsed on running cards, errors surfaced as text on the card.

---

## 3. Round two — original frames (don't copy the inbox; own a different thesis)

> **Thesis: you're not monitoring agents, you're clearing decisions.**

1. **The diff inbox** — triage *changes*, not conversations. The sidebar is a stack of
   pending diffs (a merge queue for your agents); chat is the drill-down, not the home.
2. **Verified done** — attach acceptance criteria to a thread (typecheck, tests, lint,
   custom command). The thread settles *itself* when checks pass and *can't* settle
   while they fail. The harness judges "done," not the model.
3. **"Your turn" batching (the decision deck)** — the app coalesces interruptions and
   deals them to you: all pending approvals/questions/diffs, batched, keyboard-driven,
   one at a time. Turn-based collaboration instead of interrupt-driven monitoring.
4. **Speculative execution** — while waiting for approval, the agent continues in a
   shadow checkpoint assuming "yes." Approve → work already landed. Decline → discarded,
   tree untouched.
5. **Blame-to-conversation provenance** — select any line, jump to the exact turn,
   prompt, and reasoning that wrote it. "git blame for intent."

**Ranking:** #3 is the biggest experiential leap; #2 is the strategic moat; #4 is the
cheapest magic trick. They compose: batched turns deal pending diffs, each showing
speculative work already done, and threads leave the queue only when verified done.

---

## 4. Round three — hardening the decision deck + next-layer wins

### Hardening

1. **Refine is the missing half** — "yes, but…" is the common case. Refine opens the
   diff in review mode: click lines, leave anchored comments, send as the next prompt.
2. **Failure cards** — stuck/looping/errored threads get dealt as decisions too:
   what it tried, where it got stuck, with **Retry / Hand to the other model (full
   event-log context) / Abandon**. Cross-provider handoff shines here.
3. **Undo after approve** — every land is a checkpoint, so give a 10-second undo toast.
   Speed without undo breeds fear; fear kills batching.
4. **Urgency rules for the dealer** — destructive ops and long-blocked threads break
   through immediately (OS notification); everything else waits for your turn. Never
   deal a turn while the user is mid-typing.

### Beyond the deck

5. **Decision memory** — persist every deck answer as project knowledge. When an agent
   asks something similar, offer "you decided this before in thread X → auto-answer?"
   **The deck that gets shorter the more you use it** — retention story, long-term moat.
6. **Clear the queue from your phone** — a paired mobile web view over the local server
   (Tailscale-style pairing, no cloud). Small cards, three buttons, one at a time.
7. **Bottleneck analytics** — "Today: 14 decisions cleared, median response 3m, agents
   idle 47m waiting on you. Longest blocker: command approvals." Tells users which
   Always-allow rules to add; quantifies value in agent-hours saved.

**Priority:** refine-with-diff-comments is non-negotiable; failure cards differentiate
hardest; decision memory is the long-term moat.

---

## 5. Interactive mockup

Live artifact (v2): https://claude.ai/code/artifact/52463c8b-de87-46f9-82bb-aa52ff92c191

Demonstrates: tiered diff inbox (Needs you / Running / Verifying / Settled·verified),
4-decision deck (diff approval w/ provenance + speculation, command approval w/
definition-of-done, agent question, failure card w/ hand-to-Claude), refine mode with
anchored line comments, undo toasts, bottleneck timers, and the "Queue clear — go do
something else" payoff state.

### Candidate v3 additions

- **Bottleneck analytics strip** — a stats bar in the app frame: "Today: 14 decisions
  cleared · median response 3m · agents idle 47m waiting on you · longest blocker:
  command approvals." Counts update live as the queue is cleared.
- **"Needs you" overview section** — a strip of chips in the main area, one per pending
  decision (type-colored: diff / command / question / failure), clickable to jump
  between decisions instead of strictly sequential dealing; cleared ones get struck
  through. The deck's table of contents.
- Decision-memory hint on the question card ("you answered this before → auto-answer?")
- Mobile-width deck to sell clear-from-your-phone
