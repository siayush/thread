import { memo, useEffect, useMemo, useRef } from 'react'
import type { DirEntry } from '@shared/files'
import { ChevronRight, File, Folder } from 'lucide-react'
import { useUi, useComposerDraft } from '../state/uiStore'
import { useServer } from '../state/serverStore'
import { useExplorer } from '../state/explorerStore'
import { cn } from '@/lib/utils'

/** What every row needs and nothing more; threaded down the recursion as one prop. */
interface TreeCtx {
  projectId: string
  threadId: string
  /** false while the dock is closed — the tree stays mounted but stops reading the disk */
  active: boolean
}

/** The hairline stack that carries a row's depth — one 12px step per level;
 *  at that width a guide reads as depth where a dot would not. */
function Guides({ depth }: { depth: number }): JSX.Element | null {
  if (depth === 0) return null
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="relative w-3 shrink-0 self-stretch before:absolute before:inset-y-0 before:left-[5px] before:w-px before:bg-border before:content-['']"
        />
      ))}
    </>
  )
}

function Note({ depth, children, tone }: { depth: number; children: React.ReactNode; tone?: 'error' }): JSX.Element {
  return (
    <div className="flex h-[27px] items-center gap-1.5 px-1.5">
      <Guides depth={depth} />
      <span className={cn('truncate text-[11.5px]', tone === 'error' ? 'text-amber' : 'text-foreground/35')}>{children}</span>
    </div>
  )
}

/** Memoized: a turn ticks activity on every tool call, and a wide-open tree is a lot of rows. */
const Row = memo(function Row({ ctx, entry, depth }: { ctx: TreeCtx; entry: DirEntry; depth: number }): JSX.Element {
  const isDir = entry.kind === 'dir'
  // a boolean, not the project's whole expansion map: that object changes identity
  // on every toggle and would re-render every row in the tree
  const expanded = useUi((s) => isDir && !!s.expandedDirs[ctx.projectId]?.[entry.path])
  const toggleDir = useUi((s) => s.toggleDir)
  const openFile = useUi((s) => s.openFile)
  const setThreadView = useUi((s) => s.setThreadView)
  const threadView = useUi((s) => s.threadView)
  const fileTarget = useUi((s) => s.fileTarget)
  const loadDir = useExplorer((s) => s.loadDir)

  const selected = !isDir && threadView === 'file' && fileTarget?.path === entry.path

  const open = (): void => {
    if (!isDir) {
      openFile(ctx.threadId, { path: entry.path, line: null })
      return
    }
    toggleDir(ctx.projectId, entry.path)
    // re-read on the way open: the listing may have been cached before the agent touched it
    if (!expanded) loadDir(ctx.projectId, entry.path, true)
  }

  const menu = async (): Promise<void> => {
    const picked = await window.native.showContextMenu([
      ...(isDir ? [] : [{ id: 'open', label: 'Open' }, { id: 'insert', label: 'Insert into message' }]),
      { id: 'copy', label: 'Copy relative path' }
    ])
    if (picked === 'open') {
      open()
    } else if (picked === 'insert') {
      const draft = useComposerDraft.getState().drafts[ctx.threadId] ?? ''
      useComposerDraft.getState().set(ctx.threadId, draft ? `${draft.replace(/\s+$/, '')} ${entry.path} ` : `${entry.path} `)
      // the composer only exists in the chat view — inserting anywhere else would look like nothing happened
      setThreadView('chat')
    } else if (picked === 'copy') {
      void navigator.clipboard.writeText(entry.path)
    }
  }

  return (
    <>
      <div
        role="treeitem"
        // the levels render flat (no nested groups), so each row states its own depth
        aria-level={depth + 1}
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={selected}
        // roving tabindex: the tree is one tab stop and hands focus to a row itself
        tabIndex={-1}
        data-path={entry.path}
        title={entry.path}
        className={cn(
          'group/row flex h-[27px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-1.5 pl-1.5 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
          selected && 'bg-primary/10 hover:bg-primary/10'
        )}
        onClick={open}
        onContextMenu={(e) => (e.preventDefault(), void menu())}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            open()
          } else if (isDir && ((e.key === 'ArrowRight' && !expanded) || (e.key === 'ArrowLeft' && expanded))) {
            e.preventDefault()
            open()
          }
        }}
      >
        <Guides depth={depth} />
        {isDir ? (
          <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground/70 transition-transform duration-100', expanded && 'rotate-90')} />
        ) : (
          <span aria-hidden className="w-3 shrink-0" />
        )}
        {isDir ? (
          <Folder className="size-[13px] shrink-0 text-muted-foreground" />
        ) : (
          <File className={cn('size-[13px] shrink-0 text-muted-foreground', entry.ignored && 'opacity-45')} />
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px]',
            selected ? 'text-foreground' : 'text-foreground/85',
            entry.ignored && 'text-muted-foreground'
          )}
        >
          {entry.name}
        </span>
        {isDir && !expanded && entry.childCount !== undefined && (
          <span className="shrink-0 font-mono text-[10px] text-foreground/30 tabular-nums">
            {entry.childCount}
            {entry.childCountCapped && '+'}
          </span>
        )}
      </div>
      {expanded && <DirLevel ctx={ctx} path={entry.path} depth={depth + 1} />}
    </>
  )
})

/** One directory's children. Mounts only when its folder is open, so listings stay lazy. */
function DirLevel({ ctx, path, depth }: { ctx: TreeCtx; path: string; depth: number }): JSX.Element {
  const loadDir = useExplorer((s) => s.loadDir)
  const entries = useExplorer((s) => s.byProject[ctx.projectId]?.entries[path])
  const loading = useExplorer((s) => !!s.byProject[ctx.projectId]?.loading[path])
  const error = useExplorer((s) => s.byProject[ctx.projectId]?.errors[path])

  useEffect(() => {
    if (ctx.active) loadDir(ctx.projectId, path)
  }, [ctx.projectId, ctx.active, path, loadDir])

  // the first render lands before the load effect runs, so "no entries yet" reads as loading
  if (!entries) return error && !loading ? <Note depth={depth} tone="error">{error}</Note> : <Note depth={depth}>Loading…</Note>
  if (error && entries.length === 0) return <Note depth={depth} tone="error">{error}</Note>
  if (entries.length === 0) return <Note depth={depth}>Empty</Note>
  return (
    <>
      {entries.map((e) => (
        <Row key={e.path} ctx={ctx} entry={e} depth={depth} />
      ))}
    </>
  )
}

/**
 * The project's working tree, one lazily-read level at a time. Rows borrow the
 * changes list's metrics (27px, same type scale) so the two panels read as one
 * component family.
 */
export function FileTreeView({ projectId, threadId, active }: { projectId: string; threadId: string; active: boolean }): JSX.Element {
  const refresh = useExplorer((s) => s.refresh)
  const thread = useServer((s) => s.shell.threads.find((t) => t.id === threadId))
  const ctx = useMemo<TreeCtx>(() => ({ projectId, threadId, active }), [projectId, threadId, active])
  /** last row the user focused, so tabbing back into the tree lands where they left it */
  const focusedPath = useRef<string | null>(null)

  // a turn that creates or deletes files should show up without a manual reopen;
  // thread activity ticks on every tool call, and the store debounces the re-read.
  // reopening the dock re-runs this too, which is what catches up a hidden tree.
  const activityKey = thread ? `${thread.latestActivityAt}:${thread.status}` : ''
  useEffect(() => {
    if (active && activityKey) refresh(projectId)
  }, [projectId, activityKey, active, refresh])

  // files added or removed outside the app produce no thread activity — re-read on focus
  useEffect(() => {
    if (!active) return
    const onFocus = (): void => refresh(projectId)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectId, active, refresh])

  const rows = (tree: HTMLElement): HTMLElement[] => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')]

  // ↑/↓ walk the flattened tree; the rows themselves handle ←/→ and Enter
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = rows(e.currentTarget)
    const at = items.indexOf(e.target as HTMLElement)
    if (at === -1) return
    e.preventDefault()
    items[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
  }

  // focus bubbles, so one handler both remembers the current row and forwards
  // focus off the tree container onto a row
  const onFocus = (e: React.FocusEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) {
      focusedPath.current = (e.target as HTMLElement).dataset.path ?? null
      return
    }
    const items = rows(e.currentTarget)
    ;(items.find((el) => el.dataset.path === focusedPath.current) ?? items[0])?.focus()
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-3">
      <div
        role="tree"
        aria-label="Project files"
        tabIndex={0}
        className="flex flex-col px-1.5 pt-1.5 outline-none"
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        <DirLevel ctx={ctx} path="" depth={0} />
      </div>
    </div>
  )
}
