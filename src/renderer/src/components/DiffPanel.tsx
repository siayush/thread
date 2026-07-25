import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parsePatchFiles, type CodeViewDiffItem, type CodeViewItem } from '@pierre/diffs'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import { fnv1a } from '../lib/hash'
import { useUi } from '../state/uiStore'
import { SidebarToggle } from './Sidebar'
import { useDiffData } from '../state/diffStore'
import type { ThreadDetail } from '@shared/domain'
import { ArrowLeft, Rows3, Columns2, RefreshCw, ChevronDown, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** File-card header height, shared by the CSS and the virtualizer estimate. */
const HEADER_HEIGHT = 36

/**
 * Bridges @pierre/diffs' internal styling to the Thread palette, laid out like
 * GitHub's "Files changed" tab. Injected via CodeView's `unsafeCSS`, which
 * lands in the library's last cascade layer.
 */
const DIFF_UNSAFE_CSS = `
/* :host must be in here — the library derives most of its palette there, and
   [data-diff] lives inside that shadow root, i.e. too late to feed it. */
:host,
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --thread-diff-bg: color-mix(in srgb, var(--card) 90%, var(--background));
  --thread-diff-rule: color-mix(in srgb, var(--background) 90%, var(--foreground));
  --thread-diff-band: color-mix(in srgb, var(--background) 90%, var(--sky));
  --thread-diff-empty: color-mix(in srgb, var(--background) 97%, var(--foreground));

  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;

  /* flush against the card edges — keep in sync with \`itemMetrics\` below */
  --diffs-gap-block: 0px;
  --diffs-gap-inline: 0px;
  --diffs-gap-style: 1px solid var(--thread-diff-rule);

  --diffs-bg: var(--thread-diff-bg) !important;
  --diffs-light-bg: var(--thread-diff-bg) !important;
  --diffs-dark-bg: var(--thread-diff-bg) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* accents behind the +/− markers, gutter numbers and every tint below */
  --diffs-dark-addition-color: var(--emerald);
  --diffs-dark-deletion-color: var(--destructive);
  --diffs-dark-modified-color: var(--sky);

  --diffs-bg-context-override: var(--thread-diff-bg);
  --diffs-bg-context-gutter-override: var(--thread-diff-bg);
  --diffs-bg-separator-override: var(--thread-diff-band);
  --diffs-bg-hover-override: var(--foreground);

  --diffs-bg-addition-emphasis-override: color-mix(in srgb, transparent 62%, var(--emerald));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, transparent 62%, var(--destructive));

  --diffs-fg-number-override: color-mix(in srgb, var(--foreground) 38%, transparent);
  --diffs-fg-number-addition-override: color-mix(in srgb, var(--emerald) 55%, var(--foreground));
  --diffs-fg-number-deletion-override: color-mix(in srgb, var(--destructive) 55%, var(--foreground));

  background-color: var(--diffs-bg) !important;
}

/* Tint strength: the accent is mixed *into* the row bg, so lower = stronger. */
:where([data-background]) [data-line],
:where([data-background]) [data-no-newline] {
  --mix-dark: 85%;
}
:where([data-background]) [data-gutter-buffer],
:where([data-background]) [data-column-number] {
  --mix-dark: 72%;
}
@media (pointer: fine) {
  [data-hovered]:is(:where([data-background]) [data-line], :where([data-background]) [data-no-newline]) {
    --mix-dark: 79%;
  }
  [data-hovered]:is(:where([data-background]) [data-gutter-buffer], :where([data-background]) [data-column-number]) {
    --mix-dark: 66%;
  }
}

/* the card is :host — the header is a *sibling* of [data-diff], not a child,
   so bordering [data-diff] leaves the name bar floating outside the box */
:host {
  border: 1px solid var(--thread-diff-rule);
  border-radius: 6px;
  overflow: clip;
}

/* Only the library's *default* header is a flex row; the custom one is a bare
   block wrapping a <slot>, so it has to become one before anything can centre. */
[data-diffs-header] {
  display: flex !important;
  align-items: center !important;
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--background) 95%, var(--foreground)) !important;
  border-bottom: 1px solid var(--thread-diff-rule) !important;
  font-family: var(--font-sans) !important;
  height: ${HEADER_HEIGHT}px !important;
  padding: 0 !important;
}

/* React wraps a custom header in a bare div, and *that* is the flex item — so
   it, not our row, is what has to fill the band. */
[data-diffs-header] slot[name='header-custom']::slotted(div) {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 100%;
}

/* fill the "nothing here" regions flat instead of the library's hatching */
[data-content-buffer] {
  background-image: none;
  background-color: var(--thread-diff-empty);
}
[data-gutter-buffer='buffer'] {
  --diffs-line-bg: var(--thread-diff-empty);
}

/* hunk breaks — inset rules, so they add no height the virtualizer can't see */
[data-separator='simple'] {
  box-shadow:
    inset 0 1px 0 var(--thread-diff-rule),
    inset 0 -1px 0 var(--thread-diff-rule);
}

/* one divider between the split panes, not the library's two */
[data-diff-type='split'][data-overflow='scroll'] [data-additions] {
  border-left-color: var(--thread-diff-rule);
}
[data-diff-type='split'][data-overflow='scroll'] [data-deletions] {
  border-right-width: 0;
}
`

function diffOptions(view: 'inline' | 'split') {
  return {
    diffStyle: view === 'split' ? 'split' : 'unified',
    lineDiffType: 'word',
    diffIndicators: 'classic',
    hunkSeparators: 'simple',
    overflow: 'scroll',
    themeType: 'dark',
    unsafeCSS: DIFF_UNSAFE_CSS,
    stickyHeaders: true,
    layout: { paddingTop: 12, paddingBottom: 16, gap: 12 },
    // must mirror the zeroed --diffs-gap-* above, or every card is mis-measured
    itemMetrics: { diffHeaderHeight: HEADER_HEIGHT, spacing: 0, paddingTop: 0, paddingBottom: 0 }
  } as const
}

function DiffMessage({ children }: { children: ReactNode }): JSX.Element {
  return <div className="p-5 text-center text-[12.5px] text-muted-foreground">{children}</div>
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

function DiffStat({ additions, deletions }: FileStat): JSX.Element {
  return (
    <span className="flex flex-none items-center gap-2 font-mono text-[11px] tabular-nums">
      <span>
        <span className="text-emerald">+{additions}</span> <span className="text-destructive">−{deletions}</span>
      </span>
      <DiffStatSquares additions={additions} deletions={deletions} />
    </span>
  )
}

function CopyPathButton({ path }: { path: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="size-5 flex-none text-muted-foreground hover:text-foreground"
      title="Copy file path"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(path)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check className="size-3 text-emerald" /> : <Copy className="size-3" />}
    </Button>
  )
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i + 1)
}
function nameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** Which file cards are folded, scoped to one thread+diff target. */
interface Review {
  key: string
  collapsed: Record<string, boolean>
}
const EMPTY_REVIEW: Omit<Review, 'key'> = { collapsed: {} }

function PierreDiff({
  patch,
  view,
  stats,
  selectedFile,
  collapsed,
  setCollapsed
}: {
  patch: string
  view: 'inline' | 'split'
  stats: Record<string, FileStat>
  selectedFile: string | null
  collapsed: Record<string, boolean>
  setCollapsed: (path: string, value: boolean) => void
}): JSX.Element {
  const viewRef = useRef<CodeViewHandle<undefined>>(null)

  // parsing is pure in `patch` and can be expensive for large diffs — keep it
  // independent of collapse state so a header toggle never re-parses everything
  const parsed = useMemo(() => {
    if (!patch.trim()) return { key: '', files: [] as ReturnType<typeof parsePatchFiles>[number]['files'] }
    const key = fnv1a(patch)
    try {
      return { key, files: parsePatchFiles(patch, `thread:${key}`).flatMap((p) => p.files) }
    } catch {
      return { key, files: [] }
    }
  }, [patch])

  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      // collapse toggles must bump `version`, or CodeView's reconciler ignores
      // the updated item for an id it already knows
      parsed.files.map((fileDiff, i) => ({
        id: `${parsed.key}:${i}`,
        type: 'diff' as const,
        fileDiff,
        collapsed: !!collapsed[fileDiff.name],
        version: collapsed[fileDiff.name] ? 1 : 0
      })),
    [parsed, collapsed]
  )

  const options = useMemo(() => diffOptions(view), [view])

  // selecting a file in the sidebar scrolls to its card (expanding it first if collapsed)
  useEffect(() => {
    if (!selectedFile) return
    const item = items.find((i) => i.fileDiff.name === selectedFile)
    if (!item) return
    const raf = requestAnimationFrame(() => {
      setCollapsed(selectedFile, false)
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
      const renamedFrom = item.fileDiff.prevName && item.fileDiff.prevName !== name ? item.fileDiff.prevName : null
      return (
        <div
          role="button"
          tabIndex={0}
          className="flex h-full w-full cursor-pointer items-center gap-1.5 pr-2.5 pl-1.5 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => setCollapsed(name, !isCollapsed)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setCollapsed(name, !isCollapsed)
            }
          }}
        >
          <span className="flex size-5 flex-none items-center justify-center rounded text-muted-foreground">
            <ChevronDown className={cn('size-3.5 transition-transform duration-150', isCollapsed && '-rotate-90')} />
          </span>
          <span className="truncate font-mono text-[12px]" title={renamedFrom ? `${renamedFrom} → ${name}` : name}>
            {renamedFrom && <span className="text-muted-foreground">{renamedFrom} → </span>}
            <span className="text-muted-foreground">{dirOf(name)}</span>
            <span className="text-foreground">{nameOf(name)}</span>
          </span>
          <CopyPathButton path={name} />
          <span className="ml-auto flex flex-none items-center">{stat && <DiffStat additions={stat.additions} deletions={stat.deletions} />}</span>
        </div>
      )
    },
    [collapsed, stats, setCollapsed]
  )

  if (items.length === 0) return <DiffMessage>Unable to render this diff.</DiffMessage>
  return (
    /* CodeView's root element is its own scroll container (it attaches its
       scroll listener there), so it must get overflow-y itself */
    <CodeView
      ref={viewRef}
      className="h-full overflow-y-auto overscroll-contain px-3"
      items={items}
      options={options}
      renderCustomHeader={renderHeader}
    />
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

  // storing the target alongside the folds means a different diff just reads
  // as empty — no reset effect, no frame showing the last thread's folds
  const reviewKey = `${threadId}|${scopeKey}`
  const [review, setReview] = useState<Review>({ key: reviewKey, ...EMPTY_REVIEW })
  const { collapsed } = review.key === reviewKey ? review : EMPTY_REVIEW

  const setCollapsed = useCallback(
    (path: string, value: boolean) =>
      setReview((prev) => {
        const base = prev.key === reviewKey ? prev : EMPTY_REVIEW
        return { key: reviewKey, collapsed: { ...base.collapsed, [path]: value } }
      }),
    [reviewKey]
  )

  // Retarget the store immediately so switching threads doesn't flash the old
  // diff. A cleared result means the target changed (or was never loaded) —
  // fetch it right away; same-target refreshes from checkpoint/status churn
  // stay debounced because working-tree diffs re-snapshot the whole tree.
  useEffect(() => {
    setTarget(threadId, diffScope)
    if (useDiffData.getState().result === null) {
      void load(threadId, diffScope)
      return
    }
    const t = setTimeout(() => void load(threadId, diffScope), 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, scopeKey, detail.checkpoints.length, detail.thread.status])

  // edits made outside the app (another editor, terminal) produce no thread
  // events, so revalidate the working diff when the window regains focus.
  // Turn diffs are immutable snapshots — nothing external can change them.
  useEffect(() => {
    if (diffScope.kind !== 'working') return
    const onFocus = (): void => void load(threadId, diffScope)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [threadId, diffScope, load])

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

  const fileCount = Object.keys(stats).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('drag-region flex h-13 items-center gap-2.5 border-b pr-3 transition-[padding] duration-150 ease-out', sidebarCollapsed ? 'pl-19' : 'pl-3')}>
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
          <span className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <span>
              {fileCount} file{fileCount === 1 ? '' : 's'}
            </span>
            <DiffStat additions={result.additions} deletions={result.deletions} />
          </span>
        )}
        <div className="no-drag ml-auto flex items-center gap-2.5">
          <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn('text-muted-foreground', diffView === 'inline' && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
              title="Unified diff"
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
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title="Refresh" onClick={() => void load(threadId, diffScope)}>
            <RefreshCw className="size-[13px]" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading && !result && <DiffMessage>Loading diff…</DiffMessage>}
        {!loading && result?.error && <DiffMessage>{result.error}</DiffMessage>}
        {result && !result.error && result.files.length === 0 && !loading && <DiffMessage>No changes.</DiffMessage>}
        {result && !result.error && files.length > 0 && (
          <PierreDiff
            patch={patch}
            view={diffView}
            stats={stats}
            selectedFile={selectedFile}
            collapsed={collapsed}
            setCollapsed={setCollapsed}
          />
        )}
      </div>
    </div>
  )
}
