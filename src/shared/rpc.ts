/**
 * The WebSocket RPC wire protocol between renderer and the local server.
 * Two interaction shapes:
 *  - request/response  (dispatchCommand, getDiff, listModels)
 *  - subscription       (subscribeShell, subscribeThread) — server pushes a
 *    snapshot then a live stream of events, resumable via `afterSeq`.
 */
import type { Command, CommandResult } from './commands'
import type { OrchestrationEvent } from './events'
import type { ShellSnapshot, ThreadDetail, ModelOption } from './domain'
import type { DiffScope, DiffResult, DiffSummary, DiffAction } from './diff'

// ---- client → server frames ----
export type ClientFrame =
  | { kind: 'request'; id: number; method: 'dispatchCommand'; params: Command }
  | { kind: 'request'; id: number; method: 'getDiff'; params: { threadId: string; scope: DiffScope } }
  | { kind: 'request'; id: number; method: 'getDiffSummary'; params: { threadId: string } }
  | { kind: 'request'; id: number; method: 'fileAction'; params: { threadId: string; action: DiffAction; path: string } }
  | { kind: 'request'; id: number; method: 'listModels'; params: Record<string, never> }
  | { kind: 'subscribe'; id: number; method: 'subscribeShell'; params: Record<string, never> }
  | { kind: 'subscribe'; id: number; method: 'subscribeThread'; params: { threadId: string; afterSeq?: number } }
  | { kind: 'unsubscribe'; id: number }

// ---- server → client frames ----
export type ServerFrame =
  | { kind: 'response'; id: number; ok: true; data: ResponseData }
  | { kind: 'response'; id: number; ok: false; error: string }
  | { kind: 'stream'; id: number; message: StreamMessage }

export type ResponseData = CommandResult | DiffResult | DiffSummary | { ok: boolean; error?: string } | { models: ModelOption[] }

/** messages pushed on a subscription channel */
export type StreamMessage =
  | { type: 'shell-snapshot'; snapshot: ShellSnapshot; seq: number }
  | { type: 'thread-snapshot'; detail: ThreadDetail; seq: number }
  | { type: 'thread-not-found'; threadId: string }
  | { type: 'events'; events: OrchestrationEvent[] }

export const DEFAULT_SERVER_HOST = '127.0.0.1'
