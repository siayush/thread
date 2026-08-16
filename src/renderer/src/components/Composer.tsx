import { useState, type KeyboardEvent } from 'react'
import { useServer } from '../state/serverStore'
import { useComposerDraft } from '../state/uiStore'
import type { ApprovalDecision, PendingApproval, RuntimeMode, Thread } from '@shared/domain'
import { TriangleAlert, Lock, SquarePen, LockOpen, Ruler, Bot, Square, ArrowUp, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ModelPicker } from './ModelPicker'

const RUNTIME_LABELS: Record<RuntimeMode, { label: string; icon: LucideIcon }> = {
  supervised: { label: 'Supervised', icon: Lock },
  'auto-accept-edits': { label: 'Auto-accept edits', icon: SquarePen },
  'full-access': { label: 'Full access', icon: LockOpen }
}

/** Footer pill: transparent ghost control that fills on hover. */
const SELECT_TRIGGER_CLS =
  'h-7 gap-1.5 rounded-lg border-transparent bg-transparent px-2.5 text-[12px] font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent'

/** Thin vertical divider between footer pill groups. */
const PillSeparator = (): JSX.Element => <div aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />

/** Human labels for effort levels; unknown values are Title-cased. */
const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
  ultracode: 'Ultracode',
  ultrathink: 'Ultrathink'
}
const effortLabel = (e: string): string => EFFORT_LABELS[e] ?? e.charAt(0).toUpperCase() + e.slice(1)

/** Effort dropdown items: `Auto` (the `default` sentinel, sent as null) plus the
 *  model's advertised levels. Empty when the model has none (control is hidden). */
function reasoningItemsFor(efforts: string[] | undefined): Record<string, string> {
  if (!efforts || efforts.length === 0) return {}
  const items: Record<string, string> = { default: 'Auto' }
  for (const e of efforts) items[e] = effortLabel(e)
  return items
}

function ApprovalPanel({ threadId, approval }: { threadId: string; approval: PendingApproval }): JSX.Element {
  const dispatch = useServer((s) => s.dispatch)
  const respond = (decision: ApprovalDecision): void => {
    void dispatch({ type: 'approval.respond', threadId, requestId: approval.id, decision })
  }
  return (
    <div className="mx-2 mt-2 rounded-xl border border-amber/35 bg-amber/8 px-3 py-2.5">
      <div className="flex items-center gap-[7px] text-xs text-amber">
        <TriangleAlert className="size-[13px] shrink-0" /> Permission required — <b>{approval.toolName}</b>
      </div>
      {approval.detail && (
        <div className="my-1.5 mb-2.5 max-h-[120px] overflow-auto font-mono text-[11.5px] break-words whitespace-pre-wrap text-foreground/80">
          {approval.detail}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => respond({ behavior: 'deny' })}>
          Cancel turn
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="border-destructive/40 bg-transparent dark:bg-transparent"
          onClick={() => respond({ behavior: 'deny', message: 'The user declined. Try another approach.' })}
        >
          Decline
        </Button>
        <Button
          variant="outline"
          size="sm"
          title={`Allow every ${approval.toolName} use in this thread for the rest of the session`}
          onClick={() => respond({ behavior: 'allow', scope: 'session' })}
        >
          Always allow {approval.toolName}
        </Button>
        <Button size="sm" onClick={() => respond({ behavior: 'allow', scope: 'once' })}>
          Approve
        </Button>
      </div>
    </div>
  )
}

export function Composer({ thread }: { thread: Thread }): JSX.Element {
  const dispatch = useServer((s) => s.dispatch)
  const detail = useServer((s) => s.details[thread.id])
  const models = useServer((s) => s.models)
  const drafts = useComposerDraft((s) => s.drafts)
  const setDraft = useComposerDraft((s) => s.set)
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const text = drafts[thread.id] ?? ''
  const running = thread.status === 'running'
  const pending = detail?.pendingApprovals ?? []
  const isNewThread = (detail?.turns.length ?? 0) === 0

  const currentModel = models.find((m) => (thread.model ? m.value === thread.model : m.value === 'default'))
  const reasoningItems = reasoningItemsFor(currentModel?.reasoningEfforts)
  const hasReasoning = Object.keys(reasoningItems).length > 0

  const send = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || running || busy) return
    setBusy(true)
    setSendError(null)
    const res = await dispatch({ type: 'turn.send', threadId: thread.id, text: trimmed })
    setBusy(false)
    if (res.ok) setDraft(thread.id, '')
    else setSendError(res.error ?? 'Failed to send message')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    } else if (e.shiftKey && e.key === 'Tab') {
      e.preventDefault()
      void dispatch({ type: 'thread.setConfig', threadId: thread.id, interactionMode: thread.interactionMode === 'plan' ? 'build' : 'plan' })
    }
  }

  const runtime = RUNTIME_LABELS[thread.runtimeMode]
  const RuntimeIcon = runtime.icon

  const runtimeItems: Record<RuntimeMode, string> = {
    supervised: 'Supervised',
    'auto-accept-edits': 'Auto-accept edits',
    'full-access': 'Full access'
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pt-2 pb-[18px]">
      {(sendError ?? thread.lastError) && (
        <div className="mb-2 flex items-center gap-2 rounded-[10px] border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <TriangleAlert className="size-[13px] shrink-0" /> {sendError ?? thread.lastError}
        </div>
      )}
      <div className="rounded-[22px] border border-white/[0.05] bg-card/80 shadow-[0_12px_28px_-18px_rgba(0,0,0,0.5),inset_0_1px_rgba(255,255,255,0.03)] backdrop-blur-[16px] backdrop-saturate-[1.08]">
        {pending.length > 0 && <ApprovalPanel threadId={thread.id} approval={pending[0]} />}

        <Textarea
          className="max-h-[200px] min-h-[70px] resize-none rounded-none border-none bg-transparent px-4 pt-3.5 pb-2 text-[13px] leading-relaxed shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent md:text-[13px] dark:bg-transparent dark:disabled:bg-transparent"
          placeholder={
            thread.interactionMode === 'plan'
              ? 'Describe what you want to plan…'
              : isNewThread
                ? 'Describe what to build'
                : 'Ask for follow-up changes'
          }
          value={text}
          onChange={(e) => setDraft(thread.id, e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={pending.length > 0}
        />

        <div className="flex items-center justify-between gap-2 px-3 pb-3">
          <div className="-ml-1 flex min-w-0 flex-1 items-center gap-1">
            <ModelPicker thread={thread} />

            {hasReasoning && (
              <>
                <PillSeparator />
                <Select
                  items={reasoningItems}
                  value={thread.reasoningEffort && reasoningItems[thread.reasoningEffort] ? thread.reasoningEffort : 'default'}
                  onValueChange={(value) =>
                    void dispatch({ type: 'thread.setConfig', threadId: thread.id, reasoningEffort: value === 'default' ? null : value })
                  }
                >
                  <SelectTrigger size="sm" className={SELECT_TRIGGER_CLS} title="Reasoning effort">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(reasoningItems).map((key) => (
                      <SelectItem key={key} value={key} className="text-xs">
                        {reasoningItems[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}

            <PillSeparator />

            <Select
              items={runtimeItems}
              value={thread.runtimeMode}
              onValueChange={(value) =>
                void dispatch({ type: 'thread.setConfig', threadId: thread.id, runtimeMode: value as RuntimeMode })
              }
            >
              <SelectTrigger size="sm" className={SELECT_TRIGGER_CLS}>
                <RuntimeIcon className="size-[14px]" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(runtimeItems) as RuntimeMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode} className="text-xs">
                    {runtimeItems[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 shrink-0 gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent',
                thread.interactionMode === 'plan' &&
                  'bg-sky/10 text-sky hover:bg-sky/15 hover:text-sky dark:hover:bg-sky/15'
              )}
              title="Toggle Plan / Build (Shift+Tab)"
              onClick={() =>
                void dispatch({ type: 'thread.setConfig', threadId: thread.id, interactionMode: thread.interactionMode === 'plan' ? 'build' : 'plan' })
              }
            >
              {thread.interactionMode === 'plan' ? <Ruler className="size-[14px]" /> : <Bot className="size-[14px]" />}
              {thread.interactionMode === 'plan' ? 'Plan' : 'Build'}
            </Button>
          </div>

          {running ? (
            <Button
              size="icon"
              className="size-8 shrink-0 rounded-full bg-destructive text-destructive-foreground shadow-xs transition-all duration-150 hover:scale-105 hover:bg-destructive/80"
              onClick={() => void dispatch({ type: 'turn.interrupt', threadId: thread.id })}
              title="Stop"
            >
              <Square className="size-3" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-8 shrink-0 rounded-full shadow-xs transition-all duration-150 hover:scale-105 disabled:opacity-30"
              onClick={() => void send()}
              disabled={!text.trim() || pending.length > 0}
              title="Send"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
