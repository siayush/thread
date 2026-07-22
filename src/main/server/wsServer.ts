import { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientFrame, ServerFrame } from '@shared/rpc'
import type { Engine } from './engine'
import { mergeCodexAgentModels } from './models'
import { getCodexAgentModels } from './provider/codexModelList'

export interface RunningServer {
  host: string
  port: number
  close: () => void
}

/** Starts the local WS RPC server the renderer connects to. */
export function startWsServer(engine: Engine, host: string): Promise<RunningServer> {
  const wss = new WebSocketServer({ host, port: 0 })

  wss.on('connection', (ws: WebSocket) => {
    const unsubs = new Map<number, () => void>()
    const send = (frame: ServerFrame): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }

    const handleFrame = async (frame: ClientFrame): Promise<void> => {
      if (frame.kind === 'request') {
        try {
          if (frame.method === 'dispatchCommand') {
            const result = engine.dispatch(frame.params)
            if (result.ok) send({ kind: 'response', id: frame.id, ok: true, data: result })
            else send({ kind: 'response', id: frame.id, ok: false, error: result.error ?? 'Command failed' })
          } else if (frame.method === 'getDiff') {
            send({ kind: 'response', id: frame.id, ok: true, data: await engine.getDiff(frame.params.threadId, frame.params.scope) })
          } else if (frame.method === 'getDiffSummary') {
            send({ kind: 'response', id: frame.id, ok: true, data: await engine.getDiffSummary(frame.params.threadId) })
          } else if (frame.method === 'fileAction') {
            send({ kind: 'response', id: frame.id, ok: true, data: await engine.applyFileAction(frame.params.threadId, frame.params.action, frame.params.path) })
          } else if (frame.method === 'listModels') {
            const models = mergeCodexAgentModels(await getCodexAgentModels())
            send({ kind: 'response', id: frame.id, ok: true, data: { models } })
          }
        } catch (err) {
          send({ kind: 'response', id: frame.id, ok: false, error: String(err) })
        }
      } else if (frame.kind === 'subscribe') {
        const push = (message: Parameters<Parameters<Engine['subscribeShell']>[0]>[0]): void =>
          send({ kind: 'stream', id: frame.id, message })
        if (frame.method === 'subscribeShell') {
          unsubs.set(frame.id, engine.subscribeShell(push))
        } else if (frame.method === 'subscribeThread' && typeof frame.params?.threadId === 'string') {
          const afterSeq = typeof frame.params.afterSeq === 'number' ? frame.params.afterSeq : undefined
          unsubs.set(frame.id, engine.subscribeThread(frame.params.threadId, afterSeq, push))
        }
      } else if (frame.kind === 'unsubscribe') {
        unsubs.get(frame.id)?.()
        unsubs.delete(frame.id)
      }
    }

    ws.on('message', (data) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!frame || typeof frame !== 'object' || typeof frame.id !== 'number') return
      // never let a bad frame take down the main process
      void handleFrame(frame).catch(() => {})
    })

    ws.on('close', () => {
      for (const u of unsubs.values()) u()
      unsubs.clear()
    })
  })

  return new Promise((resolve) => {
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port
      resolve({ host, port, close: () => wss.close() })
    })
  })
}
