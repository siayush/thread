import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parsePatchFiles, type CodeViewDiffItem, type CodeViewItem } from '@pierre/diffs'
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'
import { useUi } from '../state/uiStore'
import { SidebarToggle } from './Sidebar'
import { useDiffData } from '../state/diffStore'
import type { ThreadDetail } from '@shared/domain'
import { ArrowLeft, Rows3, Columns2, Undo, ChevronDown, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const DIFF_THEME = 'github-dark'

/**
 * Bridges @pierre/diffs' internal styling to the Thread palette. Injected via the
 * CodeView `unsafeCSS` option.
 */
const DIFF_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 88%, var(--emerald));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 85%, var(--emerald));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 82%, var(--emerald));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 74%, var(--emerald));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 82%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--background) 74%, var(--destructive));

  background-color: var(--diffs-bg) !important;
}

/* GitHub-PR-style file cards: rounded, bordered, one per file */
[data-diff] {
  border: 1px solid var(--border) !important;
  border-radius: 10px;
  overflow: clip;
}

/* hunk separators: just a thin quiet band, no "N unmodified lines" bar */
[data-separator='simple'] {
  min-height: 6px !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
  align-items: center !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  min-height: 32px !important;
  padding-block: 6px !important;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: 11px !important;
  font-variant-numeric: tabular-nums;
}

[data-title] {
  font-family: var(--font-sans) !important;
}
`

function diffOptions(view: 'inline' | 'split') {
  return {
    diffStyle: view === 'split' ? 'split' : 'unified',
    // char-level inner diff + no gutter tick marks, like VS Code's diff editor
    lineDiffType: 'char',
    diffIndicators: 'none',
    hunkSeparators: 'simple',
    overflow: 'scroll',
    theme: DIFF_THEME,
    themeType: 'dark',
    unsafeCSS: DIFF_UNSAFE_CSS,
    stickyHeaders: true,
    layout: { paddingTop: 0, paddingBottom: 8, gap: 8 }
  } as const
}

/** Shares one shiki worker pool for syntax highlighting. */
function DiffWorkerPool({ children }: { children: ReactNode }): JSX.Element {
  const poolSize = useMemo(() => {
    const cores = typeof navigator === 'undefined' ? 4 : Math.max(1, navigator.hardwareConcurrency || 4)
    return Math.max(2, Math.min(6, Math.floor(cores / 2)))
  }, [])
  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize, totalASTLRUCacheSize: 240 }}
      highlighterOptions={{ theme: DIFF_THEME, tokenizeMaxLineLength: 1000, useTokenTransformer: true }}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}

function DiffMessage({ children }: { children: ReactNode }): JSX.Element {
  return <div className="p-5 text-center text-[12.5px] text-muted-foreground">{children}</div>
}

/** FNV-1a content hash — the worker pool caches rendered diffs by this key,
 *  so it must change whenever the patch text does (length alone collides). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

interface FileStat {
  additions: number
  deletions: number
}

/** GitHub-PR-style 5-square diffstat meter. */
function DiffStatSquares({ additions, deletions }: FileStat): JSX.Element | null {
  const total = additions + deletions
  if (total === 0) return null
  let green = Math.round((additions / total) * 5)
  if (additions > 0) green = Math.max(1, green)
  if (deletions > 0) green = Math.min(4, green)
  return (
    <span className="flex items-center gap-[2px]" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={cn('size-[7px] rounded-[1.5px]', i < green ? 'bg-emerald' : 'bg-destructive')} />
      ))}
    </span>
  )
}

function CopyPathButton({ path }: { path: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="flex size-5 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      title="Copy file path"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(path)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check className="size-3 text-emerald" /> : <Copy className="size-3" />}
    </button>
  )
}

function PierreDiff({
  patch,
  view,
  stats,
  selectedFile
}: {
  patch: string
  view: 'inline' | 'split'
  stats: Record<string, FileStat>
  selectedFile: string | null
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const viewRef = useRef<CodeViewHandle<undefined>>(null)

  const items = useMemo<CodeViewDiffItem[]>(() => {
    if (!patch.trim()) return []
    const key = fnv1a(patch)
    let parsed: ReturnType<typeof parsePatchFiles>
    try {
      parsed = parsePatchFiles(patch, `thread:${key}`)
    } catch {
      return []
    }
    // collapse toggles must bump `version`, or CodeView's reconciler ignores
    // the updated item for an id it already knows
    return parsed.flatMap((p) => p.files).map((fileDiff, i) => ({
      id: `${key}:${i}`,
      type: 'diff' as const,
      fileDiff,
      collapsed: !!collapsed[fileDiff.name],
      version: collapsed[fileDiff.name] ? 1 : 0
    }))
  }, [patch, collapsed])

  const options = useMemo(() => diffOptions(view), [view])

  // selecting a file in the sidebar scrolls to its card (expanding it first if collapsed)
  useEffect(() => {
    if (!selectedFile) return
    const item = items.find((i) => i.fileDiff.name === selectedFile)
    if (!item) return
    const raf = requestAnimationFrame(() => {
      setCollapsed((prev) => (prev[selectedFile] ? { ...prev, [selectedFile]: false } : prev))
      viewRef.current?.scrollTo({ type: 'item', id: item.id, align: 'start', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile, items.length])

  const renderHeader = useCallback(
    (item: CodeViewItem): ReactNode => {
      if (item.type !== 'diff') return null
      const name = item.fileDiff.name
      const isCollapsed = !!collapsed[name]
      const stat = stats[name]
      return (
        <div
          className="flex h-full w-full cursor-pointer items-center gap-1.5 pr-3 pl-1.5 select-none"
          onClick={() => setCollapsed((prev) => ({ ...prev, [name]: !prev[name] }))}
        >
          <span className="flex size-5 flex-none items-center justify-center rounded text-muted-foreground">
            <ChevronDown className={cn('size-3.5 transition-transform duration-150', isCollapsed && '-rotate-90')} />
          </span>
          <span className="truncate font-mono text-[12px] text-foreground">
            {item.fileDiff.prevName && item.fileDiff.prevName !== name ? `${item.fileDiff.prevName} → ${name}` : name}
          </span>
          <CopyPathButton path={name} />
          {stat && (
            <span className="ml-auto flex flex-none items-center gap-2 font-mono text-[11px] tabular-nums">
              <span>
                <span className="text-emerald">+{stat.additions}</span> <span className="text-destructive">−{stat.deletions}</span>
              </span>
              <DiffStatSquares additions={stat.additions} deletions={stat.deletions} />
            </span>
          )}
        </div>
      )
    },
    [collapsed, stats]
  )

  if (items.length === 0) return <DiffMessage>Unable to render this diff.</DiffMessage>
  return (
    <DiffWorkerPool>
      {/* CodeView's root element is its own scroll container (it attaches its
          scroll listener there), so it must get overflow-y itself */}
      <CodeView
        ref={viewRef}
        className="h-full overflow-y-auto overscroll-contain px-3"
        items={items}
        options={options}
        renderCustomHeader={renderHeader}
      />
    </DiffWorkerPool>
  )
}

export function DiffPanel({ detail }: { detail: ThreadDetail }): JSX.Element {
  const diffScope = useUi((s) => s.diffScope)
  const setDiffScope = useUi((s) => s.setDiffScope)
  const setThreadView = useUi((s) => s.setThreadView)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const diffView = useUi((s) => s.diffView)
  const setDiffView = useUi((s) => s.setDiffView)
  const selectedFile = useUi((s) => s.diffSelectedFile)
  const result = useDiffData((s) => s.result)
  const loading = useDiffData((s) => s.loading)
  const load = useDiffData((s) => s.load)
  const setTarget = useDiffData((s) => s.setTarget)

  const threadId = detail.thread.id
  const scopeKey = diffScope.kind === 'turn' ? diffScope.turnId : 'working'

  // debounced: working-tree diffs re-snapshot the whole tree. Retarget the
  // store immediately though, so switching threads doesn't flash the old diff
  useEffect(() => {
    setTarget(threadId, diffScope)
    const t = setTimeout(() => void load(threadId, diffScope), 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, scopeKey, detail.checkpoints.length, detail.thread.status])

  const turns = [...detail.turns].filter((t) => detail.checkpoints.some((c) => c.turnId === t.id)).sort((a, b) => b.startedAt - a.startedAt)

  const scopeItems = useMemo(() => {
    const items: Record<string, string> = { working: 'Working tree' }
    turns.forEach((t, i) => {
      items[t.id] = `Turn ${turns.length - i}`
    })
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.turns, detail.checkpoints])

  // always render the whole scope; selecting a file in the sidebar scrolls to it
  const files = useMemo(() => result?.files ?? [], [result])

  const patch = useMemo(() => files.map((f) => f.patch).filter(Boolean).join('\n'), [files])

  // per-file ±counts for the file-card headers; a partially staged file appears
  // twice in `files` (staged + unstaged), so sum the two entries
  const stats = useMemo(() => {
    const map: Record<string, FileStat> = {}
    for (const f of files) {
      const cur = map[f.path]
      map[f.path] = cur ? { additions: cur.additions + f.additions, deletions: cur.deletions + f.deletions } : { additions: f.additions, deletions: f.deletions }
    }
    return map
  }, [files])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('drag-region flex h-13 items-center gap-2.5 border-b pr-3', sidebarCollapsed ? 'pl-19' : 'pl-3')}>
        {sidebarCollapsed && <SidebarToggle />}
        <Button
          variant="ghost"
          size="sm"
          className="no-drag gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => setThreadView('chat')}
        >
          <ArrowLeft className="size-[14px]" /> Back
        </Button>
        <Select
          items={scopeItems}
          value={scopeKey}
          onValueChange={(value) => setDiffScope(!value || value === 'working' ? { kind: 'working' } : { kind: 'turn', turnId: value })}
        >
          <SelectTrigger
            size="sm"
            className="no-drag h-auto gap-1.5 rounded-lg border-border bg-muted px-2 py-1 text-[11.5px] text-foreground/80 dark:bg-muted dark:hover:bg-accent"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(scopeItems).map(([value, label]) => (
              <SelectItem key={value} value={value} className="text-xs">
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {result && !result.error && (
          <span className="text-[11.5px] text-muted-foreground">
            {result.files.length} file{result.files.length === 1 ? '' : 's'} · <span className="text-emerald">+{result.additions}</span>{' '}
            <span className="text-destructive">−{result.deletions}</span>
          </span>
        )}
        <div className="no-drag ml-auto flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn('text-muted-foreground', diffView === 'inline' && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
            title="Inline diff"
            aria-pressed={diffView === 'inline'}
            onClick={() => setDiffView('inline')}
          >
            <Rows3 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn('text-muted-foreground', diffView === 'split' && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
            title="Side-by-side diff"
            aria-pressed={diffView === 'split'}
            onClick={() => setDiffView('split')}
          >
            <Columns2 className="size-3.5" />
          </Button>
        </div>
        <Button variant="ghost" size="icon-xs" className="no-drag text-muted-foreground" title="Refresh" onClick={() => void load(threadId, diffScope)}>
          <Undo className="size-[13px]" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading && !result && <DiffMessage>Loading diff…</DiffMessage>}
        {!loading && result?.error && <DiffMessage>{result.error}</DiffMessage>}
        {result && !result.error && result.files.length === 0 && !loading && <DiffMessage>No changes.</DiffMessage>}
        {result && !result.error && files.length > 0 && <PierreDiff patch={patch} view={diffView} stats={stats} selectedFile={selectedFile} />}
      </div>
    </div>
  )
}
