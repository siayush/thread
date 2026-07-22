import { ipcMain } from 'electron'
import { RpcChannels, type RpcRequestMethod, type StreamFrame, type StreamMessage, type SubscribeFrame } from '@shared/rpc'
import type { Engine } from './engine'
import { mergeCodexAgentModels } from './models'
import { getCodexAgentModels } from './provider/codexModelList'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Registers the renderer↔engine RPC on Electron IPC. Returns a disposer. */
export function registerRpc(engine: Engine): () => void {
  // active subscriptions per renderer, so a closed window is cleaned up
  const subsBySender = new Map<number, Map<number, () => void>>()

  ipcMain.handle(RpcChannels.request, async (_e, method: RpcRequestMethod, params: any) => {
    switch (method) {
      case 'dispatchCommand':
        return engine.dispatch(params)
      case 'getDiff':
        return engine.getDiff(params.threadId, params.scope)
      case 'getDiffSummary':
        return engine.getDiffSummary(params.threadId)
      case 'fileAction':
        return engine.applyFileAction(params.threadId, params.action, params.paths)
      case 'listModels':
        return { models: mergeCodexAgentModels(await getCodexAgentModels()) }
    }
  })

  ipcMain.on(RpcChannels.subscribe, (event, frame: SubscribeFrame) => {
    const sender = event.sender
    const senderId = sender.id
    let subs = subsBySender.get(senderId)
    if (!subs) {
      subs = new Map()
      subsBySender.set(senderId, subs)
      sender.once('destroyed', () => {
        for (const unsub of subsBySender.get(senderId)?.values() ?? []) unsub()
        subsBySender.delete(senderId)
      })
    }
    const push = (message: StreamMessage): void => {
      if (!sender.isDestroyed()) sender.send(RpcChannels.stream, { id: frame.id, message } satisfies StreamFrame)
    }
    if (frame.method === 'subscribeShell') {
      subs.set(frame.id, engine.subscribeShell(push))
    } else if (frame.method === 'subscribeThread' && typeof frame.params?.threadId === 'string') {
      subs.set(frame.id, engine.subscribeThread(frame.params.threadId, push))
    }
  })

  ipcMain.on(RpcChannels.unsubscribe, (event, id: number) => {
    const subs = subsBySender.get(event.sender.id)
    subs?.get(id)?.()
    subs?.delete(id)
  })

  return () => {
    ipcMain.removeHandler(RpcChannels.request)
    ipcMain.removeAllListeners(RpcChannels.subscribe)
    ipcMain.removeAllListeners(RpcChannels.unsubscribe)
    for (const subs of subsBySender.values()) for (const unsub of subs.values()) unsub()
    subsBySender.clear()
  }
}
