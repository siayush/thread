import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, type MenuItemConstructorOptions } from 'electron'
import { IpcChannels, type ContextMenuItem } from '@shared/ipc'
import { startServer, type Server } from './server'
import appIcon from '../../resources/icon.png?asset'

app.setName('Thread')

if (process.platform === 'darwin') app.dock?.setIcon(appIcon)

let mainWindow: BrowserWindow | null = null
let server: Server | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: appIcon,
    backgroundColor: '#0b0b0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 20 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // the preload only uses contextBridge/ipcRenderer, both sandbox-safe —
      // keep the renderer sandboxed since it displays agent-produced content
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // fullscreen hides the macOS traffic lights — the renderer shifts the
  // titlebar controls (sidebar toggle) into the freed space
  const sendFullScreen = (value: boolean): void => mainWindow?.webContents.send(IpcChannels.fullScreenChanged, value)
  mainWindow.on('enter-full-screen', () => sendFullScreen(true))
  mainWindow.on('leave-full-screen', () => sendFullScreen(false))
  // never leave the module-level ref pointing at a destroyed window (macOS keeps
  // the app alive after close; a dialog against a destroyed window throws)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle(IpcChannels.pickFolder, async (): Promise<string | null> => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(IpcChannels.openExternal, (_e, url: string) => shell.openExternal(url))

  ipcMain.handle(IpcChannels.getFullScreen, () => mainWindow?.isFullScreen() ?? false)

  ipcMain.handle(IpcChannels.showContextMenu, (event, items: ContextMenuItem[]): Promise<string | null> => {
    return new Promise((resolve) => {
      let picked: string | null = null
      const template: MenuItemConstructorOptions[] = items.map((it) =>
        it.type === 'separator'
          ? { type: 'separator' }
          : {
            label: it.label,
            enabled: it.enabled !== false,
            click: () => {
              picked = it.id
            }
          }
      )
      const menu = Menu.buildFromTemplate(template)
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      menu.popup({ window: win, callback: () => resolve(picked) })
    })
  })
}

app.whenReady().then(() => {
  server = startServer(join(app.getPath('userData'), 'thread.sqlite'))
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  server?.dispose()
  server = null
})
