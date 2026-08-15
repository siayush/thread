import { useEffect } from 'react'
import { useServer } from '../state/serverStore'
import { useUi } from '../state/uiStore'
import { openThreadDiff } from '../state/rightPanelStore'
import { MessagesTimeline } from './MessagesTimeline'
import { Composer } from './Composer'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { RightPanelToggle } from './RightPanel'
import { useAnimationReplay } from '../lib/useAnimationReplay'

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
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const paneRef = useAnimationReplay<HTMLDivElement>(useUi((s) => s.settingsOpen))

  if (!detail) {
    return <div className="grid flex-1 place-items-center text-muted-foreground">Loading thread…</div>
  }

  const { thread } = detail

  // diffs open in the right panel beside the conversation, t3-code style
  const openTurnDiff = (turnId: string): void => {
    openThreadDiff(threadId, { kind: 'turn', turnId })
  }

  return (
    <div key="chat" ref={paneRef} className="flex min-h-0 flex-1 flex-col duration-200 ease-out animate-in fade-in slide-in-from-left-4">
      <header className={cn('drag-region flex h-13 items-center justify-between border-b pr-3.5 transition-[padding] duration-150 ease-out', sidebarCollapsed ? 'pl-[calc(var(--controls-left)+2rem)]' : 'pl-5')}>
        <div className="no-drag flex min-w-0 items-center gap-2.5">
          <span className="text-[13.5px] font-semibold whitespace-nowrap">{thread.title}</span>
        </div>
        <div className="no-drag flex items-center gap-1.5">
          {project && !project.isGitRepo && (
            <Badge className="h-auto rounded-md border-none bg-amber/12 px-2 py-0.5 text-[10.5px] font-normal text-amber">not a git repo</Badge>
          )}
          <RightPanelToggle />
        </div>
      </header>

      <MessagesTimeline detail={detail} onOpenDiff={openTurnDiff} />
      <Composer thread={thread} />
    </div>
  )
}
