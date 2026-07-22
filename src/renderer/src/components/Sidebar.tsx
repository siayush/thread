import { useEffect, useState } from 'react'
import { useServer } from '../state/serverStore'
import { isProjectExpanded, useUi } from '../state/uiStore'
import { useDiffSummary } from '../state/diffStore'
import { FileChangesView } from './FileChangesView'
import type { Project, ThreadSummary } from '@shared/domain'
import { ChevronDown, ChevronRight, Ellipsis, Folder, SquarePen, Plus, Search, FolderPlus } from 'lucide-react'
import { SourceControlIcon } from '@/components/ui/source-control-icon'
import { relativeTime } from '../lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'

/** A thread is actively generating a response. The only status surfaced in the sidebar. */
function isGenerating(t: ThreadSummary): boolean {
  return t.status === 'running' || t.status === 'starting'
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
  const threads = useServer((s) => s.shell.threads.filter((t) => t.projectId === project.id && !t.archivedAt))
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
      if (window.confirm(`Remove "${project.name}"? Its threads will be hidden.`)) void dispatch({ type: 'project.remove', projectId: project.id })
    }
  }

  const openThread = (threadId: string): void => {
    openTab(threadId)
    void dispatch({ type: 'thread.visit', threadId })
  }

  const threadMenu = async (t: ThreadSummary): Promise<void> => {
    const picked = await window.native.showContextMenu([
      { id: 'rename', label: 'Rename thread' },
      { id: 'archive', label: 'Archive' },
      { id: 'sep', type: 'separator' },
      { id: 'delete', label: 'Delete', danger: true }
    ])
    if (picked === 'rename') {
      setRenamingThreadId(t.id)
    } else if (picked === 'archive') {
      void dispatch({ type: 'thread.archive', threadId: t.id })
    } else if (picked === 'delete') {
      if (window.confirm('Delete this thread?')) void dispatch({ type: 'thread.delete', threadId: t.id })
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
            <Folder size={13} className="shrink-0 text-muted-foreground" />
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
          {threads.map((t) => {
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
                {t.hasPendingApproval ? (
                  <span
                    title="Awaiting approval"
                    className="size-[7px] shrink-0 rounded-full bg-amber shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-amber)_20%,transparent)] group-hover/thread:hidden"
                  />
                ) : generating ? (
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

export function Sidebar(): JSX.Element {
  const projects = useServer((s) => s.shell.projects)
  const dispatch = useServer((s) => s.dispatch)
  const openTab = useUi((s) => s.openTab)
  const setCommandPaletteOpen = useUi((s) => s.setCommandPaletteOpen)
  const threadView = useUi((s) => s.threadView)
  const activeThreadId = useUi((s) => s.activeThreadId)
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
    <aside className="flex w-66 shrink-0 flex-col overflow-hidden border-r bg-card">
      <div className="drag-region flex h-13 items-center gap-1 pr-3 pl-19">
        <span className="no-drag flex items-center gap-1.5 overflow-hidden">
          <span className="text-sm font-semibold tracking-tight text-foreground">Thread</span>
        </span>
      </div>

      {diffMode ? (
        <FileChangesView />
      ) : (
        <>
          <Button
            variant="ghost"
            className="mx-2 my-1 h-auto justify-start gap-2 px-2 py-1.5 text-[13px] font-normal text-muted-foreground"
            onClick={() => setCommandPaletteOpen(true)}
          >
            <Search className="size-[13px]" />
            <span className="flex-1 text-left">Search</span>
            <Kbd>⌘K</Kbd>
          </Button>

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
        </>
      )}
    </aside>
  )
}
