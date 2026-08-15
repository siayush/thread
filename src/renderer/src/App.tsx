import { useEffect } from 'react'
import { useServer } from './state/serverStore'
import { useUi } from './state/uiStore'
import { Sidebar, SidebarControl } from './components/Sidebar'
import { useFullscreen } from './lib/useFullscreen'
import { RightPanel } from './components/RightPanel'
import { useRightPanel } from './state/rightPanelStore'
import { ChatView } from './components/ChatView'
import { CommandPalette } from './components/CommandPalette'
import { ConfirmDialog } from './components/ConfirmDialog'
import { SettingsPage } from './components/SettingsPage'
import { CodeWorkerPool } from './components/CodeWorkerPool'
import { cn } from '@/lib/utils'
import { Sparkles } from 'lucide-react'

export default function App(): JSX.Element {
  const init = useServer((s) => s.init)
  const ready = useServer((s) => s.ready)
  const activeThreadId = useUi((s) => s.activeThreadId)
  const openTab = useUi((s) => s.openTab)
  const setActive = useUi((s) => s.setActive)
  const setCommandPaletteOpen = useUi((s) => s.setCommandPaletteOpen)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const theme = useUi((s) => s.theme)
  const fullscreen = useFullscreen()

  // where the fixed titlebar controls sit: right of the macOS traffic lights,
  // or flush left when fullscreen hides them
  const isMac = navigator.platform.startsWith('Mac')
  const controlsLeft = !isMac || fullscreen ? '0.75rem' : '90px'

  useEffect(() => {
    init()
  }, [init])

  // reflect the chosen theme onto <html> so the CSS [data-theme] override applies
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // re-open the last active thread on launch — unless it no longer exists
  useEffect(() => {
    if (!ready || !activeThreadId) return
    const exists = useServer.getState().shell.threads.some((t) => t.id === activeThreadId)
    if (exists) openTab(activeThreadId)
    else setActive(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // global shortcuts: ⌘K → command palette, ⌘B → toggle sidebar,
  // ⌘⇧E → files surface, ⌘⇧G → diff surface (both in the right panel)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(true)
      } else if (key === 'b') {
        e.preventDefault()
        useUi.getState().toggleSidebar()
      } else if ((key === 'e' || key === 'g') && e.shiftKey) {
        e.preventDefault()
        const threadId = useUi.getState().activeThreadId
        if (threadId) useRightPanel.getState().toggle(threadId, key === 'e' ? 'files' : 'diff')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCommandPaletteOpen])

  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Sparkles className="size-[22px] text-primary" />
        <span>Loading…</span>
      </div>
    )
  }

  return (
    // the worker pool lives at the root so shiki workers boot once at launch
    // and stay warm — mounting it per-view tears the pool down on unmount and
    // every file/diff open pays the worker + grammar cold start again
    <CodeWorkerPool>
      <div className="relative flex h-full overflow-hidden" style={{ '--controls-left': controlsLeft } as React.CSSProperties}>
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          {activeThreadId ? (
            <ChatView key={activeThreadId} threadId={activeThreadId} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col bg-background">
              <header className={cn('drag-region flex h-13 items-center gap-1.5 border-b pr-5 transition-[padding] duration-150 ease-out', sidebarCollapsed ? 'pl-[calc(var(--controls-left)+2rem)]' : 'pl-5')}>
                <span className="text-xs text-muted-foreground/50">No active thread</span>
              </header>
              <div className="grid flex-1 place-items-center text-muted-foreground">
                <div className="w-full max-w-lg px-8 py-12 text-center">
                  <h1 className="text-xl font-semibold tracking-tight text-foreground">
                    Pick a thread to continue
                  </h1>
                  <p className="mt-2 text-[13px] text-muted-foreground/80">
                    Select an existing thread or create a new one to get started.
                  </p>
                </div>
              </div>
            </div>
          )}
        </main>
        <RightPanel />
        {/* rendered after the headers: Electron resolves app-region rects in DOM
            order, so the control's no-drag hole must come after their drag rects */}
        <SidebarControl />
        <CommandPalette />
        <ConfirmDialog />
        <SettingsPage />
      </div>
    </CodeWorkerPool>
  )
}
