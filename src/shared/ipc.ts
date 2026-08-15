/**
 * Electron native IPC — the small surface that must go through the main
 * process (dialogs, theme, shell). App data/agent/diff traffic uses the
 * RPC channels in `rpc.ts`.
 */
export const IpcChannels = {
  pickFolder: 'native:pick-folder',
  openExternal: 'native:open-external',
  showContextMenu: 'native:context-menu',
  /** invoke → boolean: is the window in (macOS native) fullscreen right now */
  getFullScreen: 'native:get-fullscreen',
  /** main → renderer push on enter/leave fullscreen; payload is the new boolean */
  fullScreenChanged: 'native:fullscreen-changed'
} as const

export interface ContextMenuItem {
  id: string
  label?: string
  type?: 'normal' | 'separator'
  enabled?: boolean
  danger?: boolean
}
