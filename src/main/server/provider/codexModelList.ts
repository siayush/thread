/**
 * Live model list for the `codex` app-server (OpenAI / `codexAgent`).
 *
 * Rather than hardcoding a slug list, it spawns `codex app-server`, calls the
 * top-level `model/list` RPC (paginated via `nextCursor`), and formats each
 * model's `displayName` into the "GPT-5.6-Sol" style. The result routes through the
 * existing `codexAgent` handler, so values keep the `codexcli:` prefix and the
 * real slug in `slug` — see {@link module:provider/models}.
 *
 * The probe is transient: it only runs `initialize`/`initialized` then
 * `model/list` (no `thread/start`), so the cwd is irrelevant and it needs no
 * API key (auth is `codex login`). The whole thing is memoized and
 * timeout-guarded — if `codex` is missing, not logged in, or slow, it resolves
 * to `[]` and the caller falls back to the static list.
 *
 * @module provider/codexModelList
 */
import { homedir } from 'node:os'
import type { ModelOption } from '@shared/domain'
import { CodexAppServer } from './codexAppServer'

/** One model entry from the codex app-server `model/list` response. */
interface CodexModel {
  model: string
  displayName?: string
  hidden?: boolean
  /** effort levels this model actually supports (codex advertises these per model) */
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>
  defaultReasoningEffort?: string
}
interface CodexModelListResponse {
  data?: CodexModel[]
  nextCursor?: string | null
}

/** Give up if `codex` doesn't answer the probe in this long. */
const PROBE_TIMEOUT_MS = 8_000

/**
 * Slug/displayName → label transform: normalize a leading "gpt" to "GPT"
 * and capitalize the letter after each dash. "gpt-5.6-sol" → "GPT-5.6-Sol".
 */
export function formatCodexModelName(displayName: string): string {
  return displayName.replace(/^gpt/i, 'GPT').replace(/-([a-z])/g, (_, c: string) => '-' + c.toUpperCase())
}

/** Overrides of codex's advertised default effort, keyed by lowercased slug. */
const DEFAULT_EFFORT_OVERRIDES: Record<string, string> = {
  'gpt-5.6-sol': 'high'
}

function toModelOption(model: CodexModel): ModelOption {
  const slug = model.model
  const label = formatCodexModelName(model.displayName?.trim() || slug)
  const reasoningEfforts = (model.supportedReasoningEfforts ?? [])
    .map((e) => e?.reasoningEffort)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  const override = DEFAULT_EFFORT_OVERRIDES[slug.toLowerCase()]
  const defaultReasoningEffort =
    override && reasoningEfforts.includes(override) ? override : (model.defaultReasoningEffort ?? null)
  return {
    value: `codexcli:${slug}`,
    label,
    description: 'codex app-server; auth via `codex login` (no API key)',
    provider: 'codexAgent',
    slug,
    reasoningEfforts,
    defaultReasoningEffort
  }
}

/** Run the transient probe: initialize → paginated `model/list` → close. */
async function probeCodexModels(): Promise<ModelOption[]> {
  const server = new CodexAppServer({ cwd: homedir() })
  try {
    await server.request('initialize', {
      clientInfo: { name: 'thread', title: 'Thread', version: '0.2.0' },
      capabilities: { experimentalApi: true }
    })
    server.notify('initialized')

    const seen = new Set<string>()
    const out: ModelOption[] = []
    let cursor: string | null | undefined
    do {
      const res = (await server.request('model/list', cursor ? { cursor } : {})) as CodexModelListResponse
      for (const model of res?.data ?? []) {
        if (!model?.model || model.hidden || seen.has(model.model)) continue
        seen.add(model.model)
        out.push(toModelOption(model))
      }
      cursor = res?.nextCursor
    } while (cursor)
    return out
  } finally {
    server.close()
  }
}

let cached: Promise<ModelOption[]> | null = null

/**
 * The live `codexAgent` model list, memoized for the process. Any failure
 * (codex not installed, not logged in, timeout) resolves to `[]` so callers
 * can fall back to the static list; the memo is cleared on failure so a later
 * call can retry once codex is available.
 */
export function getCodexAgentModels(): Promise<ModelOption[]> {
  if (cached) return cached
  cached = (async () => {
    const timeout = new Promise<ModelOption[]>((resolve) => {
      setTimeout(() => resolve([]), PROBE_TIMEOUT_MS).unref?.()
    })
    return Promise.race([probeCodexModels(), timeout]).catch(() => [])
  })().then((models) => {
    if (models.length === 0) cached = null // allow a retry on the next request
    return models
  })
  return cached
}
