import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DiffScope } from '@shared/diff'
import { useUi } from './uiStore'

/**
 * The right panel is a tabbed workspace beside the chat: an ordered list of
 * surfaces (tabs) plus one active id, scoped per thread. `diff` and `files`
 * are singletons — their id is the kind, so
 * opening one twice is idempotent — while each open file gets its own
 * `file:<path>` surface, so re-opening a path re-activates the existing tab
 * instead of duplicating it.
 */
export type RightPanelKind = 'diff' | 'files' | 'file'

export type RightPanelSurface =
  | { id: 'diff'; kind: 'diff' }
  | { id: 'files'; kind: 'files' }
  | {
      id: `file:${string}`
      kind: 'file'
      path: string
      line: number | null
      /** bumped on every re-open so "scroll to line" fires again for an identical target */
      revealRequestId: number
    }

export interface ThreadRightPanelState {
  isOpen: boolean
  activeSurfaceId: string | null
  surfaces: RightPanelSurface[]
}

export const EMPTY_PANEL: ThreadRightPanelState = { isOpen: false, activeSurfaceId: null, surfaces: [] }

export const RIGHT_PANEL_MIN_WIDTH = 360
export const DEFAULT_RIGHT_PANEL_WIDTH = 540

/** the panel may take at most 70% of the window */
export function rightPanelMaxWidth(): number {
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.floor(window.innerWidth * 0.7))
}

const fileId = (path: string): `file:${string}` => `file:${path}`

function singleton(kind: 'diff' | 'files'): RightPanelSurface {
  return kind === 'diff' ? { id: 'diff', kind: 'diff' } : { id: 'files', kind: 'files' }
}

function upsert(current: ThreadRightPanelState, surface: RightPanelSurface, activate = true): ThreadRightPanelState {
  return {
    isOpen: true,
    surfaces: current.surfaces.some((s) => s.id === surface.id) ? current.surfaces : [...current.surfaces, surface],
    activeSurfaceId: activate ? surface.id : current.activeSurfaceId
  }
}

function update(
  byThread: Record<string, ThreadRightPanelState>,
  threadId: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState
): Record<string, ThreadRightPanelState> {
  const current = byThread[threadId] ?? EMPTY_PANEL
  const next = updater(current)
  if (next === current) return byThread
  // garbage-collect fully-empty threads so the persisted blob doesn't grow forever
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(threadId in byThread)) return byThread
    const { [threadId]: _dropped, ...rest } = byThread
    return rest
  }
  return { ...byThread, [threadId]: next }
}

interface RightPanelState {
  byThread: Record<string, ThreadRightPanelState>
  width: number
  /** true mid-drag; suppresses the width transitions so the panel tracks the cursor */
  resizing: boolean
  /** which thread's panel is maximized (fills everything right of the sidebar) */
  maximizedThreadId: string | null

  open: (threadId: string, kind: 'diff' | 'files') => void
  /** open (or re-activate) a `file:` surface; re-opening bumps revealRequestId */
  openFile: (threadId: string, path: string, line: number | null) => void
  /** shortcut semantics: toggling the surface that is already active hides the panel */
  toggle: (threadId: string, kind: 'diff' | 'files') => void
  /** show the panel on whatever was last active (possibly the empty state) / hide it */
  setOpen: (threadId: string, open: boolean) => void
  setActive: (threadId: string, surfaceId: string) => void
  /** close a tab; the neighbour at the same index (clamped) becomes active */
  close: (threadId: string, surfaceId: string) => void
  closeOthers: (threadId: string, surfaceId: string) => void
  closeAll: (threadId: string) => void
  /** clamped to [RIGHT_PANEL_MIN_WIDTH, rightPanelMaxWidth()] */
  setWidth: (width: number) => void
  setResizing: (resizing: boolean) => void
  setMaximized: (threadId: string, maximized: boolean) => void
}

export const useRightPanel = create<RightPanelState>()(
  persist(
    (set) => ({
      byThread: {},
      width: DEFAULT_RIGHT_PANEL_WIDTH,
      resizing: false,
      maximizedThreadId: null,

      open: (threadId, kind) =>
        set((s) => ({ byThread: update(s.byThread, threadId, (cur) => upsert(cur, singleton(kind))) })),

      openFile: (threadId, path, line) =>
        set((s) => ({
          byThread: update(s.byThread, threadId, (cur) => {
            const id = fileId(path)
            const existing = cur.surfaces.some((sf) => sf.id === id)
            const surfaces = existing
              ? cur.surfaces.map((sf) =>
                  sf.id === id && sf.kind === 'file' ? { ...sf, line, revealRequestId: sf.revealRequestId + 1 } : sf
                )
              : [...cur.surfaces, { id, kind: 'file' as const, path, line, revealRequestId: 0 }]
            return { isOpen: true, surfaces, activeSurfaceId: id }
          })
        })),

      toggle: (threadId, kind) =>
        set((s) => ({
          byThread: update(s.byThread, threadId, (cur) => {
            const active = cur.surfaces.find((sf) => sf.id === cur.activeSurfaceId)
            if (cur.isOpen && active?.kind === kind) return { ...cur, isOpen: false }
            return upsert(cur, singleton(kind))
          })
        })),

      setOpen: (threadId, open) =>
        set((s) => ({
          byThread: update(s.byThread, threadId, (cur) => (cur.isOpen === open ? cur : { ...cur, isOpen: open }))
        })),

      setActive: (threadId, surfaceId) =>
        set((s) => ({
          byThread: update(s.byThread, threadId, (cur) =>
            cur.surfaces.some((sf) => sf.id === surfaceId) ? { ...cur, isOpen: true, activeSurfaceId: surfaceId } : cur
          )
        })),

      close: (threadId, surfaceId) =>
        set((s) => ({
          byThread: update(s.byThread, threadId, (cur) => {
            const index = cur.surfaces.findIndex((sf) => sf.id === surfaceId)
            if (index === -1) return cur
            const surfaces = cur.surfaces.filter((sf) => sf.id !== surfaceId)
            const activeSurfaceId =
              cur.activeSurfaceId === surfaceId
                ? (surfaces[Math.min(index, surfaces.length - 1)]?.id ?? null)
                : cur.activeSurfaceId
            return { isOpen: cur.isOpen && surfaces.length > 0, activeSurfaceId, surfaces }
          })
        })),

      closeOthers: (threadId, surfaceId) =>
        set((s) => ({
          byThread: update(s.byThread, threadId, (cur) => {
            const kept = cur.surfaces.filter((sf) => sf.id === surfaceId)
            if (kept.length === 0 || kept.length === cur.surfaces.length) return cur
            return { ...cur, surfaces: kept, activeSurfaceId: surfaceId }
          })
        })),

      closeAll: (threadId) =>
        set((s) => ({
          byThread: update(s.byThread, threadId, (cur) =>
            cur.surfaces.length === 0 ? cur : { isOpen: false, activeSurfaceId: null, surfaces: [] }
          )
        })),

      setWidth: (width) =>
        set({ width: Math.min(rightPanelMaxWidth(), Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width))) }),
      setResizing: (resizing) => set({ resizing }),
      setMaximized: (threadId, maximized) =>
        set((s) => (maximized ? { maximizedThreadId: threadId } : s.maximizedThreadId === threadId ? { maximizedThreadId: null } : {}))
    }),
    {
      name: 'thread:right-panel',
      version: 1,
      partialize: (s) => ({ byThread: s.byThread, width: s.width })
    }
  )
)

/** the surface a thread's panel is showing, or null while closed/empty */
export function activeSurface(byThread: Record<string, ThreadRightPanelState>, threadId: string | null): RightPanelSurface | null {
  if (!threadId) return null
  const panel = byThread[threadId]
  if (!panel) return null
  return panel.surfaces.find((sf) => sf.id === panel.activeSurfaceId) ?? null
}

/** open the diff surface for a thread, optionally retargeting the diff scope */
export function openThreadDiff(threadId: string, scope?: DiffScope): void {
  const ui = useUi.getState()
  if (ui.activeThreadId !== threadId) ui.setActive(threadId)
  if (scope) ui.setDiffScope(scope)
  else ui.setDiffSelectedFile(null)
  useRightPanel.getState().open(threadId, 'diff')
}
