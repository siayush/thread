import { useMemo } from 'react'
import { useServer } from '../state/serverStore'
import { useUi } from '../state/uiStore'
import { FolderPlus, SquarePen, MessageCircle, type LucideIcon } from 'lucide-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'

interface Cmd {
  id: string
  label: string
  hint?: string
  icon: LucideIcon
  run: () => void
}

export function CommandPalette(): JSX.Element {
  const open = useUi((s) => s.commandPaletteOpen)
  const setOpen = useUi((s) => s.setCommandPaletteOpen)
  const openTab = useUi((s) => s.openTab)
  const projects = useServer((s) => s.shell.projects)
  const threads = useServer((s) => s.shell.threads)
  const dispatch = useServer((s) => s.dispatch)

  const visit = (threadId: string): void => {
    openTab(threadId)
    void dispatch({ type: 'thread.visit', threadId })
    setOpen(false)
  }

  const commands: Cmd[] = useMemo(() => {
    const list: Cmd[] = []
    list.push({
      id: 'add-project',
      label: 'Add project…',
      icon: FolderPlus,
      run: async () => {
        setOpen(false)
        const folder = await window.native.pickFolder()
        if (!folder) return
        const res = await dispatch({ type: 'project.add', folderPath: folder })
        const projectId = res.data?.projectId as string | undefined
        if (projectId) {
          const created = await dispatch({ type: 'thread.create', projectId })
          const threadId = created.data?.threadId as string | undefined
          if (threadId) visit(threadId)
        }
      }
    })
    for (const p of projects) {
      list.push({
        id: `new-thread-${p.id}`,
        label: `New thread in ${p.name}`,
        icon: SquarePen,
        run: async () => {
          setOpen(false)
          const created = await dispatch({ type: 'thread.create', projectId: p.id })
          const threadId = created.data?.threadId as string | undefined
          if (threadId) visit(threadId)
        }
      })
    }
    for (const t of threads.filter((x) => !x.archivedAt)) {
      const project = projects.find((p) => p.id === t.projectId)
      list.push({ id: `thread-${t.id}`, label: t.title, hint: project?.name, icon: MessageCircle, run: () => visit(t.id) })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, threads])

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search threads, projects, and commands"
      className="top-[12vh] w-[560px] max-w-[90vw] translate-y-0 sm:max-w-[90vw]"
    >
      <Command>
        <CommandInput placeholder="Search threads, projects, and commands…" />
        <CommandList className="max-h-90">
          <CommandEmpty className="text-[12.5px] text-muted-foreground">No matches</CommandEmpty>
          {commands.map((c) => {
            const CmdIcon = c.icon
            return (
              // value carries label + hint so both are searchable; id keeps it unique
              <CommandItem key={c.id} value={`${c.label} ${c.hint ?? ''} ${c.id}`} onSelect={() => c.run()}>
                <CmdIcon className="size-[15px]" />
                <span className="flex-1 truncate">{c.label}</span>
                {c.hint && <span className="text-[11px] text-muted-foreground">{c.hint}</span>}
              </CommandItem>
            )
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
