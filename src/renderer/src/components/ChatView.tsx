import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useServer } from '../state/serverStore'
import { useUi } from '../state/uiStore'
import { openThreadDiff } from '../state/rightPanelStore'
import { MessagesTimeline } from './MessagesTimeline'
import { Composer, type ComposerHandle } from './Composer'
import { Badge } from '@/components/ui/badge'
import { Folder, Paperclip } from 'lucide-react'
import { cn } from '@/lib/utils'
import { RightPanelToggle } from './RightPanel'
import { useAnimationReplay } from '../lib/useAnimationReplay'
import { makeWorkspaceFileDropHandlers } from '../lib/workspaceFileDrop'
import { ExpandedImageDialog } from './ExpandedImageDialog'
import type { ExpandedImagePreview } from './ExpandedImagePreview'

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

  // Image attachments: files dropped anywhere on the chat column funnel into
  // the composer; clicked images expand into the lightbox overlay.
  const composerRef = useRef<ComposerHandle | null>(null)
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false)
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null)
  const onExpandImage = useCallback((preview: ExpandedImagePreview) => setExpandedImage(preview), [])
  const closeExpandedImage = useCallback(() => setExpandedImage(null), [])
  const addDroppedFiles = useCallback((files: File[]) => {
    composerRef.current?.addDroppedFiles(files)
  }, [])
  const workspaceFileDropHandlers = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- addFiles reads the composer ref only when a drop event fires
      makeWorkspaceFileDropHandlers({ setDragActive: setIsWorkspaceFileDragActive, addFiles: addDroppedFiles }),
    [addDroppedFiles]
  )
  // a drag cancelled outside the window never fires dragleave — clear on dragend
  useEffect(() => {
    if (!isWorkspaceFileDragActive) return
    const clearWorkspaceFileDrag = (): void => setIsWorkspaceFileDragActive(false)
    window.addEventListener('dragend', clearWorkspaceFileDrag)
    return () => window.removeEventListener('dragend', clearWorkspaceFileDrag)
  }, [isWorkspaceFileDragActive])

  // The composer floats over the timeline; its live height becomes the timeline's
  // bottom inset so the last message can always scroll clear of it.
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null)
  const [composerHeight, setComposerHeight] = useState(0)
  useLayoutEffect(() => {
    if (!composerEl) return
    const update = (): void => {
      const next = Math.ceil(composerEl.getBoundingClientRect().height)
      if (next > 0) setComposerHeight((cur) => (cur === next ? cur : next))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(composerEl)
    return () => observer.disconnect()
  }, [composerEl])

  if (!detail) {
    return <div className="grid flex-1 place-items-center text-muted-foreground">Loading thread…</div>
  }

  const { thread } = detail
  const isHero = detail.turns.length === 0

  // diffs open in the right panel beside the conversation
  const openTurnDiff = (turnId: string): void => {
    openThreadDiff(threadId, { kind: 'turn', turnId })
  }

  return (
    <div key="chat" ref={paneRef} className="flex min-h-0 flex-1 flex-col duration-200 ease-out animate-in fade-in slide-in-from-left-4">
      {/* no bottom border — the header blends into the transcript */}
      <header className={cn('drag-region flex h-13 items-center justify-between pr-3.5 transition-[padding] duration-150 ease-out', sidebarCollapsed ? 'pl-[calc(var(--controls-left)+2rem)]' : 'pl-5')}>
        <div className="no-drag flex min-w-0 items-center gap-2 text-[13.5px]">
          {/* project / thread breadcrumb */}
          {project && (
            <>
              <Folder className="size-[14px] shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">{project.name}</span>
              <span className="shrink-0 text-muted-foreground/50">/</span>
            </>
          )}
          <span className="truncate font-semibold">{thread.title}</span>
        </div>
        <div className="no-drag flex items-center gap-1.5">
          {project && !project.isGitRepo && (
            <Badge className="h-auto rounded-md border-none bg-amber/12 px-2 py-0.5 text-[10.5px] font-normal text-amber">not a git repo</Badge>
          )}
          <RightPanelToggle />
        </div>
      </header>

      <div
        className="relative flex min-h-0 flex-1 flex-col"
        data-chat-workspace-drop-target="true"
        onDragEnter={workspaceFileDropHandlers.onDragEnter}
        onDragOver={workspaceFileDropHandlers.onDragOver}
        onDragLeave={workspaceFileDropHandlers.onDragLeave}
        onDrop={workspaceFileDropHandlers.onDrop}
      >
        {isWorkspaceFileDragActive && (
          <div
            className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
            data-chat-workspace-drop-overlay="true"
          >
            <div
              role="status"
              className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
            >
              <Paperclip className="size-4 text-primary" aria-hidden="true" />
              Drop files to attach
            </div>
          </div>
        )}

        <MessagesTimeline detail={detail} onOpenDiff={openTurnDiff} onImageExpand={onExpandImage} bottomInset={isHero ? 0 : composerHeight} />

        {/* composer overlay — content scrolls behind it and gets frosted by its blur;
            on an empty thread it centers as a hero prompt */}
        <div
          ref={setComposerEl}
          className={cn(
            'pointer-events-none absolute inset-x-0 z-20',
            isHero ? 'inset-y-0 flex flex-col justify-center' : 'bottom-0'
          )}
        >
          <div className="pointer-events-auto w-full">
            {isHero && (
              <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight text-foreground">
                What should we build in{' '}
                <span className="underline decoration-muted-foreground/50 decoration-dotted underline-offset-8">
                  {project?.name ?? thread.title}
                </span>
                ?
              </h1>
            )}
            <Composer ref={composerRef} thread={thread} onExpandImage={onExpandImage} />
          </div>
        </div>
      </div>

      {expandedImage && (
        <ExpandedImageDialog
          key={`${expandedImage.images[expandedImage.index]?.src ?? 'image'}:${expandedImage.index}`}
          preview={expandedImage}
          onClose={closeExpandedImage}
        />
      )}
    </div>
  )
}
