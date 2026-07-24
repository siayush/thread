/**
 * The renderer↔main RPC surface, carried over Electron IPC.
 * Two interaction shapes:
 *  - request/response  (dispatchCommand, getDiff, listModels, …) via `invoke`
 *  - subscription       (subscribeShell, subscribeThread) — main pushes a
 *    snapshot then a live stream of events on the `stream` channel.
 */
import type { Command } from './commands'
import type { OrchestrationEvent } from './events'
import type { ShellSnapshot, ThreadDetail } from './domain'
import type { DiffAction, DiffScope } from './diff'

export const RpcChannels = {
  request: 'rpc:request',
  subscribe: 'rpc:subscribe',
  unsubscribe: 'rpc:unsubscribe',
  stream: 'rpc:stream'
} as const

export type RpcRequest =
  | { method: 'dispatchCommand'; params: Command }
  | { method: 'getDiff'; params: { threadId: string; scope: DiffScope } }
  | { method: 'getDiffSummary'; params: { threadId: string } }
  | { method: 'fileAction'; params: { threadId: string; action: DiffAction; paths: string[] } }
  | { method: 'readProjectFile'; params: { threadId: string; path: string } }
  | { method: 'listModels'; params: Record<string, never> }

/** result of `readProjectFile`: a project file's text for the in-app viewer */
export interface ReadFileResult {
  ok: boolean
  /** project-relative path actually read (echoes the request path on failure) */
  path: string
  content?: string
  error?: string
}

export type RpcRequestMethod = RpcRequest['method']
export type RpcSubscribeMethod = 'subscribeShell' | 'subscribeThread'

/** one subscription registration, sent renderer → main */
export interface SubscribeFrame {
  id: number
  method: RpcSubscribeMethod
  params: { threadId?: string }
}

/** messages pushed on a subscription channel */
export type StreamMessage =
  | { type: 'shell-snapshot'; snapshot: ShellSnapshot }
  | { type: 'thread-snapshot'; detail: ThreadDetail }
  | { type: 'thread-not-found'; threadId: string }
  | { type: 'events'; events: OrchestrationEvent[] }

/** one pushed subscription message, sent main → renderer */
export interface StreamFrame {
  id: number
  message: StreamMessage
}
