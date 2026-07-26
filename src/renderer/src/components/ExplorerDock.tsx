import { useServer } from '../state/serverStore'
import { DEFAULT_EXPLORER_WIDTH, EXPLORER_MAX_WIDTH, EXPLORER_MIN_WIDTH, useUi } from '../state/uiStore'
import { FileTreeView } from './FileTreeView'
import { PanelResizer } from './PanelResizer'
import { FolderTree, PanelRight, PanelRightClose } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * Toggles the explorer dock. Inside the dock's own header (`inDock`) it always
 * shows; in the main-pane headers it appears only while the dock is closed — so
 * there is exactly one of these on screen, the way the sidebar toggle works.
 */
export function ExplorerToggle({ className, inDock }: { className?: string; inDock?: boolean }): JSX.Element | null {
  const open = useUi((s) => s.explorerOpen)
  const toggleExplorer = useUi((s) => s.toggleExplorer)
  if (open && !inDock) return null
  const Icon = open ? PanelRightClose : PanelRight
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn('no-drag text-muted-foreground', className)}
      title={`${open ? 'Hide' : 'Show'} explorer  ⌘⇧E`}
      aria-label={open ? 'Hide explorer' : 'Show explorer'}
      aria-pressed={open}
      onClick={toggleExplorer}
    >
      <Icon className="size-[15px]" />
    </Button>
  )
}

/** Drag handle on the dock's left edge. */
function ExplorerResizer(): JSX.Element | null {
  const open = useUi((s) => s.explorerOpen)
  const width = useUi((s) => s.explorerWidth)
  const resizing = useUi((s) => s.explorerResizing)
  const setExplorerWidth = useUi((s) => s.setExplorerWidth)
  const setExplorerResizing = useUi((s) => s.setExplorerResizing)

  if (!open) return null

  return (
    <PanelResizer
      side="right"
      label="explorer"
      width={width}
      min={EXPLORER_MIN_WIDTH}
      max={EXPLORER_MAX_WIDTH}
      resizing={resizing}
      setWidth={setExplorerWidth}
      setResizing={setExplorerResizing}
      onReset={() => setExplorerWidth(DEFAULT_EXPLORER_WIDTH)}
    />
  )
}

/**
 * The file explorer, docked opposite the thread list: threads left,
 * conversation centre, code right. Scoped to the active thread's project — the
 * tree follows the conversation rather than listing every project's root.
 */
export function ExplorerDock(): JSX.Element | null {
  const activeThreadId = useUi((s) => s.activeThreadId)
  const open = useUi((s) => s.explorerOpen)
  const width = useUi((s) => s.explorerWidth)
  const resizing = useUi((s) => s.explorerResizing)
  // read the project off the shell snapshot, not the thread detail: the detail
  // only exists while the thread's subscription is live
  const projectId = useServer((s) => s.shell.threads.find((t) => t.id === activeThreadId)?.projectId)
  const project = useServer((s) => s.shell.projects.find((p) => p.id === projectId))

  if (!activeThreadId || !projectId) return null

  return (
    <>
      {/* in-flow spacer: animates its width so the main pane follows the dock's slide */}
      <div
        aria-hidden
        className={cn('shrink-0', !resizing && 'transition-[width] duration-150 ease-out')}
        style={{ width: open ? width : 0 }}
      />
      {/* fixed full-width panel slides off-canvas when closed, so its content
          doesn't reflow mid-slide; translate keeps the slide on the compositor */}
      <aside
        className={cn(
          'fixed inset-y-0 right-0 z-10 flex flex-col overflow-hidden border-l bg-card transition-transform duration-150 ease-out will-change-transform',
          !open && 'translate-x-full'
        )}
        style={{ width }}
      >
        <div className="drag-region flex h-13 shrink-0 items-center gap-2 border-b pr-2 pl-3">
          <FolderTree className="size-[13px] shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-foreground/90" title={project?.folderPath}>
            {project?.name}
          </span>
          <ExplorerToggle inDock className="ml-auto" />
        </div>
        {/* the panel stays mounted while closed so the slide-out isn't empty, but
            `active` stops it reading the disk for a tree nobody can see */}
        <FileTreeView projectId={projectId} threadId={activeThreadId} active={open} />
      </aside>
      <ExplorerResizer />
    </>
  )
}
