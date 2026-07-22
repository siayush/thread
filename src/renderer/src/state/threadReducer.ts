import type { OrchestrationEvent } from '@shared/events'
import type { Message, ProposedPlan, Thread, ThreadDetail, Turn, WorkItem } from '@shared/domain'

/** Immutably fold one event into a ThreadDetail (client mirror of the projector). */
export function reduceThread(detail: ThreadDetail, e: OrchestrationEvent): ThreadDetail {
  const patchThread = (patch: Partial<Thread>): ThreadDetail => ({ ...detail, thread: { ...detail.thread, ...patch, latestActivityAt: e.ts } })

  switch (e.type) {
    case 'thread.updated': {
      const p = e.payload
      const patch: Partial<Thread> = {}
      if (p.title !== undefined) patch.title = p.title
      if (p.interactionMode !== undefined) patch.interactionMode = p.interactionMode
      if (p.runtimeMode !== undefined) patch.runtimeMode = p.runtimeMode
      if (p.model !== undefined) patch.model = p.model
      if (p.reasoningEffort !== undefined) patch.reasoningEffort = p.reasoningEffort
      return { ...detail, thread: { ...detail.thread, ...patch } }
    }
    case 'thread.visited':
      return { ...detail, thread: { ...detail.thread, lastVisitedAt: e.ts } }
    case 'thread.session': {
      const p = e.payload
      const patch: Partial<Thread> = {}
      if (p.status !== undefined) patch.status = p.status
      if (p.sdkSessionId !== undefined) patch.sdkSessionId = p.sdkSessionId
      if (p.lastError !== undefined) patch.lastError = p.lastError
      return patchThread(patch)
    }
    case 'turn.started': {
      const turn: Turn = { id: e.payload.turnId, threadId: detail.thread.id, state: 'running', assistantMessageId: null, startedAt: e.ts, completedAt: null, costUsd: null }
      return { ...patchThread({ activeTurnId: e.payload.turnId }), turns: upsert(detail.turns, turn) }
    }
    case 'turn.completed':
      return {
        ...patchThread({ activeTurnId: null }),
        turns: detail.turns.map((t) =>
          t.id === e.payload.turnId ? { ...t, state: e.payload.state, assistantMessageId: e.payload.assistantMessageId, completedAt: e.ts, costUsd: e.payload.costUsd } : t
        )
      }
    case 'message.created': {
      const m: Message = { id: e.payload.messageId, threadId: detail.thread.id, turnId: e.payload.turnId, role: e.payload.role, text: e.payload.text, streaming: e.payload.streaming, createdAt: e.ts, updatedAt: e.ts }
      return { ...patchThread({}), messages: upsert(detail.messages, m) }
    }
    case 'message.delta':
      return { ...detail, messages: detail.messages.map((m) => (m.id === e.payload.messageId ? { ...m, text: m.text + e.payload.delta, updatedAt: e.ts } : m)) }
    case 'message.completed':
      return { ...detail, messages: detail.messages.map((m) => (m.id === e.payload.messageId ? { ...m, text: e.payload.text, streaming: false, updatedAt: e.ts } : m)) }
    case 'work.upserted': {
      const w = e.payload
      const existing = detail.workItems.find((x) => x.id === w.workId)
      const item: WorkItem = {
        id: w.workId,
        threadId: detail.thread.id,
        turnId: w.turnId,
        tone: w.tone,
        status: w.status,
        itemType: w.itemType,
        toolName: w.toolName,
        title: w.title,
        // keep a richer prior detail if the update omitted it (tool results carry null)
        detail: w.detail ?? existing?.detail ?? null,
        body: w.body ?? existing?.body ?? null,
        changedFiles: w.changedFiles.length ? w.changedFiles : (existing?.changedFiles ?? []),
        createdAt: existing?.createdAt ?? e.ts,
        updatedAt: e.ts
      }
      return { ...detail, workItems: upsert(detail.workItems, item) }
    }
    case 'checkpoint.created':
      return { ...detail, checkpoints: upsert(detail.checkpoints, { id: e.payload.checkpointId, threadId: detail.thread.id, turnId: e.payload.turnId, filesChanged: e.payload.filesChanged, additions: e.payload.additions, deletions: e.payload.deletions, createdAt: e.ts }) }
    case 'plan.proposed': {
      const plan: ProposedPlan = { id: e.payload.planId, threadId: detail.thread.id, turnId: e.payload.turnId, text: e.payload.text, createdAt: e.ts }
      return { ...detail, plans: upsert(detail.plans, plan) }
    }
    case 'approval.requested':
      return {
        ...patchThread({ hasPendingApproval: true }),
        pendingApprovals: upsert(detail.pendingApprovals, {
          id: e.payload.requestId,
          threadId: detail.thread.id,
          turnId: e.payload.turnId,
          toolName: e.payload.toolName,
          kind: e.payload.kind,
          detail: e.payload.detail,
          input: e.payload.input,
          createdAt: e.ts
        })
      }
    case 'approval.resolved': {
      const remaining = detail.pendingApprovals.filter((a) => a.id !== e.payload.requestId)
      return { ...detail, thread: { ...detail.thread, hasPendingApproval: remaining.length > 0 }, pendingApprovals: remaining }
    }
    default:
      return detail
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx === -1) return [...list, item]
  const copy = list.slice()
  copy[idx] = item
  return copy
}
