import type { Db } from './db'
import type { OrchestrationEvent } from '@shared/events'
import type {
  Checkpoint,
  Message,
  PendingApproval,
  ProposedPlan,
  Project,
  ShellSnapshot,
  Thread,
  ThreadDetail,
  ThreadSummary,
  Turn,
  WorkItem
} from '@shared/domain'

/**
 * Bump whenever `applyEvent`'s semantics change: on next launch the read-model
 * tables are dropped and rebuilt from the event log (see `rebuildProjections`).
 */
export const PROJECTION_VERSION = 3

const PROJECTION_TABLES = ['projects', 'threads', 'messages', 'turns', 'work_items', 'checkpoints', 'plans', 'approvals']

/** Rebuild every read-model table by replaying the full event log. */
export function rebuildProjections(db: Db): void {
  db.transaction(() => {
    for (const table of PROJECTION_TABLES) db.run(`DELETE FROM ${table}`)
    const rows = db.all<{ seq: number; id: string; ts: number; stream_id: string; type: string; payload: string }>(
      'SELECT * FROM events ORDER BY seq'
    )
    for (const r of rows) {
      applyEvent(db, { seq: r.seq, id: r.id, ts: r.ts, streamId: r.stream_id, type: r.type, payload: JSON.parse(r.payload) } as OrchestrationEvent)
    }
  })
}

/**
 * Applies a single event to the read-model tables. Kept deterministic so the
 * projections can be rebuilt from the event log at any time — and MUST stay
 * semantically identical to the renderer's `reduceThread` fold.
 */
export function applyEvent(db: Db, e: OrchestrationEvent): void {
  switch (e.type) {
    case 'project.created': {
      const p = e.payload
      db.run(
        `INSERT OR REPLACE INTO projects (id,name,folder_path,is_git_repo,created_at,updated_at,last_opened_at,removed)
         VALUES (?,?,?,?,?,?,?,0)`,
        [p.projectId, p.name, p.folderPath, p.isGitRepo ? 1 : 0, e.ts, e.ts, e.ts]
      )
      break
    }
    case 'project.updated':
      if (e.payload.name !== undefined)
        db.run('UPDATE projects SET name=?, updated_at=? WHERE id=?', [e.payload.name, e.ts, e.payload.projectId])
      break
    case 'project.opened':
      db.run('UPDATE projects SET last_opened_at=? WHERE id=?', [e.ts, e.payload.projectId])
      break
    case 'project.removed':
      db.run('UPDATE projects SET removed=1 WHERE id=?', [e.payload.projectId])
      db.run('UPDATE threads SET deleted=1 WHERE project_id=?', [e.payload.projectId])
      break
    case 'thread.created': {
      const t = e.payload
      db.run(
        `INSERT OR REPLACE INTO threads
         (id,project_id,title,status,interaction_mode,runtime_mode,model,reasoning_effort,sdk_session_id,active_turn_id,last_error,has_pending_approval,created_at,updated_at,last_visited_at,latest_activity_at,deleted)
         VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,0,?,?,?,?,0)`,
        [t.threadId, t.projectId, t.title, 'idle', t.interactionMode, t.runtimeMode, t.model, t.reasoningEffort ?? null, e.ts, e.ts, e.ts, e.ts]
      )
      break
    }
    case 'thread.updated': {
      const t = e.payload
      const sets: string[] = []
      const vals: unknown[] = []
      if (t.title !== undefined) {
        sets.push('title=?')
        vals.push(t.title)
      }
      if (t.interactionMode !== undefined) {
        sets.push('interaction_mode=?')
        vals.push(t.interactionMode)
      }
      if (t.runtimeMode !== undefined) {
        sets.push('runtime_mode=?')
        vals.push(t.runtimeMode)
      }
      if (t.model !== undefined) {
        sets.push('model=?')
        vals.push(t.model)
      }
      if (t.reasoningEffort !== undefined) {
        sets.push('reasoning_effort=?')
        vals.push(t.reasoningEffort)
      }
      sets.push('updated_at=?')
      vals.push(e.ts, t.threadId)
      db.run(`UPDATE threads SET ${sets.join(',')} WHERE id=?`, vals)
      break
    }
    case 'thread.visited':
      db.run('UPDATE threads SET last_visited_at=? WHERE id=?', [e.ts, e.payload.threadId])
      break
    case 'thread.deleted':
      db.run('UPDATE threads SET deleted=1 WHERE id=?', [e.payload.threadId])
      break
    case 'thread.session': {
      const p = e.payload
      const sets: string[] = []
      const vals: unknown[] = []
      if (p.status !== undefined) {
        sets.push('status=?')
        vals.push(p.status)
      }
      if (p.sdkSessionId !== undefined) {
        sets.push('sdk_session_id=?')
        vals.push(p.sdkSessionId)
      }
      if (p.lastError !== undefined) {
        sets.push('last_error=?')
        vals.push(p.lastError)
      }
      sets.push('updated_at=?', 'latest_activity_at=?')
      vals.push(e.ts, e.ts, p.threadId)
      db.run(`UPDATE threads SET ${sets.join(',')} WHERE id=?`, vals)
      break
    }
    case 'turn.started':
      db.run('INSERT OR REPLACE INTO turns (id,thread_id,state,assistant_message_id,started_at,completed_at,cost_usd) VALUES (?,?,?,NULL,?,NULL,NULL)', [
        e.payload.turnId,
        e.payload.threadId,
        'running',
        e.ts
      ])
      db.run('UPDATE threads SET active_turn_id=?, latest_activity_at=? WHERE id=?', [e.payload.turnId, e.ts, e.payload.threadId])
      break
    case 'turn.completed':
      db.run('UPDATE turns SET state=?, assistant_message_id=?, completed_at=?, cost_usd=? WHERE id=?', [
        e.payload.state,
        e.payload.assistantMessageId,
        e.ts,
        e.payload.costUsd,
        e.payload.turnId
      ])
      db.run('UPDATE threads SET active_turn_id=NULL, latest_activity_at=? WHERE id=?', [e.ts, e.payload.threadId])
      break
    case 'message.created':
      db.run(
        'INSERT OR REPLACE INTO messages (id,thread_id,turn_id,role,text,streaming,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [e.payload.messageId, e.payload.threadId, e.payload.turnId, e.payload.role, e.payload.text, e.payload.streaming ? 1 : 0, e.ts, e.ts]
      )
      db.run('UPDATE threads SET latest_activity_at=? WHERE id=?', [e.ts, e.payload.threadId])
      break
    case 'message.delta':
      db.run('UPDATE messages SET text = text || ?, updated_at=? WHERE id=?', [e.payload.delta, e.ts, e.payload.messageId])
      break
    case 'message.completed':
      db.run('UPDATE messages SET text=?, streaming=0, updated_at=? WHERE id=?', [e.payload.text, e.ts, e.payload.messageId])
      break
    case 'work.upserted': {
      const w = e.payload
      db.run(
        `INSERT INTO work_items (id,thread_id,turn_id,tone,status,item_type,tool_name,title,detail,body,changed_files,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET tone=excluded.tone,status=excluded.status,item_type=excluded.item_type,
           tool_name=excluded.tool_name,title=excluded.title,
           -- mirror the renderer reducer: preserve prior detail/body/files when omitted
           detail=COALESCE(excluded.detail, detail),
           body=COALESCE(excluded.body, body),
           changed_files=CASE WHEN excluded.changed_files='[]' THEN changed_files ELSE excluded.changed_files END,
           updated_at=excluded.updated_at`,
        [w.workId, w.threadId, w.turnId, w.tone, w.status, w.itemType, w.toolName, w.title, w.detail, w.body, JSON.stringify(w.changedFiles), e.ts, e.ts]
      )
      db.run('UPDATE threads SET latest_activity_at=? WHERE id=?', [e.ts, w.threadId])
      break
    }
    case 'checkpoint.created':
      db.run('INSERT OR REPLACE INTO checkpoints (id,thread_id,turn_id,files_changed,additions,deletions,created_at) VALUES (?,?,?,?,?,?,?)', [
        e.payload.checkpointId,
        e.payload.threadId,
        e.payload.turnId,
        e.payload.filesChanged,
        e.payload.additions,
        e.payload.deletions,
        e.ts
      ])
      break
    case 'plan.proposed':
      db.run('INSERT OR REPLACE INTO plans (id,thread_id,turn_id,text,created_at) VALUES (?,?,?,?,?)', [
        e.payload.planId,
        e.payload.threadId,
        e.payload.turnId,
        e.payload.text,
        e.ts
      ])
      break
    case 'approval.requested':
      db.run('INSERT OR REPLACE INTO approvals (id,thread_id,turn_id,tool_name,kind,detail,input,created_at,resolved) VALUES (?,?,?,?,?,?,?,?,0)', [
        e.payload.requestId,
        e.payload.threadId,
        e.payload.turnId,
        e.payload.toolName,
        e.payload.kind,
        e.payload.detail,
        JSON.stringify(e.payload.input),
        e.ts
      ])
      db.run('UPDATE threads SET has_pending_approval=1 WHERE id=?', [e.payload.threadId])
      break
    case 'approval.resolved':
      db.run('UPDATE approvals SET resolved=1 WHERE id=?', [e.payload.requestId])
      db.run(
        'UPDATE threads SET has_pending_approval=(SELECT CASE WHEN EXISTS(SELECT 1 FROM approvals WHERE thread_id=? AND resolved=0) THEN 1 ELSE 0 END) WHERE id=?',
        [e.payload.threadId, e.payload.threadId]
      )
      break
  }
}

// ---------- read-model queries ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
const toProject = (r: any): Project => ({
  id: r.id,
  name: r.name,
  folderPath: r.folder_path,
  isGitRepo: !!r.is_git_repo,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastOpenedAt: r.last_opened_at
})

const toThread = (r: any): Thread => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  status: r.status,
  interactionMode: r.interaction_mode,
  runtimeMode: r.runtime_mode,
  model: r.model,
  reasoningEffort: r.reasoning_effort ?? null,
  sdkSessionId: r.sdk_session_id,
  activeTurnId: r.active_turn_id,
  lastError: r.last_error,
  hasPendingApproval: !!r.has_pending_approval,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastVisitedAt: r.last_visited_at,
  latestActivityAt: r.latest_activity_at
})

const toMessage = (r: any): Message => ({
  id: r.id,
  threadId: r.thread_id,
  turnId: r.turn_id,
  role: r.role,
  text: r.text ?? '',
  streaming: !!r.streaming,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const toTurn = (r: any): Turn => ({
  id: r.id,
  threadId: r.thread_id,
  state: r.state,
  assistantMessageId: r.assistant_message_id,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  costUsd: r.cost_usd
})

const toWork = (r: any): WorkItem => ({
  id: r.id,
  threadId: r.thread_id,
  turnId: r.turn_id,
  tone: r.tone,
  status: r.status,
  itemType: r.item_type,
  toolName: r.tool_name,
  title: r.title,
  detail: r.detail,
  body: r.body,
  changedFiles: JSON.parse(r.changed_files ?? '[]'),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const toCheckpoint = (r: any): Checkpoint => ({
  id: r.id,
  threadId: r.thread_id,
  turnId: r.turn_id,
  filesChanged: r.files_changed,
  additions: r.additions,
  deletions: r.deletions,
  createdAt: r.created_at
})

const toPlan = (r: any): ProposedPlan => ({
  id: r.id,
  threadId: r.thread_id,
  turnId: r.turn_id,
  text: r.text,
  createdAt: r.created_at
})

const toApproval = (r: any): PendingApproval => ({
  id: r.id,
  threadId: r.thread_id,
  turnId: r.turn_id,
  toolName: r.tool_name,
  kind: r.kind,
  detail: r.detail,
  input: JSON.parse(r.input ?? '{}'),
  createdAt: r.created_at
})
/* eslint-enable @typescript-eslint/no-explicit-any */

export function getShellSnapshot(db: Db): ShellSnapshot {
  const projects = db.all('SELECT * FROM projects WHERE removed=0 ORDER BY last_opened_at DESC').map(toProject)
  const threads: ThreadSummary[] = db
    .all('SELECT * FROM threads WHERE deleted=0 ORDER BY latest_activity_at DESC')
    .map(toThread)
    .map((t) => ({
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      status: t.status,
      interactionMode: t.interactionMode,
      hasPendingApproval: t.hasPendingApproval,
      latestActivityAt: t.latestActivityAt,
      updatedAt: t.updatedAt,
      lastVisitedAt: t.lastVisitedAt
    }))
  return { projects, threads }
}

export function getThreadDetail(db: Db, threadId: string): ThreadDetail | null {
  const row = db.get('SELECT * FROM threads WHERE id=? AND deleted=0', [threadId])
  if (!row) return null
  return {
    thread: toThread(row),
    messages: db.all('SELECT * FROM messages WHERE thread_id=? ORDER BY created_at, rowid', [threadId]).map(toMessage),
    turns: db.all('SELECT * FROM turns WHERE thread_id=? ORDER BY started_at', [threadId]).map(toTurn),
    workItems: db.all('SELECT * FROM work_items WHERE thread_id=? ORDER BY created_at, rowid', [threadId]).map(toWork),
    plans: db.all('SELECT * FROM plans WHERE thread_id=? ORDER BY created_at', [threadId]).map(toPlan),
    checkpoints: db.all('SELECT * FROM checkpoints WHERE thread_id=? ORDER BY created_at', [threadId]).map(toCheckpoint),
    pendingApprovals: db.all('SELECT * FROM approvals WHERE thread_id=? AND resolved=0 ORDER BY created_at', [threadId]).map(toApproval)
  }
}

export function getProject(db: Db, projectId: string): Project | null {
  const row = db.get('SELECT * FROM projects WHERE id=?', [projectId])
  return row ? toProject(row) : null
}

export function getThread(db: Db, threadId: string): Thread | null {
  const row = db.get('SELECT * FROM threads WHERE id=?', [threadId])
  return row ? toThread(row) : null
}

export function getThreadProjectPath(db: Db, threadId: string): { thread: Thread; project: Project } | null {
  const thread = getThread(db, threadId)
  if (!thread) return null
  const project = getProject(db, thread.projectId)
  if (!project) return null
  return { thread, project }
}
