/**
 * Pure derivation for the message timeline — a faithful port of t3's
 * MessagesTimeline.logic.ts + session-logic heuristics onto Thread's domain.
 *
 * Semantics ported exactly:
 *  - one flat entry stream (messages + work + plans) sorted by createdAt
 *  - settled turns fold everything except their terminal assistant message
 *    behind a "Worked for …" row anchored at the turn's first entry
 *  - consecutive work entries group; only the newest stays visible behind a
 *    "+N previous tool calls" toggle (MAX_VISIBLE_WORK_LOG_ENTRIES = 1)
 *  - tool rows with neither clear success nor failure (in-progress, empty)
 *    are hidden from the timeline; the working row carries live status
 *  - structural sharing keeps unchanged row references across derivations
 *
 * Thread-specific mapping (documented deviations):
 *  - the working step label falls back to the latest in-progress work item
 *    (t3 sources it from plan steps, which Thread does not track as steps)
 */
import type { Checkpoint, Message, ProposedPlan, ThreadDetail, Turn, WorkItem } from '@shared/domain'

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40
export const CHAT_LIST_ANCHOR_OFFSET = 16

// ---------------------------------------------------------------------------
// Minimap geometry (t3 port)
// ---------------------------------------------------------------------------

export const TIMELINE_MINIMAP_ITEM_SPACING = 8
export const TIMELINE_MINIMAP_MIN_ITEMS = 2
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = 'calc(100vh - 18rem)'
export const TIMELINE_CONTENT_MAX_WIDTH = 768
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48
export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = '22rem'

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING)
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number
  readonly railTop: number
  readonly railHeight: number
  readonly pointerY: number
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) return null
  if (input.itemCount === 1) return 0

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight))
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))))
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return false

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH)
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2)
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER
}

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered. Cap the hover strip's width so it never extends past the side
 * gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH)
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2)
  return Math.max(0, Math.min(TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH, Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT))
}

/** Once the preview is open, keep the full preview and the space leading to it interactive. */
export function resolveTimelineMinimapInteractiveWidth(collapsedWidth: number, expanded: boolean): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth
}

// ---------------------------------------------------------------------------
// Entry stream
// ---------------------------------------------------------------------------

/** A unit of agent work: a tool call, or a reasoning ("thinking") stream. */
export type TimelineWorkEntry =
  | { type: 'item'; item: WorkItem }
  | { type: 'reasoning'; message: Message }

export function workEntryId(entry: TimelineWorkEntry): string {
  return entry.type === 'item' ? entry.item.id : entry.message.id
}

function workEntryTurnId(entry: TimelineWorkEntry): string | null {
  return entry.type === 'item' ? entry.item.turnId : entry.message.turnId
}

function workEntryCreatedAt(entry: TimelineWorkEntry): number {
  return entry.type === 'item' ? entry.item.createdAt : entry.message.createdAt
}

type TimelineEntry =
  | { id: string; kind: 'message'; createdAt: number; message: Message }
  | { id: string; kind: 'work'; createdAt: number; entry: TimelineWorkEntry }
  | { id: string; kind: 'proposed-plan'; createdAt: number; proposedPlan: ProposedPlan }

function deriveTimelineEntries(detail: ThreadDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  for (const m of detail.messages) {
    if (m.role === 'reasoning') {
      entries.push({ id: m.id, kind: 'work', createdAt: m.createdAt, entry: { type: 'reasoning', message: m } })
    } else {
      entries.push({ id: m.id, kind: 'message', createdAt: m.createdAt, message: m })
    }
  }
  for (const w of detail.workItems) {
    entries.push({ id: w.id, kind: 'work', createdAt: w.createdAt, entry: { type: 'item', item: w } })
  }
  for (const p of detail.plans) {
    entries.push({ id: p.id, kind: 'proposed-plan', createdAt: p.createdAt, proposedPlan: p })
  }
  // stable sort: equal timestamps keep messages → work → plans insertion order
  return entries.sort((a, b) => a.createdAt - b.createdAt)
}

// ---------------------------------------------------------------------------
// Tool status heuristics (session-logic.ts port)
// ---------------------------------------------------------------------------

const TOOL_LIFECYCLE_ITEM_TYPES = new Set<WorkItem['itemType']>([
  'command_execution',
  'file_change',
  'file_read',
  'web_search',
  'mcp_tool_call'
])

export function workLogEntryIsToolLike(entry: TimelineWorkEntry): boolean {
  if (entry.type === 'reasoning') return true
  const { item } = entry
  if (item.tone === 'tool' || item.tone === 'thinking' || item.tone === 'error') return true
  return TOOL_LIFECYCLE_ITEM_TYPES.has(item.itemType)
}

/** Heuristic: providers often emit successful lifecycle status while error text lives in the payload. */
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const t = text.toLowerCase()
  if (t.includes('file not found')) return true
  if (t.includes('no files found')) return true
  if (t.includes('enoent') || t.includes('no such file or directory') || t.includes('no such file')) return true
  if (t.includes('cannot find path') && t.includes('because it does not exist')) return true
  if (t.includes('commandnotfoundexception')) return true
  if (t.includes('is not recognized as the name of a cmdlet')) return true
  if (t.includes('is not recognized') && t.includes("the term '")) return true
  if (t.includes('a parameter cannot be found that matches parameter name')) return true
  if (t.includes('command not found')) return true
  if (/<exited with exit code\s+[1-9]\d*\s*>/i.test(text)) return true
  if (/exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text)) return true
  if (/exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)) return true
  return false
}

/** True when the row should show a failure affordance (explicit status/tone or error-shaped tool output). */
export function workEntryIndicatesToolFailure(entry: TimelineWorkEntry): boolean {
  if (entry.type === 'reasoning') return false
  const { item } = entry
  if (item.tone === 'error') return true
  if (item.status === 'failed') return true
  if (!workLogEntryIsToolLike(entry)) return false
  const parts: string[] = []
  if (item.detail) parts.push(item.detail)
  if (item.body) parts.push(item.body)
  const blob = parts.join('\n')
  if (blob.length === 0) return false
  return toolDetailTextLooksLikeFailure(blob)
}

/** Tool/command row completed without failure (check affordance). */
export function workEntryIndicatesToolSuccess(entry: TimelineWorkEntry): boolean {
  if (entry.type === 'reasoning') return false
  if (!workLogEntryIsToolLike(entry)) return false
  if (workEntryIndicatesToolFailure(entry)) return false
  const { item } = entry
  if (item.tone === 'thinking') return false
  if (item.status === 'inProgress') return false
  return true
}

/** Tool-like row with neither clear success nor failure — hidden from the timeline. */
export function workEntryIndicatesToolNeutralStatus(entry: TimelineWorkEntry): boolean {
  // Reasoning maps to t3's "thinking" tone: never success, so always neutral
  // and hidden — live thinking surfaces through the working row instead.
  if (entry.type === 'reasoning') return true
  if (!workLogEntryIsToolLike(entry)) return false
  if (workEntryIndicatesToolFailure(entry)) return false
  if (workEntryIndicatesToolSuccess(entry)) return false
  return true
}

// ---------------------------------------------------------------------------
// Row presentation helpers (PlainWorkEntryRow support, ported)
// ---------------------------------------------------------------------------

export type WorkEntryIconName =
  | 'bot'
  | 'check'
  | 'circle-alert'
  | 'eye'
  | 'globe'
  | 'list-todo'
  | 'square-pen'
  | 'terminal'
  | 'wrench'
  | 'x'
  | 'zap'

export function workToneIcon(tone: WorkItem['tone'] | 'thinking'): { iconName: WorkEntryIconName; className: string } {
  if (tone === 'error') return { iconName: 'circle-alert', className: 'text-foreground' }
  if (tone === 'thinking') return { iconName: 'bot', className: 'text-foreground' }
  if (tone === 'info') return { iconName: 'check', className: 'text-icon-muted' }
  return { iconName: 'zap', className: 'text-foreground' }
}

export function workEntryTone(entry: TimelineWorkEntry): WorkItem['tone'] {
  return entry.type === 'reasoning' ? 'thinking' : entry.item.tone
}

export function workEntryIconName(entry: TimelineWorkEntry): WorkEntryIconName {
  if (entry.type === 'reasoning') return 'bot'
  const { item } = entry
  if (item.itemType === 'command_execution') return 'terminal'
  if (item.itemType === 'file_change' || item.changedFiles.length > 0) return 'square-pen'
  if (item.itemType === 'file_read') return 'eye'
  if (item.itemType === 'web_search') return 'globe'
  if (item.itemType === 'mcp_tool_call') return 'wrench'
  if (item.itemType === 'todo') return 'list-todo'
  if (item.itemType === 'reasoning') return 'bot'
  return workToneIcon(item.tone).iconName
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, '').trim()
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return value
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`
}

export function toolWorkEntryHeading(entry: TimelineWorkEntry): string {
  if (entry.type === 'reasoning') return 'Thought'
  return capitalizePhrase(normalizeCompactToolLabel(entry.item.title))
}

export function workEntryPreview(entry: TimelineWorkEntry): string | null {
  if (entry.type === 'reasoning') return null
  const { item } = entry
  if (item.detail) return item.detail
  if (item.changedFiles.length === 0) return null
  const [firstPath] = item.changedFiles
  if (!firstPath) return null
  return item.changedFiles.length === 1 ? firstPath : `${firstPath} +${item.changedFiles.length - 1} more`
}

export function buildToolCallExpandedBody(entry: TimelineWorkEntry): string | null {
  if (entry.type === 'reasoning') {
    const text = entry.message.text.trim()
    return text.length > 0 ? text : null
  }
  const { item } = entry
  const blocks: string[] = []
  if (item.detail?.trim()) blocks.push(item.detail.trim())
  if (item.body?.trim()) blocks.push(item.body.trim())
  if (item.changedFiles.length > 0) blocks.push(item.changedFiles.join('\n'))
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

// ---------------------------------------------------------------------------
// Durations (session-logic formatDuration port)
// ---------------------------------------------------------------------------

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0ms'
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10
    // 9.95s+ rounds up to the next bucket — render "10s", not "10.0s".
    return tenths >= 10 ? '10s' : `${tenths.toFixed(1)}s`
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1_000)
  if (seconds === 0) return `${minutes}m`
  if (seconds === 60) return `${minutes + 1}m`
  return `${minutes}m ${seconds}s`
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type MessagesTimelineRow =
  | { kind: 'work'; id: string; createdAt: number; groupedEntries: TimelineWorkEntry[] }
  | {
      kind: 'work-toggle'
      id: string
      createdAt: number
      groupId: string
      hiddenCount: number
      expanded: boolean
      onlyToolEntries: boolean
    }
  | { kind: 'turn-fold'; id: string; createdAt: number; turnId: string; label: string; expanded: boolean }
  | {
      kind: 'message'
      id: string
      createdAt: number
      message: Message
      showAssistantMeta: boolean
      showAssistantCopyButton: boolean
      assistantCopyStreaming: boolean
      /** turn checkpoint rendered as the changed-files card under the terminal assistant message */
      checkpoint: Checkpoint | null
      turnId: string | null
    }
  | { kind: 'proposed-plan'; id: string; createdAt: number; proposedPlan: ProposedPlan }
  | { kind: 'working'; id: string; createdAt: number | null }

/** Last assistant message per response (turn, or per unkeyed user boundary). */
function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>): Set<string> {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>()
  let nullTurnResponseIndex = 0

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== 'message') continue
    const { message } = timelineEntry
    if (message.role === 'user') {
      nullTurnResponseIndex += 1
      continue
    }
    if (message.role !== 'assistant') continue
    const responseKey = message.turnId ? `turn:${message.turnId}` : `unkeyed:${nullTurnResponseIndex}`
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id)
  }

  return new Set(lastAssistantMessageIdByResponseKey.values())
}

/**
 * The running turn is authoritative; otherwise the latest turn counts as
 * unsettled while it has not recorded a completion. Folding must not flicker
 * through the window right after a send, before the new turn exists.
 */
function deriveUnsettledTurnId(detail: ThreadDetail): string | null {
  const running = detail.turns.find((t) => t.state === 'running')
  if (running) return running.id
  let latest: Turn | null = null
  for (const t of detail.turns) if (!latest || t.startedAt > latest.startedAt) latest = t
  if (!latest) return null
  const isSettled = latest.completedAt !== null && latest.state !== 'running'
  return isSettled ? null : latest.id
}

interface TurnFold {
  turnId: string
  anchorEntryId: string
  createdAt: number
  hiddenEntryIds: ReadonlySet<string>
  label: string
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>
  terminalAssistantMessageIds: ReadonlySet<string>
  turnsById: ReadonlyMap<string, Turn>
  unsettledTurnId: string | null
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: TimelineEntry[]
    terminalEntry: Extract<TimelineEntry, { kind: 'message' }> | null
    hasStreamingMessage: boolean
    /** the user message that kicked the turn off — entry timestamps alone undercount the duration */
    startBoundary: number | null
  }
  const groupsByTurnId = new Map<string, TurnGroup>()

  let pendingUserBoundary: number | null = null
  for (const entry of input.timelineEntries) {
    if (entry.kind === 'message' && entry.message.role === 'user') {
      pendingUserBoundary = entry.message.createdAt
      continue
    }
    const turnId =
      entry.kind === 'message' && entry.message.role === 'assistant'
        ? (entry.message.turnId ?? null)
        : entry.kind === 'work'
          ? workEntryTurnId(entry.entry)
          : null
    if (!turnId) continue
    let group = groupsByTurnId.get(turnId)
    if (!group) {
      group = { entries: [], terminalEntry: null, hasStreamingMessage: false, startBoundary: pendingUserBoundary }
      pendingUserBoundary = null
      groupsByTurnId.set(turnId, group)
    }
    group.entries.push(entry)
    if (entry.kind === 'message') {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) group.terminalEntry = entry
      if (entry.message.streaming) group.hasStreamingMessage = true
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>()
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) continue
    if (group.hasStreamingMessage) continue
    const hiddenEntryIds = new Set<string>()
    for (const entry of group.entries) {
      if (entry.id === group.terminalEntry?.id) continue
      hiddenEntryIds.add(entry.id)
    }
    if (hiddenEntryIds.size === 0) continue

    const firstEntry = group.entries[0]
    const lastEntry = group.entries.at(-1)
    if (!firstEntry || !lastEntry) continue

    const turn = input.turnsById.get(turnId)
    const isInterruptedTurn = turn?.state === 'interrupted'
    // a turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last
    const lastEntryEnd = lastEntry.kind === 'message' ? lastEntry.message.updatedAt : lastEntry.createdAt
    const elapsedMs =
      turn && turn.completedAt !== null
        ? Math.max(0, turn.completedAt - turn.startedAt)
        : Math.max(
            0,
            Math.max(group.terminalEntry?.message.updatedAt ?? lastEntryEnd, lastEntryEnd) -
              (group.startBoundary ?? firstEntry.createdAt)
          )
    const duration = elapsedMs > 0 ? formatDuration(elapsedMs) : null
    const label = isInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : 'You stopped this response'
      : duration
        ? `Worked for ${duration}`
        : 'Worked'

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label
    })
  }
  return foldsByAnchorEntryId
}

/** Live step readout for the working row: the latest in-progress work item. */
export function deriveWorkingStepLabel(detail: ThreadDetail): string | null {
  let latest: WorkItem | null = null
  for (const w of detail.workItems) {
    if (w.status !== 'inProgress') continue
    if (!latest || w.updatedAt > latest.updatedAt) latest = w
  }
  if (latest) return latest.detail ? `${latest.title} ${latest.detail}` : latest.title
  if (detail.messages.some((m) => m.role === 'reasoning' && m.streaming)) return 'Thinking'
  return null
}

export function deriveMessagesTimelineRows(input: {
  detail: ThreadDetail
  expandedTurnIds: ReadonlySet<string>
  expandedWorkGroupIds: ReadonlySet<string>
}): MessagesTimelineRow[] {
  const { detail } = input
  const timelineEntries = deriveTimelineEntries(detail)
  const nextRows: MessagesTimelineRow[] = []
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries)
  const turnsById = new Map(detail.turns.map((t) => [t.id, t]))
  const unsettledTurnId = deriveUnsettledTurnId(detail)
  const checkpointByTurnId = new Map<string, Checkpoint>()
  for (const c of detail.checkpoints) if (c.filesChanged > 0) checkpointByTurnId.set(c.turnId, c)

  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries,
    terminalAssistantMessageIds,
    turnsById,
    unsettledTurnId
  })
  const collapsedEntryIds = new Set<string>()
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) collapsedEntryIds.add(entryId)
    }
  }

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index]
    if (!timelineEntry) continue

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id)
    if (turnFold) {
      nextRows.push({
        kind: 'turn-fold',
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds.has(turnFold.turnId)
      })
    }

    if (collapsedEntryIds.has(timelineEntry.id)) continue

    if (timelineEntry.kind === 'work') {
      const groupedEntries = [timelineEntry.entry]
      let cursor = index + 1
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor]
        if (
          !nextEntry ||
          nextEntry.kind !== 'work' ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break
        }
        groupedEntries.push(nextEntry.entry)
        cursor += 1
      }
      const visibleGroupedEntries = groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry))
      if (visibleGroupedEntries.length > 0) {
        if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: 'work',
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries
          })
        } else {
          const groupId = `work-group:${timelineEntry.id}`
          const expanded = input.expandedWorkGroupIds.has(groupId)
          const hiddenEntries = visibleGroupedEntries.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES)
          const renderedEntries = expanded
            ? visibleGroupedEntries
            : visibleGroupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)

          for (const entry of renderedEntries) {
            nextRows.push({
              kind: 'work',
              id: workEntryId(entry),
              createdAt: workEntryCreatedAt(entry),
              groupedEntries: [entry]
            })
          }

          if (hiddenEntries.length > 0) {
            nextRows.push({
              kind: 'work-toggle',
              id: `work-toggle:${timelineEntry.id}`,
              createdAt: timelineEntry.createdAt,
              groupId,
              hiddenCount: hiddenEntries.length,
              expanded,
              onlyToolEntries: visibleGroupedEntries.every((entry) => workLogEntryIsToolLike(entry))
            })
          }
        }
      }
      index = cursor - 1
      continue
    }

    if (timelineEntry.kind === 'proposed-plan') {
      nextRows.push({
        kind: 'proposed-plan',
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan
      })
      continue
    }

    const { message } = timelineEntry
    const assistantTurnStillInProgress =
      message.role === 'assistant' && unsettledTurnId !== null && message.turnId === unsettledTurnId

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const isTerminal = message.role === 'assistant' && terminalAssistantMessageIds.has(message.id)
    const showAssistantMeta = isTerminal && !assistantTurnStillInProgress

    nextRows.push({
      kind: 'message',
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: message.streaming || assistantTurnStillInProgress,
      checkpoint: isTerminal && message.turnId ? (checkpointByTurnId.get(message.turnId) ?? null) : null,
      turnId: message.turnId
    })
  }

  if (detail.thread.status === 'running') {
    const runningTurn = detail.turns.find((t) => t.state === 'running')
    nextRows.push({
      kind: 'working',
      id: 'working-indicator-row',
      createdAt: runningTurn?.startedAt ?? null
    })
  }

  return nextRows
}

// ---------------------------------------------------------------------------
// Structural sharing — unchanged rows keep their previous object reference so
// memoized row components skip re-rendering during streaming.
// ---------------------------------------------------------------------------

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>
  result: MessagesTimelineRow[]
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>()
  let anyChanged = rows.length !== previous.byId.size

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id)
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row
    next.set(row.id, nextRow)
    if (!anyChanged && previous.result[index] !== nextRow) anyChanged = true
    return nextRow
  })

  return anyChanged ? { byId: next, result } : previous
}

function workEntriesEqual(a: TimelineWorkEntry[], b: TimelineWorkEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const ea = a[i]
    const eb = b[i]
    if (ea.type !== eb.type) return false
    if (ea.type === 'item' && eb.type === 'item' && ea.item !== eb.item) return false
    if (ea.type === 'reasoning' && eb.type === 'reasoning' && ea.message !== eb.message) return false
  }
  return true
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false

  switch (a.kind) {
    case 'working':
      return a.createdAt === (b as typeof a).createdAt

    case 'turn-fold': {
      const bf = b as typeof a
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded
    }

    case 'proposed-plan':
      return a.proposedPlan === (b as typeof a).proposedPlan

    case 'work':
      return workEntriesEqual(a.groupedEntries, (b as typeof a).groupedEntries)

    case 'work-toggle': {
      const bw = b as typeof a
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries
      )
    }

    case 'message': {
      const bm = b as typeof a
      return (
        a.message === bm.message &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.checkpoint === bm.checkpoint &&
        a.turnId === bm.turnId
      )
    }
  }
}
