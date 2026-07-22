import { useEffect } from 'react'
import { useServer } from './state/serverStore'
import { useUi } from './state/uiStore'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { CommandPalette } from './components/CommandPalette'
import { Sparkles } from 'lucide-react'

export default function App(): JSX.Element {
  const init = useServer((s) => s.init)
  const ready = useServer((s) => s.ready)
  const connected = useServer((s) => s.connected)
  const activeThreadId = useUi((s) => s.activeThreadId)
  const openTab = useUi((s) => s.openTab)
  const setActive = useUi((s) => s.setActive)
  const setCommandPaletteOpen = useUi((s) => s.setCommandPaletteOpen)

  useEffect(() => {
    void init()
  }, [init])

  // re-open the last active thread on launch — unless it no longer exists
  useEffect(() => {
    if (!ready || !activeThreadId) return
    const exists = useServer.getState().shell.threads.some((t) => t.id === activeThreadId)
    if (exists) openTab(activeThreadId)
    else setActive(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // global shortcut: ⌘K / Ctrl+K → command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCommandPaletteOpen])

  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Sparkles size={22} className="text-primary" />
        <span>{connected ? 'Loading…' : 'Starting local server…'}</span>
      </div>
    )
  }

  return (
    <div className="relative flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {activeThreadId ? (
          <ChatView key={activeThreadId} threadId={activeThreadId} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col bg-background">
            <header className="drag-region flex h-13 items-center border-b px-5">
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
      <CommandPalette />
      {!connected && (
        <div className="absolute bottom-3.5 left-1/2 z-60 -translate-x-1/2 rounded-full border border-input bg-popover px-3.5 py-1.5 text-xs text-muted-foreground">
          Reconnecting to local server…
        </div>
      )}
    </div>
  )
}
