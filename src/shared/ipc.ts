/**
 * Electron native IPC — the small surface that must go through the main
 * process (dialogs, theme, shell). App data/agent/diff traffic uses the
 * RPC channels in `rpc.ts`.
 */
export const IpcChannels = {
  pickFolder: 'native:pick-folder',
  openExternal: 'native:open-external',
  showContextMenu: 'native:context-menu'
} as const

export interface ContextMenuItem {
  id: string
  label?: string
  type?: 'normal' | 'separator'
  enabled?: boolean
  danger?: boolean
}
