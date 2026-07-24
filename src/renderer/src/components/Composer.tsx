import { useState, type KeyboardEvent } from 'react'
import { useServer } from '../state/serverStore'
import { useComposerDraft } from '../state/uiStore'
import type { ApprovalDecision, PendingApproval, RuntimeMode, Thread } from '@shared/domain'
import { TriangleAlert, Lock, SquarePen, LockOpen, Ruler, Bot, Square, ArrowUp, Brain, type LucideIcon } from 'lucide-react'
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

const SELECT_TRIGGER_CLS =
  'h-auto gap-[5px] rounded-lg border-border bg-muted px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground/80 dark:bg-muted dark:hover:bg-accent'

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
    <div className="m-1 mb-2 rounded-xl border border-amber/35 bg-amber/8 px-3 py-2.5">
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
      <div className="rounded-[18px] border border-input bg-card/70 p-1.5 shadow-[0_18px_48px_-24px_rgba(0,0,0,0.6)] backdrop-blur-xl focus-within:border-primary/45">
        {pending.length > 0 && <ApprovalPanel threadId={thread.id} approval={pending[0]} />}

        <Textarea
          className="max-h-[220px] min-h-0 resize-none rounded-none border-none bg-transparent px-2.5 py-2 text-[13px] shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent md:text-[13px] dark:bg-transparent dark:disabled:bg-transparent"
          placeholder={
            thread.interactionMode === 'plan'
              ? 'Plan mode — describe what you want to plan…'
              : 'Message the agent…  (Enter to send, Shift+Enter for newline, Shift+Tab to toggle Plan)'
          }
          value={text}
          onChange={(e) => setDraft(thread.id, e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={pending.length > 0}
        />

        <div className="flex items-center justify-between gap-2 px-1 pt-1 pb-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <ModelPicker thread={thread} />

            <Select
              items={runtimeItems}
              value={thread.runtimeMode}
              onValueChange={(value) =>
                void dispatch({ type: 'thread.setConfig', threadId: thread.id, runtimeMode: value as RuntimeMode })
              }
            >
              <SelectTrigger size="sm" className={SELECT_TRIGGER_CLS}>
                <RuntimeIcon className="size-[13px]" />
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

            {hasReasoning && (
              <Select
                items={reasoningItems}
                value={thread.reasoningEffort && reasoningItems[thread.reasoningEffort] ? thread.reasoningEffort : 'default'}
                onValueChange={(value) =>
                  void dispatch({ type: 'thread.setConfig', threadId: thread.id, reasoningEffort: value === 'default' ? null : value })
                }
              >
                <SelectTrigger size="sm" className={SELECT_TRIGGER_CLS} title="Reasoning effort">
                  <Brain className="size-[13px]" />
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
            )}

            <Button
              variant="outline"
              size="sm"
              className={cn(
                'h-auto gap-[5px] rounded-lg bg-muted px-2.5 py-[5px] text-[11.5px] font-normal text-foreground/80 dark:border-border dark:bg-muted dark:hover:bg-accent',
                thread.interactionMode === 'plan' &&
                  'border-sky/40 bg-sky/10 text-sky hover:text-sky dark:border-sky/40 dark:bg-sky/10 dark:hover:bg-sky/15'
              )}
              title="Toggle Plan / Build (Shift+Tab)"
              onClick={() =>
                void dispatch({ type: 'thread.setConfig', threadId: thread.id, interactionMode: thread.interactionMode === 'plan' ? 'build' : 'plan' })
              }
            >
              {thread.interactionMode === 'plan' ? <Ruler className="size-[13px]" /> : <Bot className="size-[13px]" />}
              {thread.interactionMode === 'plan' ? 'Plan' : 'Build'}
            </Button>
          </div>

          {running ? (
            <Button
              size="icon"
              className="size-[34px] shrink-0 rounded-[10px] bg-destructive text-destructive-foreground hover:bg-destructive/80"
              onClick={() => void dispatch({ type: 'turn.interrupt', threadId: thread.id })}
              title="Stop"
            >
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-[34px] shrink-0 rounded-[10px] disabled:opacity-35"
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
