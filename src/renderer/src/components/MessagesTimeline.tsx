import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message, ProposedPlan, ThreadDetail, WorkItem } from '@shared/domain'
import {
  Bot,
  TriangleAlert,
  Terminal,
  SquarePen,
  Eye,
  Globe,
  Wrench,
  ListTodo,
  Zap,
  X,
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Brain,
  type LucideIcon
} from 'lucide-react'
import { ChatMarkdown } from './ChatMarkdown'
import { durationLabel } from '../lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

interface Props {
  detail: ThreadDetail
  onOpenDiff: (turnId: string) => void
}

type Entry =
  | { kind: 'message'; at: number; message: Message }
  | { kind: 'work'; at: number; work: WorkItem }
  | { kind: 'plan'; at: number; plan: ProposedPlan }

interface TurnGroup {
  turnId: string
  userMessage: Message | null
  entries: Entry[]
  completed: boolean
  durationMs: number | null
  hasChanges: boolean
}

function groupByTurn(detail: ThreadDetail): TurnGroup[] {
  const turns = [...detail.turns].sort((a, b) => a.startedAt - b.startedAt)
  const groups: TurnGroup[] = []
  const orphanEntries: Entry[] = []

  const entriesForTurn = (turnId: string): Entry[] => {
    const es: Entry[] = []
    for (const m of detail.messages) if (m.turnId === turnId && m.role !== 'user') es.push({ kind: 'message', at: m.createdAt, message: m })
    for (const w of detail.workItems) if (w.turnId === turnId) es.push({ kind: 'work', at: w.createdAt, work: w })
    for (const p of detail.plans) if (p.turnId === turnId) es.push({ kind: 'plan', at: p.createdAt, plan: p })
    return es.sort((a, b) => a.at - b.at)
  }

  for (const turn of turns) {
    const userMessage = detail.messages.find((m) => m.turnId === turn.id && m.role === 'user') ?? null
    const checkpoint = detail.checkpoints.find((c) => c.turnId === turn.id)
    groups.push({
      turnId: turn.id,
      userMessage,
      entries: entriesForTurn(turn.id),
      completed: turn.state !== 'running',
      durationMs: turn.completedAt ? turn.completedAt - turn.startedAt : null,
      hasChanges: !!checkpoint && checkpoint.filesChanged > 0
    })
  }

  // Entries not claimed by any turn: messages/work whose turnId is null OR
  // references a turn we never saw. The latter guards against a provider tagging
  // events with its own turn id instead of the engine's — without this such a
  // reply would match no turn and silently disappear from the timeline.
  const knownTurnIds = new Set(turns.map((t) => t.id))
  for (const m of detail.messages) if (m.role !== 'user' && (!m.turnId || !knownTurnIds.has(m.turnId))) orphanEntries.push({ kind: 'message', at: m.createdAt, message: m })
  for (const w of detail.workItems) if (!w.turnId || !knownTurnIds.has(w.turnId)) orphanEntries.push({ kind: 'work', at: w.createdAt, work: w })
  for (const p of detail.plans) if (!p.turnId || !knownTurnIds.has(p.turnId)) orphanEntries.push({ kind: 'plan', at: p.createdAt, plan: p })
  if (orphanEntries.length) {
    orphanEntries.sort((a, b) => a.at - b.at)
    groups.push({ turnId: '__orphan__', userMessage: null, entries: orphanEntries, completed: true, durationMs: null, hasChanges: false })
  }

  return groups
}

function workIcon(w: WorkItem): LucideIcon {
  if (w.tone === 'thinking') return Bot
  if (w.tone === 'error') return TriangleAlert
  switch (w.itemType) {
    case 'command_execution':
      return Terminal
    case 'file_change':
      return SquarePen
    case 'file_read':
      return Eye
    case 'web_search':
      return Globe
    case 'mcp_tool_call':
      return Wrench
    case 'todo':
      return ListTodo
    case 'reasoning':
      return Bot
    default:
      return Zap
  }
}

function WorkRow({ work }: { work: WorkItem }): JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = !!work.body
  return (
    <div className={cn('overflow-hidden rounded-[9px] border bg-card', work.tone === 'error' && 'border-destructive/40')}>
      <Button
        variant="ghost"
        className="h-auto w-full justify-start gap-2 rounded-none px-2.5 py-[7px] text-left text-xs font-normal hover:bg-transparent disabled:opacity-100 dark:hover:bg-transparent"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={cn('flex text-muted-foreground', work.status === 'inProgress' && 'text-sky')}>
          {createElement(workIcon(work), { className: 'size-[13px]' })}
        </span>
        <span className="font-medium whitespace-nowrap text-foreground/80">{work.title}</span>
        {work.detail && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{work.detail}</span>}
        <span
          className={cn(
            'ml-auto flex',
            work.status === 'completed' && 'text-emerald',
            work.status === 'failed' && 'text-destructive'
          )}
        >
          {work.status === 'inProgress' ? (
            <Spinner className="size-[11px] text-sky" />
          ) : work.status === 'failed' ? (
            <X className="size-3" />
          ) : (
            <Check className="size-3" />
          )}
        </span>
        {expandable &&
          (open ? (
            <ChevronDown className="size-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 text-muted-foreground" />
          ))}
      </Button>
      {open && work.body && (
        <pre className="m-0 max-h-80 overflow-auto border-t bg-background px-3 py-2.5 font-mono text-[11.5px] leading-normal break-words whitespace-pre-wrap text-foreground/80">
          {work.body}
        </pre>
      )}
    </div>
  )
}

/** Reasoning ("thinking") stream: live while the model reasons, collapsible once done. */
function ReasoningBlock({ message }: { message: Message }): JSX.Element {
  const streaming = message.streaming
  const [open, setOpen] = useState(false)
  const expanded = streaming || open
  const hasText = !!message.text.trim()
  return (
    <div className="self-stretch">
      <Button
        variant="ghost"
        className="h-auto gap-1.5 self-start px-0.5 py-0.5 text-[11.5px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
        disabled={streaming}
        onClick={() => setOpen((o) => !o)}
      >
        <Brain className={cn('size-[13px]', streaming && 'animate-pulse text-sky')} />
        {streaming ? 'Thinking…' : 'Thought'}
        {!streaming && hasText && (expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />)}
      </Button>
      {expanded && hasText && (
        <div className="mt-1 ml-[7px] border-l border-border/70 pl-3 text-[12.5px] leading-normal text-muted-foreground/80">
          <ChatMarkdown text={message.text} />
          {streaming && <span className="animate-blink text-muted-foreground">▋</span>}
        </div>
      )}
    </div>
  )
}

function TurnBlock({ group, onOpenDiff }: { group: TurnGroup; onOpenDiff: (turnId: string) => void }): JSX.Element {
  const works = group.entries.filter((e): e is Extract<Entry, { kind: 'work' }> => e.kind === 'work')
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const expanded = !group.completed || (userExpanded ?? false)

  const showFold = group.completed && works.length > 0

  return (
    <div className="flex flex-col gap-2.5">
      {group.userMessage && (
        <div className="max-w-[82%] self-end rounded-2xl border bg-white/5 px-3.5 py-2.5 text-[13px] leading-normal">
          <div className="break-words whitespace-pre-wrap">{group.userMessage.text}</div>
        </div>
      )}

      {showFold && (
        <Button
          variant="ghost"
          className="h-auto gap-1.5 self-start px-0 py-0.5 text-[11.5px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
          onClick={() => setUserExpanded((prev) => !(prev ?? false))}
        >
          {expanded ? <ChevronDown className="size-[13px]" /> : <ChevronRight className="size-[13px]" />}
          {group.durationMs != null ? `Worked for ${durationLabel(group.durationMs)}` : 'Worked'} · {works.length} step{works.length === 1 ? '' : 's'}
        </Button>
      )}

      <div className="flex flex-col gap-2.5">
        {group.entries.map((e) => {
          if (e.kind === 'work') {
            if (showFold && !expanded) return null
            return <WorkRow key={e.work.id} work={e.work} />
          }
          if (e.kind === 'plan') {
            return (
              <div key={e.plan.id} className="rounded-xl border border-violet/30 bg-violet/5 px-3.5 py-3">
                <div className="mb-1.5 flex items-center gap-[7px] text-xs font-semibold text-violet">
                  <ListTodo size={13} /> Proposed plan
                </div>
                <ChatMarkdown text={e.plan.text} />
              </div>
            )
          }
          const m = e.message
          if (m.role === 'reasoning') return <ReasoningBlock key={m.id} message={m} />
          return (
            <div key={m.id} className="self-stretch px-0.5">
              {m.text || !m.streaming ? (
                <ChatMarkdown text={m.text || '_(no response)_'} />
              ) : (
                <span className="animate-blink text-muted-foreground">▋</span>
              )}
              {m.streaming && m.text && <span className="animate-blink text-muted-foreground">▋</span>}
            </div>
          )
        })}
      </div>

      {group.hasChanges && (
        <Button
          variant="outline"
          className="h-auto gap-[7px] self-start rounded-[9px] border-border bg-card px-3 py-[7px] text-xs font-normal text-foreground/80 dark:border-border dark:bg-card dark:hover:bg-muted"
          onClick={() => onOpenDiff(group.turnId)}
        >
          <FileDiff className="size-[13px]" /> View changes from this turn
        </Button>
      )}
    </div>
  )
}

export function MessagesTimeline({ detail, onOpenDiff }: Props): JSX.Element {
  const groups = groupByTurn(detail)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  useLayoutEffect(() => {
    if (stick.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  })

  const working = detail.thread.status === 'running' || detail.thread.status === 'starting'
  const runningTurn = detail.turns.find((t) => t.state === 'running')

  if (groups.length === 0) {
    return <div className="grid flex-1 place-items-center overflow-y-auto text-muted-foreground">Send a message to start the conversation.</div>
  }

  return (
    <div className="flex-1 overflow-y-auto" ref={scrollRef} onScroll={onScroll}>
      <div className="mx-auto flex max-w-3xl flex-col gap-[18px] px-5 pt-[22px] pb-6">
        {groups.map((g) => (
          <TurnBlock key={g.turnId} group={g} onOpenDiff={onOpenDiff} />
        ))}
        {working && (
          <div className="flex items-center gap-2.5 px-0.5 py-1 text-muted-foreground">
            <span className="inline-flex gap-1">
              <i className="size-1.5 animate-pulse rounded-full bg-sky" />
              <i className="size-1.5 animate-pulse rounded-full bg-sky [animation-delay:0.2s]" />
              <i className="size-1.5 animate-pulse rounded-full bg-sky [animation-delay:0.4s]" />
            </span>
            <WorkingTimer startedAt={runningTurn?.startedAt} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function WorkingTimer({ startedAt }: { startedAt?: number }): JSX.Element {
  // anchored to the turn's start so remounting doesn't reset the count
  const [start] = useState(() => startedAt ?? Date.now())
  const [s, setS] = useState(() => Math.max(0, Math.floor((Date.now() - start) / 1000)))
  useEffect(() => {
    const t = setInterval(() => setS(Math.max(0, Math.floor((Date.now() - start) / 1000))), 1000)
    return () => clearInterval(t)
  }, [start])
  return <span className="text-xs">Working for {s}s</span>
}
