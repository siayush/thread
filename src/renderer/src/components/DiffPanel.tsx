import { useEffect, useMemo, type ReactNode } from 'react'
import { parsePatchFiles, type CodeViewDiffItem } from '@pierre/diffs'
import { CodeView, WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'
import { useUi } from '../state/uiStore'
import { useDiffData } from '../state/diffStore'
import type { ThreadDetail } from '@shared/domain'
import { Rows3, Columns2, Undo, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const DIFF_THEME = 'pierre-dark'

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

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--emerald));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--emerald));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--emerald));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--emerald));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--destructive));

  background-color: var(--diffs-bg) !important;
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
    lineDiffType: 'none',
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

function PierreDiff({ patch, view }: { patch: string; view: 'inline' | 'split' }): JSX.Element {
  const items = useMemo<CodeViewDiffItem[]>(() => {
    if (!patch.trim()) return []
    let parsed: ReturnType<typeof parsePatchFiles>
    try {
      parsed = parsePatchFiles(patch, `thread:${patch.length}`)
    } catch {
      return []
    }
    return parsed.flatMap((p) => p.files).map((fileDiff, i) => ({ id: String(i), type: 'diff' as const, fileDiff }))
  }, [patch])

  const options = useMemo(() => diffOptions(view), [view])

  if (items.length === 0) return <DiffMessage>Unable to render this diff.</DiffMessage>
  return (
    <DiffWorkerPool>
      <CodeView className="h-full" items={items} options={options} />
    </DiffWorkerPool>
  )
}

export function DiffPanel({ detail }: { detail: ThreadDetail }): JSX.Element {
  const diffScope = useUi((s) => s.diffScope)
  const setDiffScope = useUi((s) => s.setDiffScope)
  const diffView = useUi((s) => s.diffView)
  const setDiffView = useUi((s) => s.setDiffView)
  const selectedFile = useUi((s) => s.diffSelectedFile)
  const setDiffSelectedFile = useUi((s) => s.setDiffSelectedFile)
  const result = useDiffData((s) => s.result)
  const loading = useDiffData((s) => s.loading)
  const load = useDiffData((s) => s.load)

  const threadId = detail.thread.id
  const scopeKey = diffScope.kind === 'turn' ? diffScope.turnId : 'working'

  // debounced: working-tree diffs re-snapshot the whole tree
  useEffect(() => {
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

  // when a file is selected in the sidebar, render only its patch; otherwise the whole scope
  const files = useMemo(() => {
    const all = result?.files ?? []
    if (!selectedFile) return all
    const focused = all.filter((f) => f.path === selectedFile)
    return focused.length > 0 ? focused : all
  }, [result, selectedFile])

  const patch = useMemo(() => files.map((f) => f.patch).filter(Boolean).join('\n'), [files])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="drag-region flex h-13 items-center gap-2.5 border-b px-3">
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
        {selectedFile && (
          <button
            className="no-drag flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/15"
            onClick={() => setDiffSelectedFile(null)}
            title="Show all files"
          >
            {selectedFile.split('/').pop()} <X className="size-3" />
          </button>
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
        {result && !result.error && files.length > 0 && <PierreDiff patch={patch} view={diffView} />}
      </div>
    </div>
  )
}
