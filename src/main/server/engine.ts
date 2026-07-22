import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Command, CommandResult } from '@shared/commands'
import type { NewEvent, OrchestrationEvent } from '@shared/events'
import type { StreamMessage } from '@shared/rpc'
import { RUNTIME_MODE_TO_PERMISSION, type ApprovalDecision, type ApprovalKind, type InteractionMode, type RuntimeMode } from '@shared/domain'
import type { DiffAction, DiffResult, DiffScope, DiffSummary } from '@shared/diff'
import { Db } from './db'
import { applyEvent, getShellSnapshot, getThreadDetail, getThreadProjectPath } from './projections'
import { applyFileAction, isGitRepo, snapshotWorkingTree, turnDiff, turnDiffStat, workingDiff, workingSummary } from './git'
import { providerForModel } from './models'
import { ClaudeAdapter } from './provider/claudeAdapter'
import { CodexAppServerAdapter } from './provider/codexAppServerAdapter'
import type { AgentHost, ProviderAdapter, ProviderKind, ProviderPermissionResult, TurnOutcome } from './provider/types'

type Send = (msg: StreamMessage) => void

const isAutoTitle = (title: string): boolean => /^(New Thread|Thread \d+)$/.test(title)

interface Subscription {
  id: number
  kind: 'shell' | 'thread'
  threadId?: string
  send: Send
}

interface PendingApproval {
  resolve: (r: ProviderPermissionResult) => void
  threadId: string
  toolName: string
  input: Record<string, unknown>
}

const SHELL_RELEVANT = new Set([
  'project.created',
  'project.updated',
  'project.opened',
  'project.removed',
  'thread.created',
  'thread.updated',
  'thread.visited',
  'thread.deleted',
  'thread.session',
  'turn.started',
  'turn.completed',
  'message.created',
  'approval.requested',
  'approval.resolved'
])

/** Trailing debounce for shell-snapshot rebroadcasts (they re-query all projects+threads). */
const SHELL_BROADCAST_MS = 75

export class Engine implements AgentHost {
  private subs = new Map<number, Subscription>()
  private subSeq = 0
  /** one handler per vendor; a thread's selected model routes to one of these */
  private adapters: Record<ProviderKind, ProviderAdapter> = {
    claude: new ClaudeAdapter(this),
    codexAgent: new CodexAppServerAdapter(this)
  }
  private pending = new Map<string, PendingApproval>()
  private sessionAllow = new Map<string, Set<string>>()
  /** AbortController per thread with a turn in flight — set synchronously at dispatch. */
  private activeTurns = new Map<string, AbortController>()
  private shellTimer: NodeJS.Timeout | null = null

  constructor(private readonly db: Db) {}

  /**
   * Heal crash/quit leftovers (unanswerable approvals, threads stuck 'running').
   * Emitted as events so a projection rebuild reproduces the healed state.
   */
  recoverFromRestart(): void {
    const events: NewEvent[] = []
    for (const a of this.db.all<{ id: string; thread_id: string }>('SELECT id, thread_id FROM approvals WHERE resolved=0')) {
      events.push(this.ev('approval.resolved', a.thread_id, { requestId: a.id, threadId: a.thread_id }))
    }
    for (const t of this.db.all<{ id: string; thread_id: string }>("SELECT id, thread_id FROM turns WHERE state='running'")) {
      events.push(this.ev('turn.completed', t.thread_id, { threadId: t.thread_id, turnId: t.id, state: 'interrupted', assistantMessageId: null, costUsd: null }))
    }
    for (const m of this.db.all<{ id: string; thread_id: string; text: string | null }>('SELECT id, thread_id, text FROM messages WHERE streaming=1')) {
      events.push(this.ev('message.completed', m.thread_id, { messageId: m.id, threadId: m.thread_id, text: m.text ?? '' }))
    }
    for (const t of this.db.all<{ id: string }>("SELECT id FROM threads WHERE status='running' AND deleted=0")) {
      events.push(this.ev('thread.session', t.id, { threadId: t.id, status: 'error', lastError: 'Interrupted by app restart' }))
    }
    if (events.length) this.append(events)
  }

  // ---------- subscriptions ----------
  subscribeShell(send: Send): () => void {
    const id = ++this.subSeq
    this.subs.set(id, { id, kind: 'shell', send })
    send({ type: 'shell-snapshot', snapshot: getShellSnapshot(this.db) })
    return () => this.subs.delete(id)
  }

  subscribeThread(threadId: string, send: Send): () => void {
    const id = ++this.subSeq
    this.subs.set(id, { id, kind: 'thread', threadId, send })
    const detail = getThreadDetail(this.db, threadId)
    if (detail) send({ type: 'thread-snapshot', detail })
    else send({ type: 'thread-not-found', threadId })
    return () => this.subs.delete(id)
  }

  // ---------- event append / broadcast ----------
  private append(events: NewEvent[]): OrchestrationEvent[] {
    // one transaction per batch: the log and the projections stay in lockstep
    const applied = this.db.transaction(() => {
      const out: OrchestrationEvent[] = []
      for (const ne of events) {
        const seq = this.db.insertEvent(ne.id, ne.ts, ne.streamId, ne.type, JSON.stringify(ne.payload))
        const e = { ...ne, seq } as OrchestrationEvent
        applyEvent(this.db, e)
        out.push(e)
      }
      return out
    })
    this.broadcast(applied)
    return applied
  }

  private broadcast(events: OrchestrationEvent[]): void {
    const byThread = new Map<string, OrchestrationEvent[]>()
    let shellDirty = false
    for (const e of events) {
      if (!byThread.has(e.streamId)) byThread.set(e.streamId, [])
      byThread.get(e.streamId)!.push(e)
      if (SHELL_RELEVANT.has(e.type)) shellDirty = true
    }
    for (const sub of this.subs.values()) {
      if (sub.kind === 'thread' && sub.threadId) {
        const evs = byThread.get(sub.threadId)
        if (evs?.length) sub.send({ type: 'events', events: evs })
      }
    }
    if (shellDirty) this.scheduleShellBroadcast()
  }

  private scheduleShellBroadcast(): void {
    if (this.shellTimer) return
    this.shellTimer = setTimeout(() => {
      this.shellTimer = null
      const snapshot = getShellSnapshot(this.db)
      for (const sub of this.subs.values()) if (sub.kind === 'shell') sub.send({ type: 'shell-snapshot', snapshot })
    }, SHELL_BROADCAST_MS)
  }

  private ev<T extends NewEvent['type']>(type: T, streamId: string, payload: Extract<NewEvent, { type: T }>['payload']): NewEvent {
    return { type, id: randomUUID(), ts: Date.now(), streamId, payload } as NewEvent
  }

  // ---------- command dispatch ----------
  dispatch(cmd: Command): CommandResult {
    try {
      return this.handle(cmd)
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  private handle(cmd: Command): CommandResult {
    switch (cmd.type) {
      case 'project.add': {
        const existing = this.db.get<{ id: string }>('SELECT id FROM projects WHERE folder_path=? AND removed=0', [cmd.folderPath])
        if (existing) {
          this.append([this.ev('project.opened', existing.id, { projectId: existing.id })])
          return { ok: true, data: { projectId: existing.id } }
        }
        const id = randomUUID()
        const name = cmd.name?.trim() || basename(cmd.folderPath) || cmd.folderPath
        this.append([this.ev('project.created', id, { projectId: id, name, folderPath: cmd.folderPath, isGitRepo: isGitRepo(cmd.folderPath) })])
        return { ok: true, data: { projectId: id } }
      }
      case 'project.rename':
        this.append([this.ev('project.updated', cmd.projectId, { projectId: cmd.projectId, name: cmd.name })])
        return { ok: true }
      case 'project.remove': {
        for (const t of this.db.all<{ id: string }>('SELECT id FROM threads WHERE project_id=? AND deleted=0', [cmd.projectId])) {
          this.stopThreadWork(t.id)
        }
        this.append([this.ev('project.removed', cmd.projectId, { projectId: cmd.projectId })])
        return { ok: true }
      }
      case 'project.open':
        this.append([this.ev('project.opened', cmd.projectId, { projectId: cmd.projectId })])
        return { ok: true }
      case 'thread.create': {
        const id = randomUUID()
        const interactionMode: InteractionMode = 'build'
        const runtimeMode: RuntimeMode = 'full-access'
        this.append([
          this.ev('thread.created', id, {
            threadId: id,
            projectId: cmd.projectId,
            title: cmd.title?.trim() || 'New Thread',
            interactionMode,
            runtimeMode,
            model: null,
            reasoningEffort: null
          })
        ])
        return { ok: true, data: { threadId: id } }
      }
      case 'thread.rename':
        this.append([this.ev('thread.updated', cmd.threadId, { threadId: cmd.threadId, title: cmd.title })])
        return { ok: true }
      case 'thread.delete':
        this.stopThreadWork(cmd.threadId)
        this.append([this.ev('thread.deleted', cmd.threadId, { threadId: cmd.threadId })])
        return { ok: true }
      case 'thread.visit':
        this.append([this.ev('thread.visited', cmd.threadId, { threadId: cmd.threadId })])
        return { ok: true }
      case 'thread.setConfig':
        this.append([
          this.ev('thread.updated', cmd.threadId, {
            threadId: cmd.threadId,
            interactionMode: cmd.interactionMode,
            runtimeMode: cmd.runtimeMode,
            model: cmd.model,
            reasoningEffort: cmd.reasoningEffort
          })
        ])
        return { ok: true }
      case 'turn.send':
        return this.startTurn(cmd.threadId, cmd.text)
      case 'turn.interrupt':
        this.activeTurns.get(cmd.threadId)?.abort()
        this.rejectPendingForThread(cmd.threadId)
        return { ok: true }
      case 'approval.respond':
        return this.resolveApproval(cmd.threadId, cmd.requestId, cmd.decision)
    }
  }

  private stopThreadWork(threadId: string): void {
    this.activeTurns.get(threadId)?.abort()
    this.rejectPendingForThread(threadId)
    for (const adapter of Object.values(this.adapters)) adapter.cancelTitle(threadId)
    this.sessionAllow.delete(threadId)
  }

  private startTurn(threadId: string, text: string): CommandResult {
    const info = getThreadProjectPath(this.db, threadId)
    if (!info) return { ok: false, error: 'Thread not found' }
    if (this.activeTurns.has(threadId)) return { ok: false, error: 'A turn is already running' }
    const { thread, project } = info
    const turnId = randomUUID()
    const userMsgId = randomUUID()

    // first user message on an auto-named thread → derive a title from it
    const priorUserMsgs = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND role='user'", [threadId])?.c ?? 0
    if (priorUserMsgs === 0 && isAutoTitle(thread.title) && text.trim()) {
      void this.autoTitle(threadId, project.folderPath, text.trim(), thread.model)
    }

    this.append([
      this.ev('message.created', threadId, { messageId: userMsgId, threadId, turnId, role: 'user', text, streaming: false }),
      this.ev('turn.started', threadId, { threadId, turnId }),
      this.ev('thread.session', threadId, { threadId, status: 'running', lastError: null })
    ])

    // set synchronously so a double-send can't start a second run and
    // interrupt has a controller to abort even before the SDK has loaded
    const abort = new AbortController()
    this.activeTurns.set(threadId, abort)

    const permissionMode = thread.interactionMode === 'plan' ? 'plan' : RUNTIME_MODE_TO_PERMISSION[thread.runtimeMode]
    void this.runTurn({ threadId, turnId, cwd: project.folderPath, prompt: text, model: thread.model, reasoningEffort: thread.reasoningEffort, permissionMode, resumeSessionId: thread.sdkSessionId, abort })
    return { ok: true, data: { turnId } }
  }

  /** Generate a conversation-derived title for a freshly-created thread. */
  private async autoTitle(threadId: string, cwd: string, message: string, model: string | null): Promise<void> {
    const title = await this.adapters[providerForModel(model)].generateTitle(threadId, cwd, message)
    if (!title) return
    // don't clobber a title the user renamed while generation was in flight
    const current = this.db.get<{ title: string }>('SELECT title FROM threads WHERE id=?', [threadId])?.title
    if (!current || !isAutoTitle(current)) return
    this.append([this.ev('thread.updated', threadId, { threadId, title })])
  }

  private async runTurn(p: {
    threadId: string
    turnId: string
    cwd: string
    prompt: string
    model: string | null
    reasoningEffort: string | null
    permissionMode: string
    resumeSessionId: string | null
    abort: AbortController
  }): Promise<void> {
    let before: string | null = null
    let outcome: TurnOutcome
    try {
      before = await snapshotWorkingTree(p.cwd)
      this.db.run('INSERT OR REPLACE INTO turn_git (turn_id, thread_id, before_tree, after_tree) VALUES (?,?,?,NULL)', [p.turnId, p.threadId, before])
      outcome = await this.adapters[providerForModel(p.model)].runTurn(p)
    } catch (err) {
      // an unexpected throw must never leave the thread stuck "running"
      outcome = p.abort.signal.aborted
        ? { state: 'interrupted', costUsd: null, assistantMessageId: null }
        : { state: 'error', costUsd: null, assistantMessageId: null, error: String(err) }
    } finally {
      this.activeTurns.delete(p.threadId)
      // clear any approval left dangling (e.g. stream died mid-prompt)
      this.rejectPendingForThread(p.threadId)
    }

    // checkpoint the turn's file changes for the diff viewer
    const after = await snapshotWorkingTree(p.cwd)
    this.db.run('UPDATE turn_git SET after_tree=? WHERE turn_id=?', [after, p.turnId])
    if (before && after && before !== after) {
      const stat = await turnDiffStat(p.cwd, before, after)
      if (stat.filesChanged > 0) {
        this.append([
          this.ev('checkpoint.created', p.threadId, {
            checkpointId: randomUUID(),
            threadId: p.threadId,
            turnId: p.turnId,
            filesChanged: stat.filesChanged,
            additions: stat.additions,
            deletions: stat.deletions
          })
        ])
      }
    }

    const status = outcome.state === 'completed' ? 'completed' : outcome.state === 'interrupted' ? 'idle' : 'error'
    this.append([
      this.ev('turn.completed', p.threadId, {
        threadId: p.threadId,
        turnId: p.turnId,
        state: outcome.state,
        assistantMessageId: outcome.assistantMessageId,
        costUsd: outcome.costUsd
      }),
      this.ev('thread.session', p.threadId, { threadId: p.threadId, status, lastError: outcome.error ?? null })
    ])
  }

  // ---------- AgentHost implementation ----------
  onSessionId(threadId: string, sdkSessionId: string): void {
    const cur = this.db.get<{ sid: string | null }>('SELECT sdk_session_id AS sid FROM threads WHERE id=?', [threadId])
    if (cur?.sid !== sdkSessionId) this.append([this.ev('thread.session', threadId, { threadId, sdkSessionId })])
  }

  ensureAssistantMessage(threadId: string, turnId: string): string {
    const id = randomUUID()
    this.append([this.ev('message.created', threadId, { messageId: id, threadId, turnId, role: 'assistant', text: '', streaming: true })])
    return id
  }

  ensureReasoningMessage(threadId: string, turnId: string): string {
    const id = randomUUID()
    this.append([this.ev('message.created', threadId, { messageId: id, threadId, turnId, role: 'reasoning', text: '', streaming: true })])
    return id
  }

  onAssistantTextDelta(threadId: string, _turnId: string, messageId: string, delta: string): void {
    this.append([this.ev('message.delta', threadId, { messageId, threadId, delta })])
  }

  finalizeAssistantMessage(threadId: string, messageId: string, finalText: string): void {
    this.append([this.ev('message.completed', threadId, { messageId, threadId, text: finalText })])
  }

  onWork(threadId: string, upsert: Parameters<AgentHost['onWork']>[1]): void {
    this.append([this.ev('work.upserted', threadId, upsert)])
  }

  onPlan(threadId: string, turnId: string, text: string): void {
    this.append([this.ev('plan.proposed', threadId, { planId: randomUUID(), threadId, turnId, text })])
  }

  requestPermission(args: {
    threadId: string
    turnId: string
    toolName: string
    kind: ApprovalKind
    detail: string
    input: Record<string, unknown>
    requestId: string
  }): Promise<ProviderPermissionResult> {
    const allow = this.sessionAllow.get(args.threadId)
    if (allow?.has(args.toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: args.input })
    this.append([
      this.ev('approval.requested', args.threadId, {
        requestId: args.requestId,
        threadId: args.threadId,
        turnId: args.turnId,
        toolName: args.toolName,
        kind: args.kind,
        detail: args.detail,
        input: args.input
      })
    ])
    return new Promise<ProviderPermissionResult>((resolve) => {
      this.pending.set(args.requestId, { resolve, threadId: args.threadId, toolName: args.toolName, input: args.input })
    })
  }

  private resolveApproval(threadId: string, requestId: string, decision: ApprovalDecision): CommandResult {
    const p = this.pending.get(requestId)
    this.pending.delete(requestId)
    // emitted even when the resolver is gone (e.g. it predates a restart) so the UI can't get stuck
    this.append([this.ev('approval.resolved', threadId, { requestId, threadId })])
    if (!p) return { ok: true }
    if (decision.behavior === 'allow') {
      if (decision.scope === 'session') {
        if (!this.sessionAllow.has(threadId)) this.sessionAllow.set(threadId, new Set())
        this.sessionAllow.get(threadId)!.add(p.toolName)
      }
      p.resolve({ behavior: 'allow', updatedInput: p.input })
    } else {
      p.resolve({ behavior: 'deny', message: decision.message || 'Denied by user', interrupt: !decision.message })
    }
    return { ok: true }
  }

  private rejectPendingForThread(threadId: string): void {
    for (const [requestId, p] of [...this.pending]) {
      if (p.threadId !== threadId) continue
      this.pending.delete(requestId)
      this.append([this.ev('approval.resolved', threadId, { requestId, threadId })])
      p.resolve({ behavior: 'deny', message: 'Interrupted', interrupt: true })
    }
  }

  // ---------- diffs ----------
  async getDiff(threadId: string, scope: DiffScope): Promise<DiffResult> {
    const info = getThreadProjectPath(this.db, threadId)
    if (!info) return { scope, isGitRepo: false, files: [], additions: 0, deletions: 0, error: 'Thread not found' }
    const cwd = info.project.folderPath
    if (scope.kind === 'working') return workingDiff(cwd)
    const row = this.db.get<{ before_tree: string | null; after_tree: string | null }>('SELECT before_tree, after_tree FROM turn_git WHERE turn_id=?', [scope.turnId])
    if (!row?.before_tree || !row?.after_tree) return { scope, isGitRepo: isGitRepo(cwd), files: [], additions: 0, deletions: 0, error: 'No checkpoint for this turn' }
    return turnDiff(cwd, scope.turnId, row.before_tree, row.after_tree)
  }

  async getDiffSummary(threadId: string): Promise<DiffSummary> {
    const info = getThreadProjectPath(this.db, threadId)
    if (!info) return { isGitRepo: false, files: 0, additions: 0, deletions: 0 }
    return workingSummary(info.project.folderPath)
  }

  async applyFileAction(threadId: string, action: DiffAction, path: string): Promise<{ ok: boolean; error?: string }> {
    const info = getThreadProjectPath(this.db, threadId)
    if (!info) return { ok: false, error: 'Thread not found' }
    return applyFileAction(info.project.folderPath, action, path)
  }
}
