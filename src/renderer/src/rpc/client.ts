import type { ClientFrame, ServerFrame, StreamMessage } from '@shared/rpc'

type RequestMethod = Extract<ClientFrame, { kind: 'request' }>['method']
type SubMethod = Extract<ClientFrame, { kind: 'subscribe' }>['method']

interface Pending {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

interface Sub {
  makeFrame: () => ClientFrame
  onMessage: (m: StreamMessage) => void
}

/**
 * WebSocket RPC client — the renderer↔server transport.
 * Auto-reconnects and re-establishes active subscriptions on reconnect.
 * Requests fail fast while disconnected instead of hanging forever.
 */
export class RpcClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private subs = new Map<number, Sub>()
  private url = ''
  private connectListeners = new Set<(connected: boolean) => void>()
  private connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  async connect(): Promise<void> {
    const info = await window.native.getServerInfo()
    this.url = `ws://${info.host}:${info.port}`
    this.open()
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectListeners.add(cb)
    cb(this.connected)
    return () => this.connectListeners.delete(cb)
  }

  private setConnected(v: boolean): void {
    this.connected = v
    for (const cb of this.connectListeners) cb(v)
  }

  private open(): void {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.setConnected(true)
      for (const sub of this.subs.values()) this.send(sub.makeFrame())
    }
    ws.onclose = () => {
      this.setConnected(false)
      this.rejectAllPending(new Error('Connection to local server lost'))
      this.scheduleReconnect()
    }
    ws.onerror = () => ws.close()
    ws.onmessage = (ev) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(ev.data as string) as ServerFrame
      } catch {
        return
      }
      this.onFrame(frame)
    }
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, 600)
  }

  private send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }

  private onFrame(frame: ServerFrame): void {
    if (frame.kind === 'response') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      if (frame.ok) p.resolve(frame.data)
      else p.reject(new Error(frame.error))
    } else if (frame.kind === 'stream') {
      this.subs.get(frame.id)?.onMessage(frame.message)
    }
  }

  request<T>(method: RequestMethod, params: unknown): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('Not connected to local server'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject })
      this.send({ kind: 'request', id, method, params } as ClientFrame)
    })
  }

  /**
   * `params` may be a function; it is re-evaluated on every (re)connect, so a
   * subscription can resume with fresh state (e.g. `afterSeq`).
   */
  subscribe(method: SubMethod, params: unknown | (() => unknown), onMessage: (m: StreamMessage) => void): () => void {
    const id = this.nextId++
    const makeFrame = (): ClientFrame =>
      ({ kind: 'subscribe', id, method, params: typeof params === 'function' ? (params as () => unknown)() : params }) as ClientFrame
    this.subs.set(id, { makeFrame, onMessage })
    this.send(makeFrame())
    return () => {
      this.subs.delete(id)
      this.send({ kind: 'unsubscribe', id })
    }
  }
}

export const rpc = new RpcClient()
