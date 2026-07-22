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
  | { method: 'fileAction'; params: { threadId: string; action: DiffAction; path: string } }
  | { method: 'listModels'; params: Record<string, never> }

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
