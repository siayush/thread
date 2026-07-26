import { create } from 'zustand'
import type { DirEntry } from '@shared/files'
import { useServer } from './serverStore'
import { useUi } from './uiStore'

/** Everything the explorer knows about one project's tree. */
interface ProjectTree {
  /** directory path (`''` = project root) → its entries */
  entries: Record<string, DirEntry[]>
  loading: Record<string, boolean>
  errors: Record<string, string>
}

const EMPTY_TREE: ProjectTree = { entries: {}, loading: {}, errors: {} }

interface ExplorerState {
  byProject: Record<string, ProjectTree>
  /** read one directory; a no-op if it is already loaded or in flight, unless forced */
  loadDir: (projectId: string, path: string, force?: boolean) => void
  /** re-read the directories currently on screen (debounced per project) */
  refresh: (projectId: string) => void
}

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map }
  delete next[key]
  return next
}

/**
 * A turn ticks thread activity on every tool call, and each refresh costs a
 * readdir per open folder — debounce so a busy turn re-reads about once a
 * second, not once per event.
 */
const REFRESH_DEBOUNCE_MS = 1200
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const useExplorer = create<ExplorerState>((set, get) => {
  const patch = (projectId: string, fn: (tree: ProjectTree) => ProjectTree): void =>
    set((s) => ({ byProject: { ...s.byProject, [projectId]: fn(s.byProject[projectId] ?? EMPTY_TREE) } }))

  return {
    byProject: {},

    loadDir: (projectId, path, force) => {
      const tree = get().byProject[projectId]
      if (!force && (tree?.entries[path] || tree?.loading[path])) return
      patch(projectId, (t) => ({ ...t, loading: { ...t.loading, [path]: true } }))
      void useServer
        .getState()
        .listDir(projectId, path)
        .then((res) => {
          patch(projectId, (t) => ({
            ...t,
            // on failure keep the last listing (the tree doesn't empty out) and write none
            // when there wasn't one — an unlisted folder must stay unlisted so reopening retries
            entries: res.ok ? { ...t.entries, [path]: res.entries } : t.entries,
            errors: res.ok ? omit(t.errors, path) : { ...t.errors, [path]: res.error ?? 'Failed to read folder' },
            loading: omit(t.loading, path)
          }))
        })
        .catch((err: unknown) => {
          patch(projectId, (t) => ({
            ...t,
            errors: { ...t.errors, [path]: err instanceof Error ? err.message : String(err) },
            loading: omit(t.loading, path)
          }))
        })
    },

    refresh: (projectId) => {
      if (refreshTimers.has(projectId)) return // a refresh is already queued
      refreshTimers.set(
        projectId,
        setTimeout(() => {
          refreshTimers.delete(projectId)
          // only what is on screen: `entries` also caches every folder the user has
          // since collapsed, and each re-read costs a git call and a readdir per child
          const expanded = useUi.getState().expandedDirs[projectId] ?? {}
          const onScreen = (path: string): boolean => {
            if (path === '') return true // the root level is always mounted
            if (!expanded[path]) return false
            const slash = path.lastIndexOf('/')
            return slash === -1 || onScreen(path.slice(0, slash))
          }
          for (const path of Object.keys(get().byProject[projectId]?.entries ?? {})) {
            if (onScreen(path)) get().loadDir(projectId, path, true)
          }
        }, REFRESH_DEBOUNCE_MS)
      )
    }
  }
})
