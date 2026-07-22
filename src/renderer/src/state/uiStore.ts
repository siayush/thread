import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DiffScope } from '@shared/diff'

/** Whether the active thread shows its conversation or its diff. */
export type ThreadView = 'chat' | 'diff'
export type DiffView = 'inline' | 'split'

interface UiState {
  activeThreadId: string | null
  expandedProjects: Record<string, boolean>
  threadView: ThreadView
  /** which file the diff view is focused on; null = all files */
  diffSelectedFile: string | null
  diffScope: DiffScope
  diffView: DiffView
  commandPaletteOpen: boolean

  /** open a thread in the main view (single active thread) */
  openTab: (threadId: string) => void
  setActive: (threadId: string | null) => void
  toggleProject: (projectId: string) => void
  setProjectExpanded: (projectId: string, expanded: boolean) => void
  setThreadView: (view: ThreadView) => void
  /** open the diff view for a thread at a given scope, focused on all files */
  openDiff: (threadId: string, scope?: DiffScope) => void
  setDiffSelectedFile: (path: string | null) => void
  setDiffScope: (scope: DiffScope) => void
  setDiffView: (view: DiffView) => void
  setCommandPaletteOpen: (open: boolean) => void
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      activeThreadId: null,
      expandedProjects: {},
      threadView: 'chat',
      diffSelectedFile: null,
      diffScope: { kind: 'working' },
      diffView: 'inline',
      commandPaletteOpen: false,

      openTab: (threadId) => set({ activeThreadId: threadId, threadView: 'chat' }),

      setActive: (threadId) => set({ activeThreadId: threadId }),

      toggleProject: (projectId) => set((s) => ({ expandedProjects: { ...s.expandedProjects, [projectId]: !(s.expandedProjects[projectId] ?? true) } })),
      setProjectExpanded: (projectId, expanded) => set((s) => ({ expandedProjects: { ...s.expandedProjects, [projectId]: expanded } })),

      setThreadView: (view) => set({ threadView: view }),
      openDiff: (threadId, scope) =>
        set({ activeThreadId: threadId, threadView: 'diff', diffSelectedFile: null, ...(scope ? { diffScope: scope } : {}) }),
      setDiffSelectedFile: (path) => set({ diffSelectedFile: path }),
      setDiffScope: (scope) => set({ diffScope: scope, diffSelectedFile: null }),
      setDiffView: (view) => set({ diffView: view }),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open })
    }),
    {
      name: 'thread:ui',
      partialize: (s) => ({
        activeThreadId: s.activeThreadId,
        expandedProjects: s.expandedProjects,
        diffScope: s.diffScope,
        diffView: s.diffView
      })
    }
  )
)

/** projects default to expanded unless explicitly collapsed */
export function isProjectExpanded(map: Record<string, boolean>, projectId: string): boolean {
  return map[projectId] ?? true
}

/** per-thread composer drafts (not persisted across restarts) */
export const useComposerDraft = create<{
  drafts: Record<string, string>
  set: (threadId: string, text: string) => void
}>((set) => ({
  drafts: {},
  set: (threadId, text) => set((s) => ({ drafts: { ...s.drafts, [threadId]: text } }))
}))
