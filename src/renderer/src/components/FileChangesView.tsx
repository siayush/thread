import { useEffect } from 'react'
import { useServer } from '../state/serverStore'
import { useUi } from '../state/uiStore'
import { useDiffData, useDiffSummary } from '../state/diffStore'
import type { DiffAction, DiffFile } from '@shared/diff'
import { Minus, Plus, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SourceControlIcon } from '@/components/ui/source-control-icon'

const STATUS_LETTER: Record<DiffFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }
const STATUS_COLOR: Record<DiffFile['status'], string> = {
  added: 'text-emerald',
  modified: 'text-amber',
  deleted: 'text-destructive',
  renamed: 'text-violet'
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}
function nameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

function FileRow({
  file,
  active,
  onSelect,
  onAction
}: {
  file: DiffFile
  active: boolean
  onSelect: () => void
  onAction: ((action: DiffAction) => void) | null
}): JSX.Element {
  const dir = dirOf(file.path)
  return (
    <div
      className={cn(
        'group/file flex h-[27px] cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-muted',
        active && 'bg-primary/10 hover:bg-primary/10'
      )}
      onClick={onSelect}
      title={file.path}
    >
      <span className={cn('min-w-0 shrink truncate text-[12.5px]', active ? 'text-foreground' : 'text-foreground/85')}>{nameOf(file.path)}</span>
      {dir && <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">{dir}</span>}
      {!dir && <span className="flex-1" />}
      {onAction && (
        <span className="hidden flex-none items-center gap-0.5 group-hover/file:flex">
          {file.staged ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-[18px] text-muted-foreground hover:bg-input hover:text-foreground"
              title="Unstage"
              onClick={(e) => (e.stopPropagation(), onAction('unstage'))}
            >
              <Minus className="size-3" />
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-[18px] text-muted-foreground hover:bg-input hover:text-foreground"
                title="Discard changes"
                onClick={(e) => (e.stopPropagation(), onAction('discard'))}
              >
                <Undo2 className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-[18px] text-muted-foreground hover:bg-input hover:text-foreground"
                title="Stage"
                onClick={(e) => (e.stopPropagation(), onAction('stage'))}
              >
                <Plus className="size-3" />
              </Button>
            </>
          )}
        </span>
      )}
      <span className={cn('w-3.5 flex-none text-center font-mono text-[11px] font-semibold group-hover/file:hidden', STATUS_COLOR[file.status])}>
        {STATUS_LETTER[file.status]}
      </span>
    </div>
  )
}

function Group({
  label,
  files,
  bulkActions,
  selected,
  onSelect,
  onAction
}: {
  label: string
  files: DiffFile[]
  bulkActions: { icon: JSX.Element; title: string; action: DiffAction }[]
  selected: string | null
  onSelect: (path: string) => void
  onAction: ((action: DiffAction, paths: string[]) => void) | null
}): JSX.Element | null {
  if (files.length === 0) return null
  return (
    <div className="group/grp py-1">
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase select-none">
        <span>{label}</span>
        {onAction && bulkActions.length > 0 && (
          <span className="ml-1 hidden items-center gap-0.5 group-hover/grp:inline-flex">
            {bulkActions.map((bulk) => (
              <Button
                key={bulk.action}
                variant="ghost"
                size="icon-xs"
                className="size-[18px] text-muted-foreground hover:text-foreground"
                title={bulk.title}
                onClick={() =>
                  onAction(
                    bulk.action,
                    files.map((f) => f.path)
                  )
                }
              >
                {bulk.icon}
              </Button>
            ))}
          </span>
        )}
        <span className="ml-auto rounded-full bg-accent px-1.5 text-[10px] font-normal tracking-normal tabular-nums">{files.length}</span>
      </div>
      <div className="flex flex-col px-1">
        {files.map((f) => (
          <FileRow
            key={`${f.staged ? 's' : 'u'}:${f.path}`}
            file={f}
            active={selected === f.path}
            onSelect={() => onSelect(f.path)}
            onAction={onAction ? (action) => onAction(action, [f.path]) : null}
          />
        ))}
      </div>
    </div>
  )
}

export function FileChangesView(): JSX.Element {
  const activeThreadId = useUi((s) => s.activeThreadId)
  const setThreadView = useUi((s) => s.setThreadView)
  const selectedFile = useUi((s) => s.diffSelectedFile)
  const setDiffSelectedFile = useUi((s) => s.setDiffSelectedFile)
  const detail = useServer((s) => (activeThreadId ? s.details[activeThreadId] : undefined))
  const fileAction = useServer((s) => s.fileAction)
  const result = useDiffData((s) => s.result)
  const reload = useDiffData((s) => s.reload)
  const refreshSummary = useDiffSummary((s) => s.fetch)

  const projectId = detail?.thread.projectId
  const isWorking = result?.scope.kind === 'working'

  // Esc closes the diff view and returns to the thread list + chat
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setThreadView('chat')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setThreadView])

  const runAction = async (action: DiffAction, paths: string[]): Promise<void> => {
    if (!activeThreadId || paths.length === 0) return
    if (action === 'discard') {
      const what = paths.length === 1 ? `changes to ${nameOf(paths[0])}` : `changes in ${paths.length} files`
      if (!window.confirm(`Discard ${what}? This cannot be undone.`)) return
    }
    const res = await fileAction(activeThreadId, action, paths)
    if (!res.ok && res.error) window.alert(res.error)
    reload()
    if (projectId) refreshSummary(activeThreadId, projectId, true)
  }

  const files = result?.files ?? []
  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => !f.staged)

  return (
    <div className="flex min-h-0 flex-1 flex-col duration-200 ease-out animate-in fade-in slide-in-from-right-4">
      {detail && (
        <div className="mx-2 mt-1 mb-1 flex items-center gap-2 rounded-lg border bg-muted px-2.5 py-1.5">
          <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">{detail.thread.title}</span>
        </div>
      )}

      <div className="flex items-center px-3.5 pt-2 pb-0.5 text-[11px] font-medium tracking-wider text-muted-foreground/75 uppercase">
        <span>File changes</span>
        {result && !result.error && (
          <span className="ml-auto text-[11px] tracking-normal normal-case tabular-nums">
            <span className="text-emerald">+{result.additions}</span> <span className="text-destructive">−{result.deletions}</span>
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {result?.error && <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">{result.error}</div>}
        {result && !result.error && files.length === 0 && <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">No changes.</div>}
        {isWorking ? (
          <>
            <Group
              label="Staged Changes"
              files={staged}
              bulkActions={[{ icon: <Minus className="size-3" />, title: 'Unstage All Changes', action: 'unstage' }]}
              selected={selectedFile}
              onSelect={setDiffSelectedFile}
              onAction={(action, paths) => void runAction(action, paths)}
            />
            <Group
              label="Changes"
              files={unstaged}
              bulkActions={[
                { icon: <Undo2 className="size-3" />, title: 'Discard All Changes', action: 'discard' },
                { icon: <Plus className="size-3" />, title: 'Stage All Changes', action: 'stage' }
              ]}
              selected={selectedFile}
              onSelect={setDiffSelectedFile}
              onAction={(action, paths) => void runAction(action, paths)}
            />
          </>
        ) : (
          <Group label="Files" files={files} bulkActions={[]} selected={selectedFile} onSelect={setDiffSelectedFile} onAction={null} />
        )}
      </div>
    </div>
  )
}
