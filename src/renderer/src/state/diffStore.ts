import { create } from 'zustand'
import type { DiffResult, DiffScope, DiffSummary } from '@shared/diff'
import { useServer } from './serverStore'

function scopeKey(scope: DiffScope): string {
  return scope.kind === 'turn' ? `turn:${scope.turnId}` : 'working'
}

interface DiffDataState {
  threadId: string | null
  key: string
  result: DiffResult | null
  loading: boolean
  /** fetch the diff for a thread+scope; both the sidebar file list and the diff pane read the result */
  load: (threadId: string, scope: DiffScope) => Promise<void>
  /** re-fetch the last-loaded thread+scope (after a stage/unstage/discard) */
  reload: () => void
  /** synchronously retarget the store: clears a stale result the moment the
   *  thread/scope changes, so a debounced load doesn't flash the old diff */
  setTarget: (threadId: string, scope: DiffScope) => void
}

export const useDiffData = create<DiffDataState>((set, get) => ({
  threadId: null,
  key: '',
  result: null,
  loading: false,

  load: async (threadId, scope) => {
    const key = `${threadId}|${scopeKey(scope)}`
    // switching target clears the stale result so the pane shows a loading state, not the wrong diff
    set((s) => ({ threadId, key, loading: true, result: s.key === key ? s.result : null }))
    try {
      const result = await useServer.getState().getDiff(threadId, scope)
      if (get().key === key) set({ result, loading: false })
    } catch (err) {
      if (get().key === key) {
        set({
          result: { scope, isGitRepo: false, files: [], additions: 0, deletions: 0, error: err instanceof Error ? err.message : String(err) },
          loading: false
        })
      }
    }
  },

  reload: () => {
    const { threadId, key } = get()
    if (!threadId) return
    const scope: DiffScope = key.endsWith('|working') ? { kind: 'working' } : { kind: 'turn', turnId: key.split('|turn:')[1] }
    void get().load(threadId, scope)
  },

  setTarget: (threadId, scope) => {
    const key = `${threadId}|${scopeKey(scope)}`
    set((s) => (s.key === key ? { threadId, key } : { threadId, key, loading: true, result: null }))
  }
}))

interface DiffSummaryState {
  /** keyed by projectId — threads in one project share a working tree */
  byProject: Record<string, DiffSummary>
  inflight: Record<string, boolean>
  /** fetch (once, or when forced) the working-tree summary for a thread's project */
  fetch: (threadId: string, projectId: string, force?: boolean) => void
}

export const useDiffSummary = create<DiffSummaryState>((set, get) => ({
  byProject: {},
  inflight: {},

  fetch: (threadId, projectId, force) => {
    if (get().inflight[projectId]) return
    if (!force && get().byProject[projectId]) return
    set((s) => ({ inflight: { ...s.inflight, [projectId]: true } }))
    void useServer
      .getState()
      .getDiffSummary(threadId)
      .then((summary) => set((s) => ({ byProject: { ...s.byProject, [projectId]: summary } })))
      .catch(() => {})
      .finally(() => set((s) => ({ inflight: { ...s.inflight, [projectId]: false } })))
  }
}))
