import type { ModelOption, ProviderKind } from '@shared/domain'

/**
 * Models surfaced in the composer picker. The selected model also *chooses the
 * provider* (driver-per-instance idea, folded into the picker): a
 * value's `provider` field routes the turn to the matching handler.
 *
 * Two handlers are offered:
 *  - Claude   — `opus`/`sonnet`/`haiku` aliases (`default` → null CLI default).
 *  - Codex CLI — the `codex` app-server (auth via `codex login`, no key needed).
 *    Values are prefixed `codexcli:`; `slug` is the real model id passed to `codex`.
 */
/*
 * Naming conventions: Claude models use the full versioned
 * product name ("Claude Opus 4.8") with the real model id as the value, and
 * OpenAI models use the slug formatted as "GPT-…" with dash segments
 * capitalized ("GPT-5-Codex").
 */
/** Static fallback effort levels; codex app-server models advertise their own
 *  live set (see mergeCodexAgentModels). */
const LMH = ['low', 'medium', 'high']

/**
 * Per-model Claude effort sets — static because the Agent SDK has no live
 * capability list. `ultrathink` is prompt-injected (see claudeAdapter).
 */
const CLAUDE_FULL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'] // Fable 5, Opus 4.8
const CLAUDE_XHIGH = ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'] // Opus 4.7, Sonnet 5
const CLAUDE_MAX = ['low', 'medium', 'high', 'max', 'ultrathink'] // Opus 4.6, Sonnet 4.6
const CLAUDE_BASIC = ['low', 'medium', 'high', 'max'] // Opus 4.5

export const MODELS: ModelOption[] = [
  { value: 'default', label: 'Default', description: "Your Claude Code CLI's configured default model", provider: 'claude', reasoningEfforts: LMH, defaultReasoningEffort: 'high' },
  { value: 'claude-fable-5', label: 'Fable 5', description: 'Most intelligent — Mythos-class flagship', provider: 'claude', reasoningEfforts: CLAUDE_FULL, defaultReasoningEffort: 'high' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Most capable Opus — best for hard, multi-step work', provider: 'claude', reasoningEfforts: CLAUDE_FULL, defaultReasoningEffort: 'high' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7', description: 'Previous Opus generation', provider: 'claude', reasoningEfforts: CLAUDE_XHIGH, defaultReasoningEffort: 'xhigh' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', description: 'Older Opus generation', provider: 'claude', reasoningEfforts: CLAUDE_MAX, defaultReasoningEffort: 'high' },
  { value: 'claude-opus-4-5', label: 'Opus 4.5', description: 'Legacy Opus generation', provider: 'claude', reasoningEfforts: CLAUDE_BASIC, defaultReasoningEffort: 'high' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Balanced speed and capability', provider: 'claude', reasoningEfforts: CLAUDE_XHIGH, defaultReasoningEffort: 'high' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Previous Sonnet generation', provider: 'claude', reasoningEfforts: CLAUDE_MAX, defaultReasoningEffort: 'high' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest — quick edits and simple tasks', provider: 'claude', reasoningEfforts: [] },
  { value: 'codexcli:gpt-5-codex', label: 'GPT-5-Codex', description: 'codex app-server; auth via `codex login` (no API key)', provider: 'codexAgent', slug: 'gpt-5-codex', reasoningEfforts: LMH },
  { value: 'codexcli:gpt-5', label: 'GPT-5', description: 'codex app-server; auth via `codex login` (no API key)', provider: 'codexAgent', slug: 'gpt-5', reasoningEfforts: LMH }
]

const MODEL_BY_VALUE = new Map<string, ModelOption>(MODELS.map((m) => [m.value, m]))

/** Values routed to the codex app-server handler carry this prefix. */
const CODEX_CLI_PREFIX = 'codexcli:'

/**
 * Resolve which provider handler owns a thread's selected model. `null` (the
 * "default" picker entry) and any unknown value fall back to Claude, so an
 * unrecognized model can never strand a thread without a handler. The
 * `codexcli:` prefix routes to the codex app-server directly so live-fetched
 * models (not in the static list) still reach the right handler.
 */
export function providerForModel(model: string | null): ProviderKind {
  if (model == null) return 'claude'
  if (model.startsWith(CODEX_CLI_PREFIX)) return 'codexAgent'
  return MODEL_BY_VALUE.get(model)?.provider ?? 'claude'
}

/**
 * The real model slug to hand a provider CLI/API for a picker value — strips the
 * `codexcli:` routing prefix. Returns null for the Claude "default" entry.
 */
export function codexModelSlug(model: string | null): string | null {
  if (model == null) return null
  if (model.startsWith(CODEX_CLI_PREFIX)) return model.slice(CODEX_CLI_PREFIX.length)
  return MODEL_BY_VALUE.get(model)?.slug ?? model
}

/**
 * Merge the live codex app-server model list into the static baseline: the
 * fetched `codexAgent` entries replace the hardcoded ones (the real
 * list from `codex`), while Claude and Codex-API entries stay untouched. Falls
 * back to the static list when the fetch yields nothing.
 */
export function mergeCodexAgentModels(fetched: ModelOption[]): ModelOption[] {
  if (fetched.length === 0) return MODELS
  const out: ModelOption[] = []
  let inserted = false
  for (const m of MODELS) {
    if (m.provider === 'codexAgent') {
      if (!inserted) {
        out.push(...fetched)
        inserted = true
      }
      continue // drop static codexAgent entries in favor of the live list
    }
    out.push(m)
  }
  if (!inserted) out.push(...fetched)
  return out
}
