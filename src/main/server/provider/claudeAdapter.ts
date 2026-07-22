import { randomUUID } from 'node:crypto'
import type { Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WorkStatus } from '@shared/domain'
import type { WorkUpsert } from '@shared/events'
import type { AgentHost, ProviderAdapter, ProviderKind, RunTurnParams, TurnOutcome } from './types'
import { createDeltaBatcher } from './deltaBatcher'
import { approvalKind, bodyForInput, sanitizeTitle, stringifyToolResult, TITLE_PROMPT, toolMeta, truncate } from './toolMeta'

const TITLE_TIMEOUT_MS = 30_000

/** Backoff before each retry of a transient turn failure (ms). Length ⇒ retry count. */
const RETRY_BACKOFF_MS = [500, 1500]

/**
 * Reasoning effort → thinking-token budget. The bundled Agent SDK exposes
 * `maxThinkingTokens`, not the newer `--effort` CLI flag (which this CLI
 * build rejects).
 */
const EFFORT_THINKING_TOKENS: Record<string, number> = {
  low: 4096,
  medium: 10_000,
  high: 24_000,
  xhigh: 32_000,
  max: 48_000,
  ultracode: 48_000,
  ultrathink: 60_000
}

/**
 * A transient failure is one the Anthropic API/CLI can recover from on a retry:
 * 5xx / overloaded responses and dropped connections. The Claude Code CLI
 * surfaces these by exiting non-zero, so we also treat a bare process-exit as
 * retryable — safe because we only ever retry a turn that produced no output.
 */
function isTransientError(error: string | undefined): boolean {
  if (!error) return false
  return /\b(500|502|503|504|529)\b|internal server error|api_error|overloaded|econnreset|etimedout|socket hang up|fetch failed|network|exited with code/i.test(error)
}

/** Abortable sleep — resolves early if the turn is interrupted mid-backoff. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<SdkModule> | null = null
// The SDK is ESM-only; load it via dynamic import so it survives the CJS main bundle.
function loadSdk(): Promise<SdkModule> {
  return (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))
}

/**
 * Drives the Claude agent one turn at a time. Each turn is its own `query()`
 * (resumed via the SDK session id), interruptible via the engine-owned
 * AbortController. Normalizes the SDK stream into host callbacks (assistant
 * deltas, tool work items, plan proposals, approval prompts).
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = 'claude'
  private titleJobs = new Map<string, AbortController>()

  constructor(private readonly host: AgentHost) {}

  /**
   * One-shot, tool-less generation of a concise thread title from the first
   * user message. Always uses the
   * cheapest model, is time-boxed, and returns null on any failure so the
   * caller can keep the fallback "Thread N" name.
   */
  async generateTitle(threadId: string, cwd: string, message: string): Promise<string | null> {
    const { query } = await loadSdk()
    const abort = new AbortController()
    this.titleJobs.set(threadId, abort)
    const timeout = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS)
    const prompt = [TITLE_PROMPT, '', 'User message:', message.slice(0, 2000)].join('\n')

    const options: Options = {
      cwd,
      abortController: abort,
      permissionMode: 'default',
      allowedTools: [],
      settingSources: [],
      model: 'haiku'
    }

    let text = ''
    try {
      const q = query({ prompt, options })
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === 'assistant') {
          const content = (msg.message as any).content // eslint-disable-line @typescript-eslint/no-explicit-any
          if (Array.isArray(content)) for (const b of content) if (b.type === 'text') text += b.text
        }
      }
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
      if (this.titleJobs.get(threadId) === abort) this.titleJobs.delete(threadId)
    }
    return sanitizeTitle(text)
  }

  cancelTitle(threadId: string): void {
    this.titleJobs.get(threadId)?.abort()
  }

  /**
   * Run one turn, retrying transient API failures (5xx / overloaded / dropped
   * connection). A retry only happens when the failed attempt streamed nothing
   * to the host — re-running after partial output would duplicate the reply, so
   * once any assistant text or tool work has appeared we surface the error.
   */
  async runTurn(params: RunTurnParams): Promise<TurnOutcome> {
    const { abort } = params
    let outcome: TurnOutcome = { state: 'error', costUsd: null, assistantMessageId: null, error: 'Turn did not start' }
    const maxAttempts = RETRY_BACKOFF_MS.length + 1
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (abort.signal.aborted) return { state: 'interrupted', costUsd: null, assistantMessageId: null }
      const res = await this.attemptTurn(params)
      outcome = res.outcome
      const canRetry =
        attempt < maxAttempts - 1 &&
        outcome.state === 'error' &&
        !res.producedOutput &&
        !abort.signal.aborted &&
        isTransientError(outcome.error)
      if (!canRetry) return outcome
      await delay(RETRY_BACKOFF_MS[attempt], abort.signal)
    }
    return outcome
  }

  private async attemptTurn(params: RunTurnParams): Promise<{ outcome: TurnOutcome; producedOutput: boolean }> {
    const { threadId, turnId, cwd, prompt, model, reasoningEffort, permissionMode, resumeSessionId, abort } = params
    if (abort.signal.aborted) return { outcome: { state: 'interrupted', costUsd: null, assistantMessageId: null }, producedOutput: false }
    const { query } = await loadSdk()
    // "ultrathink" is a Claude Code magic keyword — it goes into the prompt, not an option
    const effectivePrompt = reasoningEffort === 'ultrathink' ? `ultrathink\n\n${prompt}` : prompt
    // set true the moment anything reaches the host — gates whether a failure is retryable
    let producedOutput = false

    // maps a tool_use id -> the work item id we created for it
    const toolWork = new Map<string, string>()
    const toolNames = new Map<string, string>()
    let assistantMessageId: string | null = null
    let currentStreamingMsgId: string | null = null
    /** streaming messages whose text block ended but whose canonical text hasn't arrived yet */
    const openTextMsgIds: string[] = []
    /** streaming `reasoning` message per thinking block, keyed by stream-event block index */
    const reasoningByIndex = new Map<number, string>()
    /** accumulated text per reasoning message — finalize replaces text, so it needs the full stream */
    const reasoningText = new Map<string, string>()
    let sawReasoningStream = false
    let costUsd: number | null = null
    let outcome: TurnOutcome = { state: 'completed', costUsd: null, assistantMessageId: null }

    const batcher = createDeltaBatcher(this.host, threadId, turnId)
    const flushDelta = batcher.flush
    const queueDelta = (messageId: string, text: string): void => {
      producedOutput = true
      batcher.queue(messageId, text)
    }

    const emitWork = (id: string, upsert: Omit<WorkUpsert, 'workId' | 'threadId' | 'turnId'>): void => {
      producedOutput = true
      this.host.onWork(threadId, { workId: id, threadId, turnId, ...upsert })
    }

    // Creating/finalizing an assistant message is host-visible output too — a
    // non-streaming text block finalizes without ever going through queueDelta.
    const ensureMsg = (): string => {
      producedOutput = true
      return this.host.ensureAssistantMessage(threadId, turnId)
    }
    const ensureReasoning = (): string => {
      producedOutput = true
      sawReasoningStream = true
      return this.host.ensureReasoningMessage(threadId, turnId)
    }
    const finalizeMsg = (id: string, text: string): void => {
      producedOutput = true
      this.host.finalizeAssistantMessage(threadId, id, text)
    }

    const options: Options = {
      cwd,
      abortController: abort,
      includePartialMessages: true,
      permissionMode: permissionMode as Options['permissionMode'],
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
      settingSources: ['project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      ...(model ? { model } : {}),
      ...(reasoningEffort && EFFORT_THINKING_TOKENS[reasoningEffort] ? { maxThinkingTokens: EFFORT_THINKING_TOKENS[reasoningEffort] } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      canUseTool: async (toolName, input, { toolUseID }): Promise<PermissionResult> => {
        return this.host.requestPermission({
          threadId,
          turnId,
          toolName,
          kind: approvalKind(toolName),
          detail: toolMeta(toolName, input).detail ?? toolName,
          input: input as Record<string, unknown>,
          requestId: toolUseID
        }) as Promise<PermissionResult>
      }
    }

    let q: Query
    try {
      q = query({ prompt: effectivePrompt, options })
    } catch (err) {
      return { outcome: { state: 'error', costUsd: null, assistantMessageId: null, error: String(err) }, producedOutput }
    }

    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.host.onSessionId(threadId, msg.session_id)
        } else if (msg.type === 'stream_event') {
          const ev = msg.event as any // eslint-disable-line @typescript-eslint/no-explicit-any
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
            // open the reasoning message lazily — models that omit thinking content
            // send empty deltas, and those must not create an empty "Thought" row
            const chunk: string = ev.delta.thinking ?? ''
            if (chunk) {
              let id = reasoningByIndex.get(ev.index)
              if (!id) {
                id = ensureReasoning()
                reasoningByIndex.set(ev.index, id)
                reasoningText.set(id, '')
              }
              reasoningText.set(id, (reasoningText.get(id) ?? '') + chunk)
              queueDelta(id, chunk)
            }
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            if (!currentStreamingMsgId) currentStreamingMsgId = ensureMsg()
            queueDelta(currentStreamingMsgId, ev.delta.text)
          } else if (ev.type === 'content_block_stop' && reasoningByIndex.has(ev.index)) {
            flushDelta()
            const id = reasoningByIndex.get(ev.index)!
            finalizeMsg(id, reasoningText.get(id) ?? '')
            reasoningByIndex.delete(ev.index)
            reasoningText.delete(id)
          } else if (ev.type === 'content_block_stop' && currentStreamingMsgId) {
            // park the finished text block's message so the next block streams into a fresh one
            flushDelta()
            openTextMsgIds.push(currentStreamingMsgId)
            currentStreamingMsgId = null
          }
        } else if (msg.type === 'assistant') {
          flushDelta()
          const content = (msg.message as any).content // eslint-disable-line @typescript-eslint/no-explicit-any
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                const id: string = openTextMsgIds.shift() ?? currentStreamingMsgId ?? ensureMsg()
                if (id === currentStreamingMsgId) currentStreamingMsgId = null
                finalizeMsg(id, block.text ?? '')
                assistantMessageId = id
              } else if (block.type === 'thinking' && block.thinking) {
                // fallback for when partial streaming didn't surface the thinking
                if (!sawReasoningStream) {
                  const id = ensureReasoning()
                  finalizeMsg(id, block.thinking)
                }
              } else if (block.type === 'tool_use') {
                const meta = toolMeta(block.name, block.input)
                const workId = randomUUID()
                toolWork.set(block.id, workId)
                toolNames.set(block.id, block.name)
                if (block.name === 'ExitPlanMode' && block.input?.plan) {
                  this.host.onPlan(threadId, turnId, String(block.input.plan))
                }
                emitWork(workId, {
                  tone: 'tool',
                  status: 'inProgress',
                  itemType: meta.itemType,
                  toolName: block.name,
                  title: meta.title,
                  detail: meta.detail,
                  body: meta.itemType === 'command_execution' ? String(block.input?.command ?? '') : bodyForInput(block.name, block.input),
                  changedFiles: meta.changedFiles
                })
              }
            }
          }
        } else if (msg.type === 'user') {
          // tool results
          const content = (msg.message as any).content // eslint-disable-line @typescript-eslint/no-explicit-any
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const workId = toolWork.get(block.tool_use_id)
                if (!workId) continue
                const name = toolNames.get(block.tool_use_id) ?? ''
                const meta = toolMeta(name, {})
                const resultText = stringifyToolResult(block.content)
                const failed: WorkStatus = block.is_error ? 'failed' : 'completed'
                emitWork(workId, {
                  tone: block.is_error ? 'error' : 'tool',
                  status: failed,
                  itemType: meta.itemType,
                  toolName: name,
                  title: meta.title,
                  detail: null, // null = keep prior detail (both folds preserve it)
                  body: resultText ? truncate(resultText, 12000) : null,
                  changedFiles: []
                })
              }
            }
          }
        } else if (msg.type === 'result') {
          costUsd = typeof (msg as any).total_cost_usd === 'number' ? (msg as any).total_cost_usd : null // eslint-disable-line @typescript-eslint/no-explicit-any
          if (msg.subtype === 'success') {
            outcome = { state: 'completed', costUsd, assistantMessageId }
          } else {
            outcome = { state: 'error', costUsd, assistantMessageId, error: (msg as any).errors?.join('; ') ?? msg.subtype } // eslint-disable-line @typescript-eslint/no-explicit-any
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) {
        outcome = { state: 'interrupted', costUsd, assistantMessageId }
      } else {
        outcome = { state: 'error', costUsd, assistantMessageId, error: String(err) }
      }
    } finally {
      flushDelta()
    }

    return { outcome, producedOutput }
  }
}
