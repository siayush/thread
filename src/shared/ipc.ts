/**
 * Electron native IPC — the small surface that must go through the main
 * process (dialogs, theme, shell, and the local server's connection info).
 * Everything else (data, agent, diffs) flows over the WS RPC.
 */
export const IpcChannels = {
  getServerInfo: 'native:get-server-info',
  pickFolder: 'native:pick-folder',
  openExternal: 'native:open-external',
  showContextMenu: 'native:context-menu'
} as const

export interface ServerInfo {
  host: string
  port: number
}

export interface ContextMenuItem {
  id: string
  label?: string
  type?: 'normal' | 'separator'
  enabled?: boolean
  danger?: boolean
}
