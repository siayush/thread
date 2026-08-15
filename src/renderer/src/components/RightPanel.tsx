import { useEffect, useRef, useState } from 'react'
import { useServer } from '../state/serverStore'
import { useUi } from '../state/uiStore'
import {
  DEFAULT_RIGHT_PANEL_WIDTH,
  EMPTY_PANEL,
  RIGHT_PANEL_MIN_WIDTH,
  rightPanelMaxWidth,
  useRightPanel,
  type RightPanelSurface
} from '../state/rightPanelStore'
import { DiffPanel } from './DiffPanel'
import { FilePreviewPanel } from './FilePreviewPanel'
import { PanelResizer } from './PanelResizer'
import { FileCode2, FolderTree, Maximize2, Minimize2, PanelRight, PanelRightClose, Plus, X } from 'lucide-react'
import { SourceControlIcon } from '@/components/ui/source-control-icon'
import { Button, buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

/**
 * Toggles the right panel. Inside the panel's own tab strip (`inPanel`) it
 * always shows; in the main-pane headers it appears only while the panel is
 * closed — so there is exactly one of these on screen, the way the sidebar
 * toggle works.
 */
export function RightPanelToggle({ className, inPanel }: { className?: string; inPanel?: boolean }): JSX.Element | null {
  const activeThreadId = useUi((s) => s.activeThreadId)
  const open = useRightPanel((s) => (activeThreadId ? (s.byThread[activeThreadId] ?? EMPTY_PANEL).isOpen : false))
  if (!activeThreadId) return null
  if (open && !inPanel) return null
  const Icon = open ? PanelRightClose : PanelRight
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn('no-drag text-muted-foreground', className)}
      title={`${open ? 'Hide' : 'Show'} panel  ⌘⇧E`}
      aria-label={open ? 'Hide panel' : 'Show panel'}
      aria-pressed={open}
      onClick={() => useRightPanel.getState().setOpen(activeThreadId, !open)}
    >
      <Icon className="size-[15px]" />
    </Button>
  )
}

function surfaceTitle(surface: RightPanelSurface): string {
  switch (surface.kind) {
    case 'diff':
      return 'Diff'
    case 'files':
      return 'Files'
    case 'file':
      return surface.path.slice(surface.path.lastIndexOf('/') + 1)
  }
}

function SurfaceIcon({ surface, className }: { surface: RightPanelSurface; className?: string }): JSX.Element {
  switch (surface.kind) {
    case 'diff':
      return <SourceControlIcon className={className} />
    case 'files':
      return <FolderTree className={className} />
    case 'file':
      return <FileCode2 className={className} />
  }
}

function Tab({ threadId, surface, active }: { threadId: string; surface: RightPanelSurface; active: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  // the strip scrolls horizontally — keep the active tab in view
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  const close = (): void => useRightPanel.getState().close(threadId, surface.id)

  const menu = async (): Promise<void> => {
    const picked = await window.native.showContextMenu([
      ...(surface.kind === 'file' ? [{ id: 'copy', label: 'Copy path' }, { id: 'sep', type: 'separator' as const }] : []),
      { id: 'close', label: 'Close' },
      { id: 'close-others', label: 'Close others' },
      { id: 'close-all', label: 'Close all' }
    ])
    if (picked === 'copy' && surface.kind === 'file') void navigator.clipboard.writeText(surface.path)
    else if (picked === 'close') close()
    else if (picked === 'close-others') useRightPanel.getState().closeOthers(threadId, surface.id)
    else if (picked === 'close-all') useRightPanel.getState().closeAll(threadId)
  }

  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={cn(
        'group/tab no-drag flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      )}
      title={surface.kind === 'file' ? surface.path : undefined}
      onClick={() => useRightPanel.getState().setActive(threadId, surface.id)}
      onAuxClick={(e) => {
        if (e.button === 1) close()
      }}
      onContextMenu={(e) => (e.preventDefault(), void menu())}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          useRightPanel.getState().setActive(threadId, surface.id)
        }
      }}
    >
      {/* the icon swaps to a close button on hover */}
      <span className="relative flex size-3.5 flex-none items-center justify-center">
        <SurfaceIcon surface={surface} className="size-3.5 transition-opacity group-hover/tab:opacity-0" />
        <button
          type="button"
          tabIndex={-1}
          className="absolute inset-0 flex items-center justify-center rounded-sm opacity-0 group-hover/tab:opacity-100 hover:bg-input"
          title="Close tab"
          aria-label={`Close ${surfaceTitle(surface)}`}
          onClick={(e) => (e.stopPropagation(), close())}
        >
          <X className="size-3" />
        </button>
      </span>
      <span className="max-w-40 truncate">{surfaceTitle(surface)}</span>
    </div>
  )
}

/** The "+" dropdown listing the surfaces that can be opened. */
function AddSurfaceMenu({ threadId }: { threadId: string }): JSX.Element {
  const [open, setOpen] = useState(false)

  const item = (kind: 'files' | 'diff', icon: JSX.Element, label: string): JSX.Element => (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-foreground/90 outline-none hover:bg-muted focus-visible:bg-muted"
      onClick={() => {
        setOpen(false)
        useRightPanel.getState().open(threadId, kind)
      }}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* React 18 strips `ref` on plain function components, so style the native
          trigger instead of render-merging <Button> (see ModelPicker) */}
      <PopoverTrigger
        aria-label="Open a surface"
        className={cn(buttonVariants({ variant: 'ghost', size: 'icon-xs' }), 'no-drag text-muted-foreground')}
      >
        <Plus className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-44 gap-0 p-1.5">
        {item('files', <FolderTree className="size-4 text-muted-foreground" />, 'Files')}
        {item('diff', <SourceControlIcon className="size-4 text-muted-foreground" />, 'Diff')}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Launcher shown while the panel is open with no surfaces — keyboard-first:
 * D opens the diff, F the file browser.
 */
function EmptyState({ threadId }: { threadId: string }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return
      const key = e.key.toLowerCase()
      if (key !== 'd' && key !== 'f') return
      e.preventDefault()
      useRightPanel.getState().open(threadId, key === 'd' ? 'diff' : 'files')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [threadId])

  const launch = (kind: 'diff' | 'files', icon: JSX.Element, label: string, hint: string): JSX.Element => (
    <Button
      variant="ghost"
      className="h-auto w-full justify-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-[12.5px] font-normal text-muted-foreground hover:border-primary/45 hover:text-foreground"
      onClick={() => useRightPanel.getState().open(threadId, kind)}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      <Kbd>{hint}</Kbd>
    </Button>
  )

  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex w-full max-w-60 flex-col gap-2">
        {launch('diff', <SourceControlIcon className="size-3.5" />, 'Diff', 'D')}
        {launch('files', <FolderTree className="size-3.5" />, 'Files', 'F')}
      </div>
    </div>
  )
}

/**
 * The tabbed workspace docked opposite the thread list: threads left,
 * conversation centre, diff/files right — a per-thread tab strip over a
 * surface switch.
 */
export function RightPanel(): JSX.Element | null {
  const activeThreadId = useUi((s) => s.activeThreadId)
  const panel = useRightPanel((s) => (activeThreadId ? s.byThread[activeThreadId] : undefined)) ?? EMPTY_PANEL
  const width = useRightPanel((s) => s.width)
  const resizing = useRightPanel((s) => s.resizing)
  const setWidth = useRightPanel((s) => s.setWidth)
  const setResizing = useRightPanel((s) => s.setResizing)
  const maximized = useRightPanel((s) => s.maximizedThreadId === activeThreadId && panel.isOpen)
  const detail = useServer((s) => (activeThreadId ? s.details[activeThreadId] : undefined))
  const projectId = useServer((s) => s.shell.threads.find((t) => t.id === activeThreadId)?.projectId)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const sidebarWidth = useUi((s) => s.sidebarWidth)

  const open = panel.isOpen

  // Esc hides the panel (matching the old full-screen diff view), unless focus
  // is in a field — a dialog or the composer owns Esc there
  useEffect(() => {
    if (!activeThreadId || !open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return
      useRightPanel.getState().setOpen(activeThreadId, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeThreadId, open])

  if (!activeThreadId || !projectId) return null

  const active = panel.surfaces.find((sf) => sf.id === panel.activeSurfaceId) ?? null

  return (
    <>
      {/* in-flow spacer: animates its width so the main pane follows the panel's slide */}
      <div
        aria-hidden
        className={cn('shrink-0', !resizing && 'transition-[width] duration-150 ease-out')}
        style={{ width: open ? width : 0 }}
      />
      {/* fixed full-width panel slides off-canvas when closed, so its content
          doesn't reflow mid-slide; translate keeps the slide on the compositor.
          maximized pins the left edge to the sidebar instead of sizing by width,
          covering the chat entirely */}
      <aside
        className={cn(
          'fixed inset-y-0 right-0 z-10 flex flex-col overflow-hidden border-l bg-card transition-[transform,left] duration-150 ease-out will-change-transform',
          !open && 'translate-x-full'
        )}
        style={maximized ? { left: sidebarCollapsed ? 0 : sidebarWidth } : { width }}
      >
        {/* no divider under the strip — the tab row blends into the panel */}
        <div className="drag-region flex h-13 shrink-0 items-center gap-1 px-2">
          <div role="tablist" aria-label="Panel tabs" className="no-drag flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
            {panel.surfaces.map((sf) => (
              <Tab key={sf.id} threadId={activeThreadId} surface={sf} active={sf.id === panel.activeSurfaceId} />
            ))}
          </div>
          {/* the "+" rides with the tabs; the gap before the window controls is the drag region */}
          <AddSurfaceMenu threadId={activeThreadId} />
          <div className="min-w-2 flex-1" />
          <Button
            variant="ghost"
            size="icon-xs"
            className="no-drag text-muted-foreground"
            title={maximized ? 'Restore panel' : 'Maximize panel'}
            aria-label={maximized ? 'Restore panel' : 'Maximize panel'}
            aria-pressed={maximized}
            onClick={() => useRightPanel.getState().setMaximized(activeThreadId, !maximized)}
          >
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
          <RightPanelToggle inPanel />
        </div>

        {/* flex, not block: DiffPanel sizes itself with flex-1/min-h-0, which
            only constrains inside a flex parent — block would let it grow past
            the panel and clip, leaving the diff unscrollable */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {active === null ? (
            <EmptyState threadId={activeThreadId} />
          ) : active.kind === 'diff' ? (
            detail ? (
              <DiffPanel detail={detail} />
            ) : (
              <div className="p-5 text-center text-[12.5px] text-muted-foreground">Loading thread…</div>
            )
          ) : (
            <FilePreviewPanel threadId={activeThreadId} projectId={projectId} surface={active} active={open} />
          )}
        </div>
      </aside>
      {open && !maximized && (
        <PanelResizer
          side="right"
          label="panel"
          width={width}
          min={RIGHT_PANEL_MIN_WIDTH}
          max={rightPanelMaxWidth()}
          resizing={resizing}
          setWidth={setWidth}
          setResizing={setResizing}
          onReset={() => setWidth(DEFAULT_RIGHT_PANEL_WIDTH)}
        />
      )}
    </>
  )
}
