import type { RpcRequestMethod, RpcSubscribeMethod, StreamMessage } from '@shared/rpc'

/**
 * Thin renderer side of the IPC RPC. Requests go over `invoke`; subscriptions
 * register a callback keyed by a renderer-assigned id and receive pushed
 * `StreamMessage`s until unsubscribed.
 */
let nextId = 1
const subs = new Map<number, (m: StreamMessage) => void>()
let streaming = false

function ensureStreamListener(): void {
  if (streaming) return
  streaming = true
  window.native.rpc.onStream(({ id, message }) => subs.get(id)?.(message))
}

export const rpc = {
  request<T>(method: RpcRequestMethod, params: unknown): Promise<T> {
    return window.native.rpc.request(method, params) as Promise<T>
  },

  subscribe(method: RpcSubscribeMethod, params: unknown, onMessage: (m: StreamMessage) => void): () => void {
    ensureStreamListener()
    const id = nextId++
    subs.set(id, onMessage)
    window.native.rpc.subscribe(id, method, params)
    return () => {
      subs.delete(id)
      window.native.rpc.unsubscribe(id)
    }
  }
}
