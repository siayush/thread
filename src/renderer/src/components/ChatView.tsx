import { useEffect } from 'react'
import { useServer } from '../state/serverStore'
import { useUi } from '../state/uiStore'
import { MessagesTimeline } from './MessagesTimeline'
import { Composer } from './Composer'
import { DiffPanel } from './DiffPanel'
import { FileView } from './FileView'
import { SourceControlIcon } from '@/components/ui/source-control-icon'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { SidebarToggle } from './Sidebar'
import { useDiffSummary } from '../state/diffStore'

export function ChatView({ threadId }: { threadId: string }): JSX.Element {
  const detail = useServer((s) => s.details[threadId])
  const openThread = useServer((s) => s.openThread)
  const closeThread = useServer((s) => s.closeThread)

  // keep a live subscription open only for the thread currently on screen
  useEffect(() => {
    openThread(threadId)
    return () => closeThread(threadId)
  }, [threadId, openThread, closeThread])

  const project = useServer((s) => (detail ? s.shell.projects.find((p) => p.id === detail.thread.projectId) : undefined))
  const threadView = useUi((s) => s.threadView)
  const openDiff = useUi((s) => s.openDiff)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const changeCount = useDiffSummary((s) => (detail ? s.byProject[detail.thread.projectId]?.files ?? 0 : 0))
  const summary = useDiffSummary((s) => (detail ? s.byProject[detail.thread.projectId] : undefined))
  const fetchSummary = useDiffSummary((s) => s.fetch)

  // keep the header's change count fresh for the active thread, even if its project row is collapsed
  const projectId = detail?.thread.projectId
  const activityKey = detail ? `${detail.thread.latestActivityAt}:${detail.thread.status}` : ''
  useEffect(() => {
    if (projectId) fetchSummary(threadId, projectId, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, projectId, activityKey])

  if (!detail) {
    return <div className="grid flex-1 place-items-center text-muted-foreground">Loading thread…</div>
  }

  const { thread } = detail

  const openTurnDiff = (turnId: string): void => {
    openDiff(threadId, { kind: 'turn', turnId })
  }

  // a chat file reference fills the main area with a read-only viewer; its header carries the back button
  if (threadView === 'file') {
    return (
      <div key="file" className="flex min-h-0 flex-1 flex-col duration-200 ease-out animate-in fade-in slide-in-from-right-4">
        <FileView threadId={threadId} />
      </div>
    )
  }

  // the diff view fills the main area; the sidebar (FileChangesView) carries the file list + back button
  if (threadView === 'diff') {
    return (
      <div key="diff" className="flex min-h-0 flex-1 flex-col duration-200 ease-out animate-in fade-in slide-in-from-right-4">
        <DiffPanel detail={detail} />
      </div>
    )
  }

  return (
    <div key="chat" className="flex min-h-0 flex-1 flex-col duration-200 ease-out animate-in fade-in slide-in-from-left-4">
      <header className={cn('drag-region flex h-13 items-center justify-between border-b pr-3.5 transition-[padding] duration-150 ease-out', sidebarCollapsed ? 'pl-19' : 'pl-5')}>
        <div className="no-drag flex min-w-0 items-center gap-2.5">
          {sidebarCollapsed && <SidebarToggle />}
          <span className="text-[13.5px] font-semibold whitespace-nowrap">{thread.title}</span>
        </div>
        <div className="no-drag flex items-center gap-1.5">
          {project && !project.isGitRepo && (
            <Badge className="h-auto rounded-md border-none bg-amber/12 px-2 py-0.5 text-[10.5px] font-normal text-amber">not a git repo</Badge>
          )}
          {changeCount > 0 && (
            <button
              className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11.5px] text-muted-foreground hover:border-primary/45 hover:bg-primary/10 hover:text-foreground"
              title="View file changes"
              onClick={() => openDiff(threadId, { kind: 'working' })}
            >
              <SourceControlIcon className="size-[13px]" />
              {changeCount} file{changeCount === 1 ? '' : 's'}
              {summary && (
                <>
                  {' '}
                  <span className="text-emerald tabular-nums">+{summary.additions}</span>{' '}
                  <span className="text-destructive tabular-nums">−{summary.deletions}</span>
                </>
              )}
            </button>
          )}
        </div>
      </header>

      <MessagesTimeline detail={detail} onOpenDiff={openTurnDiff} />
      <Composer thread={thread} />
    </div>
  )
}
