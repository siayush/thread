/**
 * CodexAppServerAdapter — the OpenAI (Codex) handler.
 *
 * Instead of calling the OpenAI API in-process, this spawns the `codex` CLI in
 * `app-server` mode and drives its JSON-RPC protocol — structurally the same as
 * how the Claude
 * handler delegates to the bundled Claude Code CLI. Auth, the agent loop, tool
 * execution, and the sandbox all live inside `codex`; we only translate its
 * event stream into the shared `AgentHost` callbacks.
 *
 * Because auth is the CLI's job (`codex login`), this path needs **no API key**
 * from us and supports ChatGPT-subscription logins.
 *
 * Protocol: initialize → initialized → thread/start → per turn
 * turn/start, then stream item/* notifications until turn/completed. Approval
 * prompts arrive as server→client requests we answer via the same approval flow
 * the Claude handler uses.
 *
 * One long-lived app-server process is kept per thread (native multi-turn); it
 * is created lazily on the first turn. State is in-process, so a Codex thread's
 * server is recreated after an app restart.
 *
 * @module provider/codexAppServerAdapter
 */
import type { WorkStatus, WorkItemType } from '@shared/domain'
import type { WorkUpsert } from '@shared/events'
import { codexModelSlug } from '../models'
import { CodexAppServer } from './codexAppServer'
import { createDeltaBatcher } from './deltaBatcher'
import type { AgentHost, ProviderAdapter, ProviderKind, ProviderPermissionResult, RunTurnParams, TurnOutcome } from './types'
import { firstLine, truncate } from './toolMeta'

const MAX_BODY = 12_000

/* eslint-disable @typescript-eslint/no-explicit-any */

interface TurnContext {
  /** The engine's turn id — what every host callback must tag events with so
   *  they group under the turn the engine created (see engine.runTurn). */
  engineTurnId: string
  /** Codex app-server's own turn id, used only to address `turn/interrupt`. */
  turnId: string | null
  settled: boolean
  resolve: (o: TurnOutcome) => void
  assistantMessageId: string | null
  msgIdByItem: Map<string, string>
  workIdByItem: Map<string, string>
  /** reasoning item id -> the streaming `reasoning` message id it feeds */
  reasoningMsgByItem: Map<string, string>
  flushDelta: () => void
  queueDelta: (msgId: string, text: string) => void
}

interface CodexSession {
  server: CodexAppServer
  providerThreadId: string
  turn: TurnContext | null
}

/** Map our thread permission mode onto codex approval + sandbox policy. */
function policyForMode(mode: string): {
  approvalPolicy: 'untrusted' | 'on-request' | 'never'
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  sandboxType: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess'
} {
  switch (mode) {
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxType: 'readOnly' }
    case 'acceptEdits':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxType: 'workspaceWrite' }
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxType: 'dangerFullAccess' }
    default: // 'default' (supervised): ask before commands & edits
      return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxType: 'readOnly' }
  }
}

/** Translate our approval result into codex's decision enum. */
function toCodexDecision(result: ProviderPermissionResult): 'approved' | 'denied' | 'abort' {
  if (result.behavior === 'allow') return 'approved'
  return result.interrupt ? 'abort' : 'denied'
}

/** Map a codex thread item to a canonical work item shape. */
function itemToWork(item: any): {
  itemType: WorkItemType
  title: string
  toolName: string | null
  detail: string | null
  changedFiles: string[]
  tone: 'tool' | 'thinking'
} {
  switch (item?.type) {
    case 'commandExecution':
      return { itemType: 'command_execution', title: 'Ran command', toolName: 'Bash', detail: item.command ?? null, changedFiles: [], tone: 'tool' }
    case 'fileChange': {
      const paths = (item.changes ?? []).map((c: any) => c?.path).filter((p: any): p is string => typeof p === 'string')
      return { itemType: 'file_change', title: 'Edited file', toolName: 'Edit', detail: paths[0] ?? null, changedFiles: paths, tone: 'tool' }
    }
    case 'mcpToolCall':
      return { itemType: 'mcp_tool_call', title: item.tool ?? 'MCP tool', toolName: item.tool ?? null, detail: item.server ?? null, changedFiles: [], tone: 'tool' }
    case 'webSearch':
      return { itemType: 'web_search', title: 'Web search', toolName: 'WebSearch', detail: item.query ?? null, changedFiles: [], tone: 'tool' }
    case 'reasoning':
      return { itemType: 'reasoning', title: 'Thought', toolName: null, detail: null, changedFiles: [], tone: 'thinking' }
    default:
      return { itemType: 'generic', title: item?.type ?? 'Item', toolName: null, detail: null, changedFiles: [], tone: 'tool' }
  }
}

function reasoningText(item: any): string {
  const parts = [...(item.summary ?? []), ...(item.content ?? [])].filter((s: any) => typeof s === 'string')
  return parts.join('\n')
}

export class CodexAppServerAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = 'codexAgent'
  private sessions = new Map<string, CodexSession>()

  constructor(private readonly host: AgentHost) {}

  // Codex owns titling; we keep the fallback "Thread N" name.
  async generateTitle(): Promise<string | null> {
    return null
  }
  cancelTitle(): void {}

  async runTurn(params: RunTurnParams): Promise<TurnOutcome> {
    const { threadId, turnId, cwd, prompt, model, reasoningEffort, permissionMode, abort } = params
    if (abort.signal.aborted) return { state: 'interrupted', costUsd: null, assistantMessageId: null }

    const policy = policyForMode(permissionMode)
    const slug = codexModelSlug(model)

    let session: CodexSession
    try {
      session = await this.ensureSession(threadId, cwd, policy, slug)
    } catch (err) {
      return { state: 'error', costUsd: null, assistantMessageId: null, error: `Failed to start codex app-server: ${String(err)}` }
    }

    return await new Promise<TurnOutcome>((resolveOuter) => {
      // ---- per-turn streaming state ----
      const { queue: queueDelta, flush: flushDelta } = createDeltaBatcher(this.host, threadId, turnId)

      const ctx: TurnContext = {
        engineTurnId: turnId,
        turnId: null,
        settled: false,
        resolve: resolveOuter,
        assistantMessageId: null,
        msgIdByItem: new Map(),
        workIdByItem: new Map(),
        reasoningMsgByItem: new Map(),
        flushDelta,
        queueDelta
      }
      session.turn = ctx

      const settle = (o: TurnOutcome): void => {
        if (ctx.settled) return
        ctx.settled = true
        flushDelta()
        abort.signal.removeEventListener('abort', onAbort)
        session.turn = null
        resolveOuter({ ...o, assistantMessageId: o.assistantMessageId ?? ctx.assistantMessageId })
      }

      const onAbort = (): void => {
        if (ctx.settled) return
        if (ctx.turnId) session.server.notify('turn/interrupt', { threadId: session.providerThreadId, turnId: ctx.turnId })
        settle({ state: 'interrupted', costUsd: null, assistantMessageId: ctx.assistantMessageId })
      }
      abort.signal.addEventListener('abort', onAbort)

      // Bind this turn's settle so session-level handlers can reach it.
      session.turn.resolve = settle as any

      session.server
        .request('turn/start', {
          threadId: session.providerThreadId,
          input: [{ type: 'text', text: prompt }],
          approvalPolicy: policy.approvalPolicy,
          sandboxPolicy: { type: policy.sandboxType },
          ...(slug ? { model: slug } : {}),
          // `summary` makes the app-server stream reasoning even at default effort
          summary: 'auto',
          ...(reasoningEffort ? { effort: reasoningEffort } : {})
        })
        .then((res: any) => {
          ctx.turnId = res?.turn?.id ?? null
        })
        .catch((err) => settle({ state: 'error', costUsd: null, assistantMessageId: ctx.assistantMessageId, error: String(err) }))
    })
  }

  // ---------- session lifecycle ----------
  private async ensureSession(
    threadId: string,
    cwd: string,
    policy: ReturnType<typeof policyForMode>,
    slug: string | null
  ): Promise<CodexSession> {
    const existing = this.sessions.get(threadId)
    if (existing) return existing

    const server = new CodexAppServer({
      cwd,
      onExit: () => this.sessions.delete(threadId)
    })

    const session: CodexSession = { server, providerThreadId: '', turn: null }
    this.registerHandlers(threadId, session)

    await server.request('initialize', {
      clientInfo: { name: 'thread', title: 'Thread', version: '0.2.0' },
      capabilities: { experimentalApi: true }
    })
    server.notify('initialized')

    const opened: any = await server.request('thread/start', {
      cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(slug ? { model: slug } : {})
    })
    session.providerThreadId = opened?.thread?.id ?? ''
    this.sessions.set(threadId, session)
    this.host.onSessionId(threadId, session.providerThreadId)
    return session
  }

  private registerHandlers(threadId: string, session: CodexSession): void {
    const { server } = session
    const emitWork = (workId: string, upsert: Omit<WorkUpsert, 'workId' | 'threadId' | 'turnId'>, turnId: string): void => {
      this.host.onWork(threadId, { workId, threadId, turnId, ...upsert })
    }

    server.onNotification('item/agentMessage/delta', (p: any) => {
      const ctx = session.turn
      if (!ctx) return
      let msgId = ctx.msgIdByItem.get(p.itemId)
      if (!msgId) {
        msgId = this.host.ensureAssistantMessage(threadId, ctx.engineTurnId)
        ctx.msgIdByItem.set(p.itemId, msgId)
      }
      ctx.queueDelta(msgId, p.delta ?? '')
    })

    const reasoningMsgFor = (itemId: string, ctx: TurnContext): string => {
      let msgId = ctx.reasoningMsgByItem.get(itemId)
      if (!msgId) {
        msgId = this.host.ensureReasoningMessage(threadId, ctx.engineTurnId)
        ctx.reasoningMsgByItem.set(itemId, msgId)
      }
      return msgId
    }
    const streamReasoning = (p: any): void => {
      const ctx = session.turn
      if (!ctx || !p?.itemId || !p.delta) return
      ctx.queueDelta(reasoningMsgFor(p.itemId, ctx), p.delta)
    }
    server.onNotification('item/reasoning/summaryTextDelta', streamReasoning)
    server.onNotification('item/reasoning/textDelta', streamReasoning)

    server.onNotification('item/started', (p: any) => {
      const ctx = session.turn
      if (!ctx) return
      const item = p.item
      if (!item) return
      if (item.type === 'agentMessage') {
        if (!ctx.msgIdByItem.has(item.id)) ctx.msgIdByItem.set(item.id, this.host.ensureAssistantMessage(threadId, ctx.engineTurnId))
        return
      }
      // reasoning messages open lazily on the first non-empty delta,
      // so an empty summary never leaves an empty "Thought" row
      if (item.type === 'reasoning') return
      if (item.type === 'plan') return
      const meta = itemToWork(item)
      const workId = `${ctx.engineTurnId}:${item.id}`
      ctx.workIdByItem.set(item.id, workId)
      emitWork(
        workId,
        {
          tone: meta.tone,
          status: 'inProgress',
          itemType: meta.itemType,
          toolName: meta.toolName,
          title: meta.title,
          detail: meta.detail,
          body: item.type === 'commandExecution' ? String(item.command ?? '') : null,
          changedFiles: meta.changedFiles
        },
        ctx.engineTurnId
      )
    })

    server.onNotification('item/completed', (p: any) => {
      const ctx = session.turn
      if (!ctx) return
      const item = p.item
      if (!item) return
      if (item.type === 'agentMessage') {
        ctx.flushDelta()
        const msgId = ctx.msgIdByItem.get(item.id) ?? this.host.ensureAssistantMessage(threadId, ctx.engineTurnId)
        this.host.finalizeAssistantMessage(threadId, msgId, item.text ?? '')
        ctx.assistantMessageId = msgId
        return
      }
      if (item.type === 'plan') {
        if (item.text) this.host.onPlan(threadId, ctx.engineTurnId, String(item.text))
        return
      }
      if (item.type === 'reasoning') {
        ctx.flushDelta()
        const text = reasoningText(item)
        const existing = ctx.reasoningMsgByItem.get(item.id)
        if (existing) this.host.finalizeAssistantMessage(threadId, existing, text)
        else if (text.trim()) this.host.finalizeAssistantMessage(threadId, this.host.ensureReasoningMessage(threadId, ctx.engineTurnId), text)
        return
      }
      const meta = itemToWork(item)
      const workId = ctx.workIdByItem.get(item.id) ?? `${ctx.engineTurnId}:${item.id}`
      const failed = item.status === 'failed'
      const body =
        item.type === 'commandExecution'
          ? [item.aggregatedOutput, item.exitCode != null && item.exitCode !== 0 ? `[exit ${item.exitCode}]` : ''].filter(Boolean).join('\n')
          : null
      emitWork(
        workId,
        {
          tone: failed ? 'error' : meta.tone,
          status: (failed ? 'failed' : 'completed') as WorkStatus,
          itemType: meta.itemType,
          toolName: meta.toolName,
          title: meta.title,
          detail: meta.tone === 'thinking' ? firstLine(reasoningText(item)) : meta.detail,
          body: body ? truncate(body, MAX_BODY) : null,
          changedFiles: meta.changedFiles
        },
        ctx.engineTurnId
      )
    })

    server.onNotification('turn/plan/updated', (p: any) => {
      const ctx = session.turn
      if (ctx && p?.plan) this.host.onPlan(threadId, ctx.engineTurnId, typeof p.plan === 'string' ? p.plan : JSON.stringify(p.plan))
    })

    server.onNotification('turn/completed', (p: any) => {
      const ctx = session.turn
      if (!ctx) return
      const status = p?.turn?.status
      if (status === 'failed') {
        const msg = p?.turn?.error?.message ?? 'Codex turn failed'
        ;(ctx.resolve as any)({ state: 'error', costUsd: null, assistantMessageId: ctx.assistantMessageId, error: msg })
      } else {
        ;(ctx.resolve as any)({ state: 'completed', costUsd: null, assistantMessageId: ctx.assistantMessageId })
      }
    })

    server.onNotification('error', (p: any) => {
      const ctx = session.turn
      if (!ctx || p?.willRetry) return
      ;(ctx.resolve as any)({ state: 'error', costUsd: null, assistantMessageId: ctx.assistantMessageId, error: p?.error?.message ?? 'Codex error' })
    })

    // ---- approval prompts (server → client requests) ----
    const approve = (kind: 'command' | 'file-change', toolName: string) => async (p: any): Promise<{ decision: string }> => {
      const ctx = session.turn
      const result = await this.host.requestPermission({
        threadId,
        turnId: ctx?.engineTurnId ?? '',
        toolName,
        kind,
        detail: kind === 'command' ? (p.command ?? p.item?.command ?? toolName) : (p.item?.changes?.[0]?.path ?? toolName),
        input: p ?? {},
        requestId: p.approvalId ?? p.itemId ?? `${p.turnId}:${p.itemId}`
      })
      return { decision: toCodexDecision(result) }
    }
    server.onServerRequest('item/commandExecution/requestApproval', approve('command', 'Bash'))
    server.onServerRequest('item/fileChange/requestApproval', approve('file-change', 'Edit'))
  }
}
