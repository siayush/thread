import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FileCode2, TriangleAlert } from 'lucide-react'
import type { CodeViewFileItem } from '@pierre/diffs'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import { fnv1a } from '../lib/hash'
import { useServer } from '../state/serverStore'
import { useUi } from '../state/uiStore'
import { SidebarToggle } from './Sidebar'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'

/**
 * Bridges @pierre/diffs' internal styling to the Thread palette. The file
 * header is disabled (FileView has its own header bar), so only the code
 * surface needs blending.
 */
const FILE_UNSAFE_CSS = `
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--background) !important;
  --diffs-dark-bg: var(--background) !important;
  --diffs-token-dark-bg: transparent;
  background-color: var(--diffs-bg) !important;
}
`

const FILE_OPTIONS = {
  themeType: 'dark',
  disableFileHeader: true,
  overflow: 'scroll',
  unsafeCSS: FILE_UNSAFE_CSS,
  // CodeViewLayout requires all three fields; only paddingBottom deviates from defaults
  layout: { paddingTop: 8, paddingBottom: 16, gap: 8 }
} as const

/**
 * Read-only file viewer for file references the agent emits in chat
 * (`src/foo.ts`, `foo.ts:42`). Fills the main area like the diff view; the
 * back button (or Escape) returns to the conversation. Rendering goes through
 * @pierre/diffs' CodeView — the same shiki worker pool, theme, and
 * virtualization as the diff view.
 */
export function FileView({ threadId }: { threadId: string }): JSX.Element {
  const target = useUi((s) => s.fileTarget)
  const setThreadView = useUi((s) => s.setThreadView)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const readProjectFile = useServer((s) => s.readProjectFile)

  // forPath marks which request the result belongs to; a stale result renders as loading
  const [state, setState] = useState<{ forPath: string; path: string; content: string | null; error: string | null } | null>(null)
  const viewRef = useRef<CodeViewHandle<undefined>>(null)

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

  const item = useMemo<CodeViewFileItem | null>(() => {
    if (loaded?.content == null) return null
    const cacheKey = fnv1a(`${loaded.path}\n${loaded.content}`)
    // the id doubles as the content hash: CodeView ignores same-id updates
    // unless `version` is bumped, so a fresh id per content sidesteps that
    return { id: `file:${cacheKey}`, type: 'file', file: { name: loaded.path, contents: loaded.content, cacheKey } }
  }, [loaded])

  // once loaded, bring the referenced line into view
  const line = target?.line ?? null
  useEffect(() => {
    if (!item || line == null) return
    const id = item.id
    const raf = requestAnimationFrame(() => {
      viewRef.current?.scrollTo({ type: 'line', id, lineNumber: line, align: 'center' })
    })
    return () => cancelAnimationFrame(raf)
  }, [item, line])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={cn('drag-region flex h-13 shrink-0 items-center gap-2.5 border-b pr-3.5 transition-[padding] duration-150 ease-out', sidebarCollapsed ? 'pl-19' : 'pl-3.5')}>
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

      <div className="min-h-0 flex-1 overflow-hidden">
        {!loaded ? (
          <div className="grid h-full place-items-center text-muted-foreground">
            <Spinner className="size-4" />
          </div>
        ) : loaded.error ? (
          <div className="mx-auto mt-10 flex w-fit items-center gap-2 rounded-[10px] border border-amber/35 bg-amber/8 px-3.5 py-2.5 text-xs text-amber">
            <TriangleAlert className="size-[13px] shrink-0" /> {loaded.error}
          </div>
        ) : item ? (
          /* CodeView's root element is its own scroll container (it attaches
             its scroll listener there), so it must get overflow-y itself */
          <CodeView
            ref={viewRef}
            className="h-full overflow-y-auto overscroll-contain"
            items={[item]}
            options={FILE_OPTIONS}
            selectedLines={line != null ? { id: item.id, range: { start: line, end: line } } : null}
          />
        ) : null}
      </div>
    </div>
  )
}
