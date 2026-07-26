import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DiffScope } from '@shared/diff'

/** Whether the active thread shows its conversation, its diff, or a single file. */
export type ThreadView = 'chat' | 'diff' | 'file'
export type DiffView = 'inline' | 'split'

/** Selectable color themes. Both are dark; they differ only in how black the background is. */
export type ThemeId = 'layered-black' | 'classic-dark'

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'layered-black', label: 'Classic black' },
  { id: 'classic-dark', label: 'Dark grey' }
]

export const DEFAULT_THEME: ThemeId = 'classic-dark'
export const DEFAULT_DIFF_VIEW: DiffView = 'inline'

export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 520
export const DEFAULT_SIDEBAR_WIDTH = 264

export const EXPLORER_MIN_WIDTH = 200
export const EXPLORER_MAX_WIDTH = 520
export const DEFAULT_EXPLORER_WIDTH = 258

/** a file reference the chat linked to (path relative to the project, optional line) */
export interface FileTarget {
  path: string
  line: number | null
}

interface UiState {
  activeThreadId: string | null
  sidebarCollapsed: boolean
  sidebarWidth: number
  /** true mid-drag; suppresses the width transitions so the panel tracks the cursor */
  sidebarResizing: boolean
  expandedProjects: Record<string, boolean>
  /** the file-explorer dock on the right edge */
  explorerOpen: boolean
  explorerWidth: number
  /** true mid-drag; suppresses the width transitions so the dock tracks the cursor */
  explorerResizing: boolean
  /** which explorer folders are open, per project: projectId → { relPath: true } */
  expandedDirs: Record<string, Record<string, boolean>>
  threadView: ThreadView
  /** which file the diff view is focused on; null = all files */
  diffSelectedFile: string | null
  diffScope: DiffScope
  diffView: DiffView
  /** which file the file view shows; only meaningful while threadView === 'file' */
  fileTarget: FileTarget | null
  commandPaletteOpen: boolean
  settingsOpen: boolean
  theme: ThemeId

  /** open a thread in the main view (single active thread) */
  openTab: (threadId: string) => void
  setActive: (threadId: string | null) => void
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  /** clamped to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] */
  setSidebarWidth: (width: number) => void
  setSidebarResizing: (resizing: boolean) => void
  toggleProject: (projectId: string) => void
  setProjectExpanded: (projectId: string, expanded: boolean) => void
  toggleExplorer: () => void
  setExplorerOpen: (open: boolean) => void
  /** clamped to [EXPLORER_MIN_WIDTH, EXPLORER_MAX_WIDTH] */
  setExplorerWidth: (width: number) => void
  setExplorerResizing: (resizing: boolean) => void
  toggleDir: (projectId: string, path: string) => void
  setThreadView: (view: ThreadView) => void
  /** open the diff view for a thread at a given scope, focused on all files */
  openDiff: (threadId: string, scope?: DiffScope) => void
  /** open a project file in the main view (chat file references) */
  openFile: (threadId: string, target: FileTarget) => void
  setDiffSelectedFile: (path: string | null) => void
  setDiffScope: (scope: DiffScope) => void
  setDiffView: (view: DiffView) => void
  setCommandPaletteOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setTheme: (theme: ThemeId) => void
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      activeThreadId: null,
      sidebarCollapsed: false,
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarResizing: false,
      expandedProjects: {},
      explorerOpen: true,
      explorerWidth: DEFAULT_EXPLORER_WIDTH,
      explorerResizing: false,
      expandedDirs: {},
      threadView: 'chat',
      diffSelectedFile: null,
      diffScope: { kind: 'working' },
      diffView: DEFAULT_DIFF_VIEW,
      fileTarget: null,
      commandPaletteOpen: false,
      settingsOpen: false,
      theme: DEFAULT_THEME,

      openTab: (threadId) => set({ activeThreadId: threadId, threadView: 'chat' }),

      setActive: (threadId) => set({ activeThreadId: threadId }),

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSidebarWidth: (width) =>
        set({ sidebarWidth: Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width))) }),
      setSidebarResizing: (resizing) => set({ sidebarResizing: resizing }),

      toggleProject: (projectId) => set((s) => ({ expandedProjects: { ...s.expandedProjects, [projectId]: !(s.expandedProjects[projectId] ?? true) } })),
      setProjectExpanded: (projectId, expanded) => set((s) => ({ expandedProjects: { ...s.expandedProjects, [projectId]: expanded } })),

      toggleExplorer: () => set((s) => ({ explorerOpen: !s.explorerOpen })),
      setExplorerOpen: (open) => set({ explorerOpen: open }),
      setExplorerWidth: (width) =>
        set({ explorerWidth: Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, Math.round(width))) }),
      setExplorerResizing: (resizing) => set({ explorerResizing: resizing }),
      toggleDir: (projectId, path) =>
        set((s) => {
          const dirs = s.expandedDirs[projectId] ?? {}
          const next = { ...dirs }
          if (next[path]) delete next[path]
          else next[path] = true
          return { expandedDirs: { ...s.expandedDirs, [projectId]: next } }
        }),

      setThreadView: (view) => set({ threadView: view }),
      openDiff: (threadId, scope) =>
        set({ activeThreadId: threadId, threadView: 'diff', diffSelectedFile: null, ...(scope ? { diffScope: scope } : {}) }),
      openFile: (threadId, target) => set({ activeThreadId: threadId, threadView: 'file', fileTarget: target }),
      setDiffSelectedFile: (path) => set({ diffSelectedFile: path }),
      setDiffScope: (scope) => set({ diffScope: scope, diffSelectedFile: null }),
      setDiffView: (view) => set({ diffView: view }),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setTheme: (theme) => set({ theme })
    }),
    {
      name: 'thread:ui',
      partialize: (s) => ({
        activeThreadId: s.activeThreadId,
        sidebarCollapsed: s.sidebarCollapsed,
        sidebarWidth: s.sidebarWidth,
        expandedProjects: s.expandedProjects,
        explorerOpen: s.explorerOpen,
        explorerWidth: s.explorerWidth,
        expandedDirs: s.expandedDirs,
        diffScope: s.diffScope,
        diffView: s.diffView,
        theme: s.theme
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
