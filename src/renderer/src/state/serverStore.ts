import { create } from 'zustand'
import type { Command, CommandResult } from '@shared/commands'
import type { ModelOption, ShellSnapshot, ThreadDetail } from '@shared/domain'
import type { DiffAction, DiffResult, DiffScope, DiffSummary } from '@shared/diff'
import { rpc } from '../rpc/client'
import { reduceThread } from './threadReducer'
import { useUi } from './uiStore'

interface ServerState {
  ready: boolean
  shell: ShellSnapshot
  details: Record<string, ThreadDetail>
  models: ModelOption[]

  init: () => void
  openThread: (threadId: string) => void
  closeThread: (threadId: string) => void
  dispatch: (cmd: Command) => Promise<CommandResult>
  getDiff: (threadId: string, scope: DiffScope) => Promise<DiffResult>
  getDiffSummary: (threadId: string) => Promise<DiffSummary>
  fileAction: (threadId: string, action: DiffAction, paths: string[]) => Promise<{ ok: boolean; error?: string }>
}

const emptyShell: ShellSnapshot = { projects: [], threads: [] }
const threadUnsubs = new Map<string, () => void>()

export const useServer = create<ServerState>((set, get) => ({
  ready: false,
  shell: emptyShell,
  details: {},
  models: [],

  init: () => {
    rpc.subscribe('subscribeShell', {}, (msg) => {
      if (msg.type === 'shell-snapshot') set({ shell: msg.snapshot, ready: true })
    })
    rpc
      .request<{ models: ModelOption[] }>('listModels', {})
      .then((res) => set({ models: res.models }))
      .catch(() => {
        /* models are optional */
      })
  },

  openThread: (threadId) => {
    if (threadUnsubs.has(threadId)) return
    const unsub = rpc.subscribe('subscribeThread', { threadId }, (msg) => {
      if (msg.type === 'thread-snapshot') {
        set((s) => ({ details: { ...s.details, [threadId]: msg.detail } }))
      } else if (msg.type === 'thread-not-found') {
        get().closeThread(threadId)
        const ui = useUi.getState()
        if (ui.activeThreadId === threadId) ui.setActive(null)
      } else if (msg.type === 'events') {
        set((s) => {
          const detail = s.details[threadId]
          if (!detail) return s
          let next = detail
          for (const e of msg.events) next = reduceThread(next, e)
          return { details: { ...s.details, [threadId]: next } }
        })
      }
    })
    threadUnsubs.set(threadId, unsub)
  },

  closeThread: (threadId) => {
    threadUnsubs.get(threadId)?.()
    threadUnsubs.delete(threadId)
    set((s) => {
      const details = { ...s.details }
      delete details[threadId]
      return { details }
    })
  },

  dispatch: async (cmd) => {
    try {
      return await rpc.request<CommandResult>('dispatchCommand', cmd)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
  getDiff: (threadId, scope) => rpc.request<DiffResult>('getDiff', { threadId, scope }),
  getDiffSummary: (threadId) => rpc.request<DiffSummary>('getDiffSummary', { threadId }),
  fileAction: (threadId, action, paths) => rpc.request<{ ok: boolean; error?: string }>('fileAction', { threadId, action, paths })
}))
