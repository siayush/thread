import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type ContextMenuItem, type ServerInfo } from '@shared/ipc'

/** Minimal native bridge. All app data/agent traffic goes over the WS RPC. */
const native = {
  getServerInfo: (): Promise<ServerInfo> => ipcRenderer.invoke(IpcChannels.getServerInfo),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.pickFolder),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IpcChannels.openExternal, url),
  showContextMenu: (items: ContextMenuItem[]): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.showContextMenu, items)
}

export type NativeApi = typeof native

contextBridge.exposeInMainWorld('native', native)
