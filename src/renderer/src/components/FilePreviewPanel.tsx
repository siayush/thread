import { useEffect, useMemo, useRef, useState } from 'react'
import { FileCode2, TriangleAlert } from 'lucide-react'
import type { CodeViewFileItem } from '@pierre/diffs'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import { fnv1a } from '../lib/hash'
import { useServer } from '../state/serverStore'
import type { RightPanelSurface } from '../state/rightPanelStore'
import { FileTreeView } from './FileTreeView'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'

/**
 * Bridges @pierre/diffs' internal styling to the Thread palette. The file
 * header is disabled (the panel has its own breadcrumb bar), so only the code
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
/* drop the horizontal scrollbar under the code: the gutter var drives
   ::-webkit-scrollbar's height, so 0 hides the bar without disabling
   horizontal scrolling (trackpad/shift-wheel still work) */
[data-file] {
  --diffs-scrollbar-gutter: 0px;
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

/** Read-only viewer for one `file:` surface — same shiki pool and theme as the diff. */
function FileContent({
  threadId,
  path,
  line,
  revealRequestId
}: {
  threadId: string
  path: string
  line: number | null
  revealRequestId: number
}): JSX.Element {
  const readProjectFile = useServer((s) => s.readProjectFile)

  // forPath marks which request the result belongs to; a stale result renders as loading
  const [state, setState] = useState<{ forPath: string; path: string; content: string | null; error: string | null } | null>(null)
  const viewRef = useRef<CodeViewHandle<undefined>>(null)

  // re-read on every re-open (revealRequestId): the agent may have edited the
  // file since the tab was first opened
  useEffect(() => {
    let cancelled = false
    void readProjectFile(threadId, path).then((res) => {
      if (cancelled) return
      setState({ forPath: path, path: res.path, content: res.content ?? null, error: res.ok ? null : (res.error ?? 'Failed to read file') })
    })
    return () => {
      cancelled = true
    }
  }, [threadId, path, revealRequestId, readProjectFile])

  const loaded = state && state.forPath === path ? state : null

  const item = useMemo<CodeViewFileItem | null>(() => {
    if (loaded?.content == null) return null
    const cacheKey = fnv1a(`${loaded.path}\n${loaded.content}`)
    // the id doubles as the content hash: CodeView ignores same-id updates
    // unless `version` is bumped, so a fresh id per content sidesteps that
    return { id: `file:${cacheKey}`, type: 'file', file: { name: loaded.path, contents: loaded.content, cacheKey } }
  }, [loaded])

  // once loaded, bring the referenced line into view — again on every re-open
  useEffect(() => {
    if (!item || line == null) return
    const id = item.id
    const raf = requestAnimationFrame(() => {
      viewRef.current?.scrollTo({ type: 'line', id, lineNumber: line, align: 'center' })
    })
    return () => cancelAnimationFrame(raf)
  }, [item, line, revealRequestId])

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-[7px] border-b px-3">
        <FileCode2 className="size-[13px] shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-foreground/85" title={path}>
          {loaded?.path ?? path}
        </span>
        {line != null && (
          <Badge variant="secondary" className="h-4 shrink-0 bg-muted px-1.5 text-[10px] text-muted-foreground">
            line {line}
          </Badge>
        )}
      </div>
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

/**
 * The files workspace, shared by the `files` and `file` surfaces the way
 * t3 code's FilePreviewPanel is: the tree fills the whole panel while nothing
 * is open, and docks as a rail beside the open file otherwise.
 */
export function FilePreviewPanel({
  threadId,
  projectId,
  surface,
  active
}: {
  threadId: string
  projectId: string
  surface: Extract<RightPanelSurface, { kind: 'files' | 'file' }>
  active: boolean
}): JSX.Element {
  const file = surface.kind === 'file' ? surface : null
  return (
    <div className="flex h-full min-h-0">
      {file && (
        <FileContent key={file.path} threadId={threadId} path={file.path} line={file.line} revealRequestId={file.revealRequestId} />
      )}
      <aside className={cn('flex min-h-0 flex-col', file ? 'w-[min(16rem,45%)] min-w-48 shrink-0 border-l' : 'min-w-0 flex-1')}>
        <FileTreeView projectId={projectId} threadId={threadId} active={active} />
      </aside>
    </div>
  )
}
