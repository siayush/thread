import { useEffect, useState } from 'react'
import { useServer } from '../state/serverStore'
import { isProjectExpanded, useUi } from '../state/uiStore'
import { useDiffSummary } from '../state/diffStore'
import { FileChangesView } from './FileChangesView'
import type { Project, ThreadSummary } from '@shared/domain'
import { ChevronDown, ChevronRight, Ellipsis, Folder, SquarePen, Plus, Search, FolderPlus, PanelLeft, Settings } from 'lucide-react'
import { SourceControlIcon } from '@/components/ui/source-control-icon'
import { relativeTime } from '../lib/format'
import { confirmDialog } from './ConfirmDialog'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'

/** Toggles the sidebar; shown in the sidebar header when open, in the main-pane headers when collapsed. */
export function SidebarToggle({ className }: { className?: string }): JSX.Element {
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn('no-drag text-muted-foreground', className)}
      title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      onClick={toggleSidebar}
    >
      <PanelLeft className="size-[15px]" />
    </Button>
  )
}

/** A thread is actively generating a response. The only status surfaced in the sidebar. */
function isGenerating(t: ThreadSummary): boolean {
  return t.status === 'running'
}

/** Inline rename field (window.prompt is not supported in Electron). */
function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (value: string) => void; onCancel: () => void }): JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <Input
      className="h-[22px] min-w-0 flex-1 rounded-md bg-background px-1.5 text-[12.5px] md:text-[12.5px]"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          const v = value.trim()
          if (v && v !== initial) onCommit(v)
          else onCancel()
        } else if (e.key === 'Escape') {
          onCancel()
        }
      }}
      onBlur={onCancel}
    />
  )
}

function ProjectRow({ project }: { project: Project }): JSX.Element {
  // select the stable array and filter in render — a filtering selector would
  // return a fresh array every snapshot and re-render on every store update
  const allThreads = useServer((s) => s.shell.threads)
  const threads = allThreads.filter((t) => t.projectId === project.id)
  // threads awaiting an approval are listed in the "Needs you" section instead; they return here once answered
  const visibleThreads = threads.filter((t) => !t.hasPendingApproval)
  const activeThreadId = useUi((s) => s.activeThreadId)
  const expandedMap = useUi((s) => s.expandedProjects)
  const toggleProject = useUi((s) => s.toggleProject)
  const openTab = useUi((s) => s.openTab)
  const openDiff = useUi((s) => s.openDiff)
  const dispatch = useServer((s) => s.dispatch)
  const changeCount = useDiffSummary((s) => s.byProject[project.id]?.files ?? 0)
  const fetchSummary = useDiffSummary((s) => s.fetch)
  const [renamingProject, setRenamingProject] = useState(false)
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)

  const expanded = isProjectExpanded(expandedMap, project.id)

  // threads in a project share one working tree — fetch its change count once per project,
  // refreshing whenever a thread's activity/status changes (a turn likely touched files)
  const anchorThreadId = threads[0]?.id
  const activityKey = threads.map((t) => `${t.id}:${t.latestActivityAt}:${t.status}`).join('|')
  useEffect(() => {
    if (expanded && anchorThreadId) fetchSummary(anchorThreadId, project.id, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, anchorThreadId, project.id, activityKey])

  const createThread = async (): Promise<void> => {
    const res = await dispatch({ type: 'thread.create', projectId: project.id })
    const threadId = res.data?.threadId as string | undefined
    if (threadId) {
      openTab(threadId)
      void dispatch({ type: 'thread.visit', threadId })
    }
  }

  const projectMenu = async (): Promise<void> => {
    const picked = await window.native.showContextMenu([
      { id: 'rename', label: 'Rename project' },
      { id: 'copy', label: 'Copy path' },
      { id: 'sep', type: 'separator' },
      { id: 'remove', label: 'Remove project', danger: true }
    ])
    if (picked === 'rename') {
      setRenamingProject(true)
    } else if (picked === 'copy') {
      void navigator.clipboard.writeText(project.folderPath)
    } else if (picked === 'remove') {
      const ok = await confirmDialog({
        title: `Remove "${project.name}"?`,
        description: 'Its threads will be hidden.',
        confirmLabel: 'Remove',
        destructive: true
      })
      if (ok) void dispatch({ type: 'project.remove', projectId: project.id })
    }
  }

  const openThread = (threadId: string): void => {
    openTab(threadId)
    void dispatch({ type: 'thread.visit', threadId })
  }

  const threadMenu = async (t: ThreadSummary): Promise<void> => {
    const picked = await window.native.showContextMenu([
      { id: 'rename', label: 'Rename thread' },
      { id: 'sep', type: 'separator' },
      { id: 'delete', label: 'Delete', danger: true }
    ])
    if (picked === 'rename') {
      setRenamingThreadId(t.id)
    } else if (picked === 'delete') {
      const ok = await confirmDialog({ title: 'Delete this thread?', confirmLabel: 'Delete', destructive: true })
      if (ok) void dispatch({ type: 'thread.delete', threadId: t.id })
    }
  }

  return (
    <div className="mb-0.5">
      <div
        className="group flex items-center gap-0.5 rounded-[7px] p-1 py-[3px] hover:bg-muted"
        onContextMenu={(e) => (e.preventDefault(), void projectMenu())}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-auto p-1 text-muted-foreground hover:bg-transparent dark:hover:bg-transparent"
          onClick={() => toggleProject(project.id)}
          aria-label="Toggle project"
        >
          {expanded ? <ChevronDown className="size-[13px]" /> : <ChevronRight className="size-[13px]" />}
        </Button>
        {renamingProject ? (
          <span className="flex min-w-0 flex-1 items-center gap-[7px] px-0.5 py-[3px]">
            <Folder className="size-[13px] shrink-0 text-muted-foreground" />
            <RenameInput
              initial={project.name}
              onCommit={(name) => {
                setRenamingProject(false)
                void dispatch({ type: 'project.rename', projectId: project.id, name })
              }}
              onCancel={() => setRenamingProject(false)}
            />
          </span>
        ) : (
          <Button
            variant="ghost"
            className="h-auto min-w-0 flex-1 justify-start gap-[7px] px-0.5 py-[3px] font-normal hover:bg-transparent dark:hover:bg-transparent"
            onClick={() => toggleProject(project.id)}
            title={project.folderPath}
          >
            <Folder className="size-[13px] shrink-0 text-muted-foreground" />
            <span className="truncate text-[12.5px] font-semibold text-foreground/90">{project.name}</span>
          </Button>
        )}
        <div className="flex items-center gap-1">
          <Badge
            variant="secondary"
            className="h-4 min-w-[17px] bg-muted px-1.5 text-[10px] text-muted-foreground group-hover:hidden"
          >
            {threads.length}
          </Badge>
          <Button
            variant="ghost"
            size="icon-xs"
            className="hidden text-muted-foreground group-hover:inline-flex"
            title="New thread"
            onClick={() => void createThread()}
          >
            <SquarePen className="size-[13px]" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="hidden text-muted-foreground group-hover:inline-flex"
            title="Project options"
            onClick={() => void projectMenu()}
          >
            <Ellipsis className="size-[13px]" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="my-0.5 mb-1 ml-3.5 flex flex-col gap-px border-l pl-2">
          {threads.length === 0 && <div className="px-2 py-1 text-[10.5px] text-foreground/35">No threads yet</div>}
          {visibleThreads.map((t) => {
            const generating = isGenerating(t)
            if (t.id === renamingThreadId) {
              return (
                <div key={t.id} className="flex h-[27px] items-center gap-[7px] rounded-md px-2">
                  <RenameInput
                    initial={t.title}
                    onCommit={(title) => {
                      setRenamingThreadId(null)
                      void dispatch({ type: 'thread.rename', threadId: t.id, title })
                    }}
                    onCancel={() => setRenamingThreadId(null)}
                  />
                </div>
              )
            }
            return (
              <div
                key={t.id}
                className={cn(
                  'group/thread flex h-[27px] items-center gap-[7px] rounded-md pr-1 hover:bg-muted',
                  t.id === activeThreadId && 'bg-primary/10 hover:bg-primary/10'
                )}
                onContextMenu={(e) => (e.preventDefault(), void threadMenu(t))}
              >
                <Button
                  variant="ghost"
                  className={cn(
                    'h-full min-w-0 flex-1 justify-start gap-[7px] rounded-md px-2 text-left text-[12.5px] font-normal text-muted-foreground group-hover/thread:text-foreground hover:bg-transparent dark:hover:bg-transparent',
                    t.id === activeThreadId && 'font-medium text-foreground'
                  )}
                  onClick={() => openThread(t.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                </Button>
                {generating ? (
                  <Spinner className="size-3 shrink-0 text-muted-foreground group-hover/thread:hidden" />
                ) : (
                  <span className={cn('text-[10px] text-foreground/35 tabular-nums group-hover/thread:hidden', t.id === activeThreadId && 'hidden')}>
                    {relativeTime(t.latestActivityAt)}
                  </span>
                )}
                {changeCount > 0 && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      'size-5 shrink-0 text-muted-foreground hover:bg-primary/10 hover:text-primary',
                      t.id === activeThreadId ? 'inline-flex' : 'hidden group-hover/thread:inline-flex'
                    )}
                    title="View file changes"
                    onClick={(e) => (e.stopPropagation(), openDiff(t.id))}
                  >
                    <SourceControlIcon className="size-[13px]" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    'size-5 text-muted-foreground hover:text-foreground',
                    t.id === activeThreadId ? 'inline-flex' : 'hidden group-hover/thread:inline-flex'
                  )}
                  title="Thread options"
                  onClick={() => void threadMenu(t)}
                >
                  <Ellipsis className="size-[13px]" />
                </Button>
              </div>
            )
          })}
          <Button
            variant="ghost"
            className="h-[27px] w-full justify-start gap-[7px] rounded-md px-2 text-xs font-normal text-muted-foreground dark:hover:bg-muted"
            onClick={() => void createThread()}
          >
            <Plus className="size-3" /> New thread
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Threads waiting on the user (a pending tool approval) surface here, above the
 * project tree. Answering the approval drops the thread back into its project.
 */
function NeedsYouSection(): JSX.Element | null {
  const threads = useServer((s) => s.shell.threads)
  const pending = threads.filter((t) => t.hasPendingApproval)
  const projects = useServer((s) => s.shell.projects)
  const dispatch = useServer((s) => s.dispatch)
  const openTab = useUi((s) => s.openTab)
  const activeThreadId = useUi((s) => s.activeThreadId)

  if (pending.length === 0) return null

  const openThread = (threadId: string): void => {
    openTab(threadId)
    void dispatch({ type: 'thread.visit', threadId })
  }

  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] font-medium tracking-wider text-amber uppercase">
        <span>Needs you</span>
        <Badge className="h-4 min-w-[17px] border-none bg-amber/15 px-1.5 text-[10px] text-amber">{pending.length}</Badge>
      </div>
      <div className="flex flex-col gap-px px-2">
        {pending.map((t) => {
          const project = projects.find((p) => p.id === t.projectId)
          return (
            <div
              key={t.id}
              className={cn(
                'group/thread flex h-[27px] items-center gap-[7px] rounded-md pr-2 hover:bg-muted',
                t.id === activeThreadId && 'bg-primary/10 hover:bg-primary/10'
              )}
            >
              <Button
                variant="ghost"
                className={cn(
                  'h-full min-w-0 flex-1 justify-start gap-[7px] rounded-md px-2 text-left text-[12.5px] font-normal text-muted-foreground group-hover/thread:text-foreground hover:bg-transparent dark:hover:bg-transparent',
                  t.id === activeThreadId && 'font-medium text-foreground'
                )}
                title={project ? `${project.name} — awaiting your approval` : 'Awaiting your approval'}
                onClick={() => openThread(t.id)}
              >
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                {project && <span className="shrink-0 text-[10px] text-foreground/35">{project.name}</span>}
              </Button>
              <span
                title="Awaiting approval"
                className="size-[7px] shrink-0 rounded-full bg-amber shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-amber)_20%,transparent)]"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Sidebar(): JSX.Element {
  const projects = useServer((s) => s.shell.projects)
  const dispatch = useServer((s) => s.dispatch)
  const openTab = useUi((s) => s.openTab)
  const setCommandPaletteOpen = useUi((s) => s.setCommandPaletteOpen)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)
  const threadView = useUi((s) => s.threadView)
  const activeThreadId = useUi((s) => s.activeThreadId)
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const diffMode = threadView === 'diff' && !!activeThreadId

  const addProject = async (): Promise<void> => {
    const folder = await window.native.pickFolder()
    if (!folder) return
    const res = await dispatch({ type: 'project.add', folderPath: folder })
    const projectId = res.data?.projectId as string | undefined
    if (projectId) {
      const created = await dispatch({ type: 'thread.create', projectId })
      const threadId = created.data?.threadId as string | undefined
      if (threadId) {
        openTab(threadId)
        void dispatch({ type: 'thread.visit', threadId })
      }
    }
  }

  return (
    <>
      {/* in-flow spacer: animates its width so the layout follows the panel's slide */}
      <div
        aria-hidden
        className={cn('shrink-0 transition-[width] duration-150 ease-out', collapsed ? 'w-0' : 'w-66')}
      />
      {/* fixed full-width panel slides off-canvas when collapsed — full width so its
          content doesn't reflow mid-slide; translate (not left) keeps the slide on
          the compositor instead of relayouting the sidebar tree every frame */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-10 flex w-66 flex-col overflow-hidden border-r bg-card transition-transform duration-150 ease-out will-change-transform',
          collapsed && '-translate-x-full'
        )}
      >
      <div className="drag-region flex h-13 items-center gap-1 pr-2 pl-19">
        <span className="no-drag flex flex-1 items-center gap-1.5 overflow-hidden">
          <span className="text-sm font-semibold tracking-tight text-foreground">Thread</span>
        </span>
        <SidebarToggle />
      </div>

      {diffMode ? (
        <FileChangesView />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col duration-200 ease-out animate-in fade-in slide-in-from-left-4">
          <Button
            variant="ghost"
            className="mx-2 my-1 h-auto justify-start gap-2 px-2 py-1.5 text-[13px] font-normal text-muted-foreground"
            onClick={() => setCommandPaletteOpen(true)}
          >
            <Search className="size-[13px]" />
            <span className="flex-1 text-left">Search</span>
            <Kbd>⌘K</Kbd>
          </Button>

          <NeedsYouSection />

          <div className="flex items-center justify-between px-3 pt-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground/75 uppercase">
            <span>Projects</span>
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title="Add project" onClick={() => void addProject()}>
                <FolderPlus className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {projects.length === 0 ? (
              <Button
                variant="ghost"
                className="mx-2 my-6 flex h-auto w-[calc(100%-16px)] flex-col items-center gap-2 rounded-xl border border-dashed border-input p-5 text-[12.5px] font-normal text-muted-foreground dark:hover:bg-muted"
                onClick={() => void addProject()}
              >
                <FolderPlus className="size-4" />
                Add your first project
              </Button>
            ) : (
              projects.map((p) => <ProjectRow key={p.id} project={p} />)
            )}
          </div>
        </div>
      )}

      <div className="mt-auto border-t p-2">
        <Button
          variant="ghost"
          className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-[13px] font-normal text-muted-foreground"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="size-[15px]" />
          <span className="flex-1 text-left">Settings</span>
        </Button>
      </div>
      </aside>
    </>
  )
}
