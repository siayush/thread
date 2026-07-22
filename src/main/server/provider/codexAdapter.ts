/**
 * CodexAdapter — the OpenAI (Codex) provider handler.
 *
 * Where the Claude handler wraps the Anthropic Agent SDK, this one runs an
 * in-process agentic loop against the OpenAI Chat Completions API: stream the
 * assistant's text, collect tool calls, gate each mutating tool through the same
 * approval flow, execute it against the project working tree, feed the result
 * back, and loop until the model stops calling tools. Every provider-native
 * event is normalized into the exact same `AgentHost` callbacks the Claude
 * handler uses, so the engine and UI stay provider-blind.
 *
 * Conversation state is kept in-process, keyed by thread id (the OpenAI API is
 * stateless). That means a Codex thread's context is lost across an app restart
 * — acceptable for now; persisting it is a later step.
 *
 * @module provider/codexAdapter
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import type { WorkStatus } from '@shared/domain'
import type { WorkUpsert } from '@shared/events'
import type { AgentHost, ProviderAdapter, ProviderKind, RunTurnParams, TurnOutcome } from './types'
import { approvalKind, bodyForInput, sanitizeTitle, TITLE_PROMPT, toolMeta, truncate } from './toolMeta'

const DELTA_FLUSH_MS = 100
const TITLE_TIMEOUT_MS = 30_000
const BASH_TIMEOUT_MS = 120_000
const MAX_TOOL_OUTPUT = 12_000
const MAX_TURN_STEPS = 40

type OpenAIModule = typeof import('openai')
let sdkPromise: Promise<OpenAIModule> | null = null
function loadSdk(): Promise<OpenAIModule> {
  return (sdkPromise ??= import('openai'))
}

const SYSTEM_PROMPT = [
  'You are a coding agent operating inside a local project directory.',
  'You can read files, write files, edit files, and run shell commands via the provided tools.',
  'Prefer making concrete changes with the tools over describing them.',
  'Keep prose brief; let the tools do the work. When the task is done, give a short summary.'
].join('\n')

/** Tool schemas advertised to the model — the canonical set the timeline understands. */
const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command in the project directory and return its combined stdout/stderr.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to execute.' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file and return its contents.',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Absolute or project-relative path.' } },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Create or overwrite a file with the given contents.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or project-relative path.' },
          content: { type: 'string', description: 'Full file contents to write.' }
        },
        required: ['file_path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Replace an exact string in a file. Fails if the string is not found.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or project-relative path.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    }
  }
]

const READ_ONLY_TOOLS = new Set(['Read'])
const MUTATING_TOOLS = new Set(['Bash', 'Write', 'Edit'])

/** Whether a tool call must be approved before running, given the thread's mode. */
function needsApproval(toolName: string, mode: string): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return false
  if (mode === 'bypassPermissions') return false
  if (mode === 'acceptEdits') return toolName === 'Bash' // edits auto-accepted, commands still asked
  return true // 'default' and anything else: ask
}

interface StreamedToolCall {
  id: string
  name: string
  args: string
}

/**
 * Drives OpenAI one turn at a time via an in-process tool-use loop. Interruptible
 * through the engine-owned AbortController; normalizes the stream into host
 * callbacks (assistant deltas, tool work items, approval prompts).
 */
export class CodexAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = 'codex'
  private titleJobs = new Map<string, AbortController>()
  /** Per-thread conversation history (OpenAI is stateless; we keep the transcript). */
  private history = new Map<string, ChatCompletionMessageParam[]>()

  /** Resolved OpenAI API key; `undefined` until first lookup, `null` if none found. */
  private apiKey: string | null | undefined

  constructor(private readonly host: AgentHost) {}

  /**
   * Resolve the OpenAI API key without ever prompting: prefer the environment,
   * then fall back to the key the `codex` CLI already stored in
   * `$CODEX_HOME/auth.json` (from `codex login`). Cached after the first lookup.
   */
  private async resolveApiKey(): Promise<string | null> {
    if (this.apiKey !== undefined) return this.apiKey
    const resolved = process.env.OPENAI_API_KEY?.trim() || (await readCodexAuthKey())
    this.apiKey = resolved
    return resolved
  }

  private async client(): Promise<InstanceType<OpenAIModule['OpenAI']> | null> {
    const apiKey = await this.resolveApiKey()
    if (!apiKey) return null
    const { OpenAI } = await loadSdk()
    return new OpenAI({ apiKey })
  }

  async generateTitle(threadId: string, _cwd: string, message: string): Promise<string | null> {
    const client = await this.client()
    if (!client) return null
    const abort = new AbortController()
    this.titleJobs.set(threadId, abort)
    const timeout = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS)
    try {
      const res = await client.chat.completions.create(
        {
          model: 'gpt-5-mini',
          messages: [
            { role: 'system', content: TITLE_PROMPT },
            { role: 'user', content: `User message:\n${message.slice(0, 2000)}` }
          ]
        },
        { signal: abort.signal }
      )
      return sanitizeTitle(res.choices[0]?.message?.content ?? '')
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
      if (this.titleJobs.get(threadId) === abort) this.titleJobs.delete(threadId)
    }
  }

  cancelTitle(threadId: string): void {
    this.titleJobs.get(threadId)?.abort()
  }

  async runTurn(params: RunTurnParams): Promise<TurnOutcome> {
    const { threadId, turnId, cwd, prompt, model, reasoningEffort, permissionMode, abort } = params
    if (abort.signal.aborted) return { state: 'interrupted', costUsd: null, assistantMessageId: null }

    const client = await this.client()
    if (!client) {
      return {
        state: 'error',
        costUsd: null,
        assistantMessageId: null,
        error: 'No OpenAI API key found — set OPENAI_API_KEY or run `codex login` (an API-key login writes it to ~/.codex/auth.json).'
      }
    }

    // A stable per-thread session id so the engine's resume/session plumbing is fed.
    if (!this.history.has(threadId)) this.host.onSessionId(threadId, threadId)
    const messages = this.history.get(threadId) ?? [{ role: 'system', content: SYSTEM_PROMPT } as ChatCompletionMessageParam]
    // Plan-mode is a per-turn constraint — fold it into this turn's user message
    // rather than a standalone system message, so it never leaks into later
    // build-mode turns that share the same persistent history.
    const userContent = permissionMode === 'plan' ? `[PLAN MODE — read-only: produce a plan only; do not write, edit, or run commands]\n\n${prompt}` : prompt
    messages.push({ role: 'user', content: userContent })
    this.history.set(threadId, messages)

    let assistantMessageId: string | null = null

    const emitWork = (id: string, upsert: Omit<WorkUpsert, 'workId' | 'threadId' | 'turnId'>): void => {
      this.host.onWork(threadId, { workId: id, threadId, turnId, ...upsert })
    }

    // one persisted message.delta per ~100ms instead of one per token
    let deltaBuf = ''
    let deltaMsgId: string | null = null
    let deltaTimer: NodeJS.Timeout | null = null
    const flushDelta = (): void => {
      if (deltaTimer) {
        clearTimeout(deltaTimer)
        deltaTimer = null
      }
      if (deltaMsgId && deltaBuf) this.host.onAssistantTextDelta(threadId, turnId, deltaMsgId, deltaBuf)
      deltaBuf = ''
    }
    const queueDelta = (messageId: string, text: string): void => {
      if (deltaMsgId && deltaMsgId !== messageId) flushDelta()
      deltaMsgId = messageId
      deltaBuf += text
      deltaTimer ??= setTimeout(flushDelta, DELTA_FLUSH_MS)
    }

    // Chat Completions only accepts low|medium|high — clamp higher picker levels to high
    const chatEffort = reasoningEffort ? (['low', 'medium', 'high'].includes(reasoningEffort) ? reasoningEffort : 'high') : null

    try {
      for (let step = 0; step < MAX_TURN_STEPS; step++) {
        if (abort.signal.aborted) return { state: 'interrupted', costUsd: null, assistantMessageId }

        const stream = await client.chat.completions.create(
          {
            model: model ?? 'gpt-5-codex',
            messages,
            tools: TOOLS,
            stream: true,
            ...(chatEffort ? { reasoning_effort: chatEffort as 'low' | 'medium' | 'high' } : {})
          },
          { signal: abort.signal }
        )

        let text = ''
        let streamingMsgId: string | null = null
        const toolCalls = new Map<number, StreamedToolCall>()

        for await (const chunk of stream) {
          const choice = (chunk as ChatCompletionChunk).choices[0]
          const delta = choice?.delta
          if (delta?.content) {
            if (!streamingMsgId) streamingMsgId = this.host.ensureAssistantMessage(threadId, turnId)
            text += delta.content
            queueDelta(streamingMsgId, delta.content)
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const slot = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' }
              if (tc.id) slot.id = tc.id
              if (tc.function?.name) slot.name += tc.function.name
              if (tc.function?.arguments) slot.args += tc.function.arguments
              toolCalls.set(tc.index, slot)
            }
          }
        }
        flushDelta()

        // finalize any streamed assistant text as its own message
        if (streamingMsgId) {
          this.host.finalizeAssistantMessage(threadId, streamingMsgId, text)
          assistantMessageId = streamingMsgId
        }

        const calls = [...toolCalls.values()].filter((c) => c.name)

        // record the assistant turn (text + any tool calls) in the transcript
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length
            ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } })) }
            : {})
        })

        if (!calls.length) {
          return { state: 'completed', costUsd: null, assistantMessageId }
        }

        // execute each tool call, gated by the approval flow, feeding results back
        for (const call of calls) {
          if (abort.signal.aborted) return { state: 'interrupted', costUsd: null, assistantMessageId }
          const input = safeParse(call.args)
          const meta = toolMeta(call.name, input)
          const workId = randomUUID()
          emitWork(workId, {
            tone: 'tool',
            status: 'inProgress',
            itemType: meta.itemType,
            toolName: call.name,
            title: meta.title,
            detail: meta.detail,
            body: meta.itemType === 'command_execution' ? String(input.command ?? '') : bodyForInput(call.name, input),
            changedFiles: meta.changedFiles
          })

          const result = await this.runTool(call.name, input, cwd, permissionMode, {
            threadId,
            turnId,
            requestId: call.id || randomUUID()
          })

          const status: WorkStatus = result.isError ? 'failed' : 'completed'
          emitWork(workId, {
            tone: result.isError ? 'error' : 'tool',
            status,
            itemType: meta.itemType,
            toolName: call.name,
            title: meta.title,
            detail: null,
            body: result.output ? truncate(result.output, MAX_TOOL_OUTPUT) : null,
            changedFiles: []
          })

          messages.push({ role: 'tool', tool_call_id: call.id, content: result.output || (result.isError ? 'error' : 'ok') })
        }
      }
      return { state: 'error', costUsd: null, assistantMessageId, error: `Exceeded ${MAX_TURN_STEPS} tool steps` }
    } catch (err) {
      flushDelta()
      if (abort.signal.aborted) return { state: 'interrupted', costUsd: null, assistantMessageId }
      return { state: 'error', costUsd: null, assistantMessageId, error: String(err) }
    }
  }

  /** Approve (if required) then execute a single tool call against the working tree. */
  private async runTool(
    name: string,
    input: Record<string, unknown>,
    cwd: string,
    mode: string,
    ctx: { threadId: string; turnId: string; requestId: string }
  ): Promise<{ output: string; isError: boolean }> {
    if (mode === 'plan' && MUTATING_TOOLS.has(name)) {
      return { output: 'Plan mode is read-only — this action was not executed.', isError: true }
    }
    if (needsApproval(name, mode)) {
      const decision = await this.host.requestPermission({
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        toolName: name,
        kind: approvalKind(name),
        detail: toolMeta(name, input).detail ?? name,
        input,
        requestId: ctx.requestId
      })
      if (decision.behavior === 'deny') {
        return { output: decision.message || 'Denied by user.', isError: true }
      }
    }

    try {
      switch (name) {
        case 'Bash':
          return await runBash(String(input.command ?? ''), cwd)
        case 'Read': {
          const content = await readFile(resolvePath(cwd, String(input.file_path ?? '')), 'utf8')
          return { output: content, isError: false }
        }
        case 'Write': {
          const target = resolvePath(cwd, String(input.file_path ?? ''))
          await mkdir(dirname(target), { recursive: true })
          const content = String(input.content ?? '')
          await writeFile(target, content, 'utf8')
          return { output: `Wrote ${content.length} chars to ${input.file_path}`, isError: false }
        }
        case 'Edit': {
          const target = resolvePath(cwd, String(input.file_path ?? ''))
          const oldStr = String(input.old_string ?? '')
          const current = await readFile(target, 'utf8')
          if (!oldStr || !current.includes(oldStr)) {
            return { output: `old_string not found in ${input.file_path}`, isError: true }
          }
          const updated = current.split(oldStr).join(String(input.new_string ?? ''))
          await writeFile(target, updated, 'utf8')
          return { output: `Edited ${input.file_path}`, isError: false }
        }
        default:
          return { output: `Unknown tool: ${name}`, isError: true }
      }
    } catch (err) {
      return { output: String(err), isError: true }
    }
  }
}

/**
 * Read the OpenAI API key the `codex` CLI persisted at `$CODEX_HOME/auth.json`
 * (default `~/.codex/auth.json`). Returns null on any problem — missing file,
 * bad JSON, or a ChatGPT-subscription login that carries OAuth tokens instead
 * of an API key (those can't be used against the standard OpenAI API).
 */
async function readCodexAuthKey(): Promise<string | null> {
  try {
    const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
    const parsed = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
    const key = parsed?.OPENAI_API_KEY
    return typeof key === 'string' && key.trim() ? key.trim() : null
  } catch {
    return null
  }
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p)
}

function safeParse(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args || '{}')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function runBash(command: string, cwd: string): Promise<{ output: string; isError: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn('bash', ['-lc', command], { cwd })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), BASH_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ output: String(err), isError: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const suffix = code === 0 ? '' : `\n[exit ${code}]`
      resolvePromise({ output: out + suffix, isError: code !== 0 })
    })
  })
}
