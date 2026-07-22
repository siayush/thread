/**
 * Provider contract — the interchangeability layer.
 *
 * A single provider-neutral contract that
 * every vendor handler (Claude, Codex, …) implements, so the engine never
 * special-cases a provider. Each adapter drives one turn at a time and feeds
 * normalized results back through the shared `AgentHost` callbacks — the engine
 * turns those into events, identical no matter which vendor produced them.
 *
 * @module provider/types
 */
import type { ApprovalKind } from '@shared/domain'
import type { WorkUpsert } from '@shared/events'

/**
 * Which vendor handler backs a turn.
 *  - `claude`     = Anthropic, via the bundled Claude Code CLI
 *  - `codexAgent` = OpenAI, via the `codex` CLI app-server (auth = `codex login`)
 */
export type ProviderKind = 'claude' | 'codexAgent'

/**
 * Result of an approval prompt. Structurally a subset of the Claude SDK's
 * `PermissionResult` so the Claude adapter can hand it straight to `canUseTool`,
 * but declared here so no adapter has to import a vendor SDK for the type.
 */
export type ProviderPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt: boolean }

/** Callbacks the adapter uses to feed normalized results back to the engine. */
export interface AgentHost {
  onSessionId(threadId: string, sdkSessionId: string): void
  onAssistantTextDelta(threadId: string, turnId: string, messageId: string, delta: string): void
  /** ensure a streaming assistant message exists; returns its id */
  ensureAssistantMessage(threadId: string, turnId: string): string
  /** ensure a streaming message with role `reasoning` exists; returns its id */
  ensureReasoningMessage(threadId: string, turnId: string): string
  finalizeAssistantMessage(threadId: string, messageId: string, finalText: string): void
  onWork(threadId: string, upsert: WorkUpsert): void
  onPlan(threadId: string, turnId: string, text: string): void
  requestPermission(args: {
    threadId: string
    turnId: string
    toolName: string
    kind: ApprovalKind
    detail: string
    input: Record<string, unknown>
    requestId: string
  }): Promise<ProviderPermissionResult>
}

export interface RunTurnParams {
  threadId: string
  turnId: string
  cwd: string
  prompt: string
  model: string | null
  /** reasoning-effort level to request; null = provider default */
  reasoningEffort: string | null
  permissionMode: string
  resumeSessionId: string | null
  /** created (and owned) by the engine, synchronously at dispatch time */
  abort: AbortController
}

export interface TurnOutcome {
  state: 'completed' | 'interrupted' | 'error'
  costUsd: number | null
  assistantMessageId: string | null
  error?: string
}

/**
 * Provider handler SPI. Every vendor implements exactly this surface; the
 * registry resolves one by `kind` and the engine drives it blind to which
 * vendor it is.
 */
export interface ProviderAdapter {
  readonly kind: ProviderKind
  /** Drive one interruptible turn, normalizing the vendor stream into host callbacks. */
  runTurn(params: RunTurnParams): Promise<TurnOutcome>
  /** One-shot, tool-less generation of a concise thread title. `null` on any failure. */
  generateTitle(threadId: string, cwd: string, message: string): Promise<string | null>
  /** Cancel an in-flight title job for a thread. */
  cancelTitle(threadId: string): void
}

