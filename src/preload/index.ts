import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type ContextMenuItem } from '@shared/ipc'
import { RpcChannels, type StreamFrame } from '@shared/rpc'

/** Native bridge: dialogs/shell plus the engine RPC (request + subscriptions). */
const native = {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.pickFolder),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IpcChannels.openExternal, url),
  showContextMenu: (items: ContextMenuItem[]): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.showContextMenu, items),

  rpc: {
    request: (method: string, params: unknown): Promise<unknown> => ipcRenderer.invoke(RpcChannels.request, method, params),
    subscribe: (id: number, method: string, params: unknown): void => ipcRenderer.send(RpcChannels.subscribe, { id, method, params }),
    unsubscribe: (id: number): void => ipcRenderer.send(RpcChannels.unsubscribe, id),
    onStream: (cb: (frame: StreamFrame) => void): void => {
      ipcRenderer.on(RpcChannels.stream, (_e, frame: StreamFrame) => cb(frame))
    }
  }
}

export type NativeApi = typeof native

contextBridge.exposeInMainWorld('native', native)
