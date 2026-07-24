import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, FileCode2, TriangleAlert } from 'lucide-react'
import { useServer } from '../state/serverStore'
import { useUi } from '../state/uiStore'
import { SidebarToggle } from './Sidebar'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'

/**
 * Read-only file viewer for file references the agent emits in chat
 * (`src/foo.ts`, `foo.ts:42`). Fills the main area like the diff view; the
 * back button (or Escape) returns to the conversation.
 */
export function FileView({ threadId }: { threadId: string }): JSX.Element {
  const target = useUi((s) => s.fileTarget)
  const setThreadView = useUi((s) => s.setThreadView)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const readProjectFile = useServer((s) => s.readProjectFile)

  // forPath marks which request the result belongs to; a stale result renders as loading
  const [state, setState] = useState<{ forPath: string; path: string; content: string | null; error: string | null } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const back = (): void => setThreadView('chat')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setThreadView('chat')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setThreadView])

  const path = target?.path
  useEffect(() => {
    if (!path) return
    let cancelled = false
    void readProjectFile(threadId, path).then((res) => {
      if (cancelled) return
      setState({ forPath: path, path: res.path, content: res.content ?? null, error: res.ok ? null : (res.error ?? 'Failed to read file') })
    })
    return () => {
      cancelled = true
    }
  }, [threadId, path, readProjectFile])

  const loaded = state && state.forPath === path ? state : null

  // once loaded, bring the referenced line into view
  const line = target?.line ?? null
  useEffect(() => {
    if (loaded?.content == null || line == null) return
    scrollRef.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' })
  }, [loaded, line])

  const lines = loaded?.content?.split('\n') ?? []
  const gutterWidth = `${Math.max(3, String(lines.length).length)}ch`

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={cn('drag-region flex h-13 shrink-0 items-center gap-2.5 border-b pr-3.5', sidebarCollapsed ? 'pl-19' : 'pl-3.5')}>
        {sidebarCollapsed && <SidebarToggle />}
        <Button variant="ghost" size="sm" className="no-drag gap-1.5 text-muted-foreground hover:text-foreground" onClick={back}>
          <ArrowLeft className="size-[14px]" /> Back
        </Button>
        <span className="no-drag flex min-w-0 items-center gap-[7px]">
          <FileCode2 className="size-[13px] shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs text-foreground/85">{loaded?.path ?? path}</span>
          {line != null && (
            <Badge variant="secondary" className="h-4 shrink-0 bg-muted px-1.5 text-[10px] text-muted-foreground">
              line {line}
            </Badge>
          )}
        </span>
      </header>

      <div className="flex-1 overflow-auto" ref={scrollRef}>
        {!loaded ? (
          <div className="grid h-full place-items-center text-muted-foreground">
            <Spinner className="size-4" />
          </div>
        ) : loaded.error ? (
          <div className="mx-auto mt-10 flex w-fit items-center gap-2 rounded-[10px] border border-amber/35 bg-amber/8 px-3.5 py-2.5 text-xs text-amber">
            <TriangleAlert size={13} /> {loaded.error}
          </div>
        ) : (
          <pre className="m-0 min-w-fit py-3 font-mono text-xs leading-[1.6] text-foreground/85">
            {lines.map((text, i) => {
              const n = i + 1
              const hit = n === line
              return (
                <div key={n} data-line={n} className={cn('flex px-0', hit && 'bg-amber/10 shadow-[inset_2px_0_0_var(--color-amber)]')}>
                  <span
                    className={cn('sticky left-0 shrink-0 bg-background pr-3.5 pl-3.5 text-right text-muted-foreground/50 select-none', hit && 'text-amber')}
                    style={{ minWidth: gutterWidth }}
                  >
                    {n}
                  </span>
                  <span className="pr-4 whitespace-pre">{text}</span>
                </div>
              )
            })}
          </pre>
        )}
      </div>
    </div>
  )
}
