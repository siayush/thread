import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DiffScope } from '@shared/diff'

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

interface UiState {
  activeThreadId: string | null
  sidebarCollapsed: boolean
  sidebarWidth: number
  /** true mid-drag; suppresses the width transitions so the panel tracks the cursor */
  sidebarResizing: boolean
  expandedProjects: Record<string, boolean>
  /** which explorer folders are open, per project: projectId → { relPath: true } */
  expandedDirs: Record<string, Record<string, boolean>>
  /** which file the diff surface is focused on; null = all files */
  diffSelectedFile: string | null
  diffScope: DiffScope
  diffView: DiffView
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
  toggleDir: (projectId: string, path: string) => void
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
      expandedDirs: {},
      diffSelectedFile: null,
      diffScope: { kind: 'working' },
      diffView: DEFAULT_DIFF_VIEW,
      commandPaletteOpen: false,
      settingsOpen: false,
      theme: DEFAULT_THEME,

      openTab: (threadId) => set({ activeThreadId: threadId }),

      setActive: (threadId) => set({ activeThreadId: threadId }),

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setSidebarWidth: (width) =>
        set({ sidebarWidth: Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width))) }),
      setSidebarResizing: (resizing) => set({ sidebarResizing: resizing }),

      toggleProject: (projectId) => set((s) => ({ expandedProjects: { ...s.expandedProjects, [projectId]: !(s.expandedProjects[projectId] ?? true) } })),
      setProjectExpanded: (projectId, expanded) => set((s) => ({ expandedProjects: { ...s.expandedProjects, [projectId]: expanded } })),

      toggleDir: (projectId, path) =>
        set((s) => {
          const dirs = s.expandedDirs[projectId] ?? {}
          const next = { ...dirs }
          if (next[path]) delete next[path]
          else next[path] = true
          return { expandedDirs: { ...s.expandedDirs, [projectId]: next } }
        }),

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
