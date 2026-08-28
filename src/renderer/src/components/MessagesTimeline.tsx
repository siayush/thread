import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent
} from 'react'
import { LegendList, type LegendListRef } from '@legendapp/list/react'
import type { Checkpoint, ThreadDetail } from '@shared/domain'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  Eye,
  File,
  FileDiff,
  Folder,
  FolderClosed,
  Globe,
  ListTodo,
  SquarePen,
  Terminal,
  Wrench,
  X,
  Zap
} from 'lucide-react'
import { ChatMarkdown } from './ChatMarkdown'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from '../lib/timestampFormat'
import {
  buildTurnDiffTree,
  collectDirectoryPaths,
  summarizeTurnDiffStats,
  type TurnDiffFileChange,
  type TurnDiffTreeNode
} from '../lib/turnDiffTree'
import { useServer } from '../state/serverStore'
import { useUi } from '../state/uiStore'
import {
  TIMELINE_MINIMAP_MIN_ITEMS,
  buildToolCallExpandedBody,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveWorkingStepLabel,
  normalizeCompactToolLabel,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapTopPercent,
  toolWorkEntryHeading,
  workEntryIconName,
  workEntryId,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workEntryPreview,
  workEntryTone,
  workLogEntryIsToolLike,
  workToneIcon,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
  type TimelineWorkEntry,
  type WorkEntryIconName
} from './messagesTimeline.logic'
import {
  CHAT_LIST_ANCHOR_OFFSET,
  getAnchoredTurnMetrics,
  resolveChatListAnchoredEndSpace,
  resolveTimelineIsAtEnd,
  type TimelineScrollMode
} from './timelineScrollAnchoring'
import { buildExpandedImagePreview, type ExpandedImagePreview } from './ExpandedImagePreview'

interface Props {
  detail: ThreadDetail
  onOpenDiff: (turnId: string) => void
  /** clicked message images expand into ChatView's lightbox overlay */
  onImageExpand?: (preview: ExpandedImagePreview) => void
  /** Live height of the floating composer overlay — reserved below the last
   *  message so content can always scroll clear of the input. */
  bottomInset?: number
}

// ---------------------------------------------------------------------------
// Contexts — shared state flows to rows through context so renderItem can be a
// zero-dependency callback that propagates through LegendList's memo boundary.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  onOpenDiff: (turnId: string) => void
  onToggleTurnFold: (turnId: string) => void
  onToggleWorkGroup: (groupId: string, anchorKey: string) => void
  onImageExpand: (preview: ExpandedImagePreview) => void
}

interface TimelineRowActivityState {
  workingStepLabel: string | null
}

const TimelineRowCtx = createContext<TimelineRowSharedState>({
  onOpenDiff: () => {},
  onToggleTurnFold: () => {},
  onToggleWorkGroup: () => {},
  onImageExpand: () => {}
})
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>({ workingStepLabel: null })

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string }): JSX.Element {
  switch (name) {
    case 'bot':
      return <Bot className={className} aria-hidden />
    case 'check':
      return <Check className={className} aria-hidden />
    case 'circle-alert':
      return <CircleAlert className={className} aria-hidden />
    case 'eye':
      return <Eye className={className} aria-hidden />
    case 'globe':
      return <Globe className={className} aria-hidden />
    case 'list-todo':
      return <ListTodo className={className} aria-hidden />
    case 'square-pen':
      return <SquarePen className={className} aria-hidden />
    case 'terminal':
      return <Terminal className={className} aria-hidden />
    case 'wrench':
      return <Wrench className={className} aria-hidden />
    case 'x':
      return <X className={className} aria-hidden />
    case 'zap':
      return <Zap className={className} aria-hidden />
  }
}

// ---------------------------------------------------------------------------
// Shared bits: copy button + timestamp tooltip
// ---------------------------------------------------------------------------

const COPY_RESET_TIMEOUT_MS = 1000

/** React 18 + Base UI: the trigger must stay the native element (refs on plain
 *  function components are stripped), so it is styled via buttonVariants. */
function MessageCopyButton({
  text,
  size = 'xs',
  variant = 'outline',
  className
}: {
  text: string
  size?: 'xs' | 'icon-xs'
  variant?: 'outline' | 'ghost'
  className?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), COPY_RESET_TIMEOUT_MS)
  }
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Copy to clipboard"
        className={cn(buttonVariants({ variant, size }), 'text-muted-foreground hover:text-foreground', className)}
        onClick={copy}
      >
        {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>Copy to clipboard</p>
      </TooltipPopup>
    </Tooltip>
  )
}

function TimestampTooltip({ ts }: { ts: number }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={<p className="text-xs text-muted-foreground tabular-nums" />}>
        {formatDayAwareTimestamp(ts)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(ts)}</TooltipPopup>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// User message row
// ---------------------------------------------------------------------------

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600
const COLLAPSED_USER_MESSAGE_FADE_MASK = 'linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)'

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) return false
  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH || text.split('\n').length > MAX_COLLAPSED_USER_MESSAGE_LINES
  )
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody({ text }: { text: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasVisibleBody = text.trim().length > 0
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(text)
  const isCollapsed = canCollapse && !expanded

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn('relative', isCollapsed && 'max-h-44 overflow-hidden')}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? 'true' : 'false'}
          style={
            isCollapsed
              ? { WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK, maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK }
              : undefined
          }
        >
          <ChatMarkdown text={text} className="text-message-foreground" lineBreaks />
        </div>
      ) : null}
      {canCollapse ? (
        <div className="mt-1.5 flex items-center justify-end gap-2" data-user-message-footer="true">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            data-scroll-anchor-ignore
            onClick={() => setExpanded((value) => !value)}
            className="-ml-1 h-6 rounded-md px-1.5 text-xs text-secondary-label hover:bg-muted/55 hover:text-message-foreground"
          >
            {expanded ? 'Show less' : 'Show full message'}
          </Button>
        </div>
      ) : null}
    </div>
  )
})

const UserTimelineRow = memo(function UserTimelineRow({
  row
}: {
  row: Extract<MessagesTimelineRow, { kind: 'message' }>
}): JSX.Element {
  const ctx = useContext(TimelineRowCtx)
  const userImages = (row.message.attachments ?? []).map((a) => ({ id: a.id, name: a.name, previewUrl: a.dataUrl }))
  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        {userImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {userImages.map((image) => (
              <div key={image.id} className="overflow-hidden rounded-lg border border-border/80 bg-background/70">
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(userImages, image.id)
                      if (!preview) return
                      ctx.onImageExpand(preview)
                    }}
                  >
                    <img src={image.previewUrl} alt={image.name} className="block h-auto max-h-[220px] w-full object-cover" />
                  </button>
                ) : (
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-secondary-label">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <CollapsibleUserMessageBody text={row.message.text} />
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <TimestampTooltip ts={row.message.createdAt} />
          <div className="flex items-center gap-0.5">
            {row.message.text.trim().length > 0 && <MessageCopyButton text={row.message.text} variant="ghost" />}
          </div>
        </div>
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Changed files card (collapsed t3 presentation — Thread has summary stats only)
// ---------------------------------------------------------------------------

function formatCompactDiffCount(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const k = value / 1000
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`
  }
  const m = value / 1_000_000
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}m`
}

function DiffStatLabel({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className="inline-flex items-center gap-1 align-middle text-xs leading-4 tabular-nums"
    >
      <span className="text-success">+{formatCompactDiffCount(additions)}</span>
      <span className="text-destructive">−{formatCompactDiffCount(deletions)}</span>
    </span>
  )
}

/** Per-turn UI + data caches at module scope so LegendList recycling doesn't
 *  reset expansion or refetch immutable turn diffs (t3 persists these in its
 *  uiStateStore for the same reason). */
const changedFilesExpandedByTurn = new Map<string, boolean>()
const changedFilesAllDirsExpandedByTurn = new Map<string, boolean>()
const turnDiffFilesCache = new Map<string, TurnDiffFileChange[]>()

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {}

const ChangedFilesTree = memo(function ChangedFilesTree({
  files,
  allDirectoriesExpanded,
  onOpenFileDiff
}: {
  files: ReadonlyArray<TurnDiffFileChange>
  allDirectoriesExpanded: boolean
  onOpenFileDiff: (filePath: string) => void
}): JSX.Element {
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files])
  const directoryPathsKey = useMemo(() => collectDirectoryPaths(treeNodes).join('\u0000'), [treeNodes])
  const hasDirectoryNodes = directoryPathsKey.length > 0
  const expansionStateKey = `${allDirectoriesExpanded ? 'expanded' : 'collapsed'}\u0000${directoryPathsKey}`
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string
    overrides: Record<string, boolean>
  }>(() => ({ key: expansionStateKey, overrides: {} }))
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey ? directoryExpansionState.overrides : EMPTY_DIRECTORY_OVERRIDES

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides = current.key === expansionStateKey ? current.overrides : {}
        return {
          key: expansionStateKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded)
          }
        }
      })
    },
    [allDirectoriesExpanded, expansionStateKey]
  )

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number): JSX.Element => {
    const leftPadding = 8 + depth * 14
    if (node.kind === 'directory') {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            className="group flex w-full items-center gap-1.5 rounded-xl py-1 pr-3 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80',
                isExpanded && 'rotate-90'
              )}
            />
            {isExpanded ? (
              <Folder className="size-3.5 shrink-0 text-muted-foreground/75" />
            ) : (
              <FolderClosed className="size-3.5 shrink-0 text-muted-foreground/75" />
            )}
            <span className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover:text-foreground/90">
              {node.name}
            </span>
            {(node.stat.additions > 0 || node.stat.deletions > 0) && (
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            )}
          </button>
          {isExpanded && <div className="space-y-0.5">{node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}</div>}
        </div>
      )
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className="group flex w-full items-center gap-1.5 rounded-xl py-1 pr-3 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenFileDiff(node.path)}
      >
        {hasDirectoryNodes || depth > 0 ? <span aria-hidden="true" className="size-3.5 shrink-0" /> : null}
        <File className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate font-mono text-[11px] text-muted-foreground/80 group-hover:text-foreground/90">
          {node.name}
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    )
  }

  return <div className="space-y-0.5">{treeNodes.map((node) => renderTreeNode(node, 0))}</div>
})

const ChangedFilesCard = memo(function ChangedFilesCard({
  checkpoint,
  turnId
}: {
  checkpoint: Checkpoint
  turnId: string
}): JSX.Element {
  const { onOpenDiff } = useContext(TimelineRowCtx)
  const threadId = checkpoint.threadId
  const cacheKey = `${threadId}:${turnId}`
  const [expanded, setExpandedState] = useState(() => changedFilesExpandedByTurn.get(cacheKey) ?? false)
  const [allDirectoriesExpanded, setAllDirectoriesExpandedState] = useState(
    () => changedFilesAllDirsExpandedByTurn.get(cacheKey) ?? true
  )
  const [files, setFiles] = useState<TurnDiffFileChange[] | 'error' | null>(
    () => turnDiffFilesCache.get(cacheKey) ?? null
  )

  // A turn's diff is immutable once the checkpoint exists — fetch once and
  // cache at module scope so list recycling doesn't refetch.
  useEffect(() => {
    if (files !== null) return
    let cancelled = false
    useServer
      .getState()
      .getDiff(threadId, { kind: 'turn', turnId })
      .then(
        (result) => {
          if (result.error) {
            if (!cancelled) setFiles('error')
            return
          }
          const next = result.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }))
          turnDiffFilesCache.set(cacheKey, next)
          if (!cancelled) setFiles(next)
        },
        () => {
          if (!cancelled) setFiles('error')
        }
      )
    return () => {
      cancelled = true
    }
  }, [files, threadId, turnId, cacheKey])

  const resolvedFiles = Array.isArray(files) ? files : null
  const fileCount = resolvedFiles ? resolvedFiles.length : checkpoint.filesChanged
  const summaryStat = resolvedFiles
    ? summarizeTurnDiffStats(resolvedFiles)
    : { additions: checkpoint.additions, deletions: checkpoint.deletions }

  const setExpanded = (next: boolean): void => {
    changedFilesExpandedByTurn.set(cacheKey, next)
    setExpandedState(next)
  }
  const toggleAllDirectories = (): void => {
    const next = !allDirectoriesExpanded
    changedFilesAllDirsExpandedByTurn.set(cacheKey, next)
    setAllDirectoriesExpandedState(next)
  }
  // Opening focused on a file: onOpenDiff retargets the diff scope (which
  // clears the selection), so the file selection must land after it.
  const openTurnDiff = (filePath?: string): void => {
    onOpenDiff(turnId)
    if (filePath) useUi.getState().setDiffSelectedFile(filePath)
  }

  return (
    <div
      className="@container/changed-files mt-4 rounded-2xl border border-border/70 bg-secondary p-2 dark:border-transparent dark:bg-input/32"
      data-changed-files-state={expanded ? 'expanded' : 'collapsed'}
    >
      <div
        data-changed-files-header=""
        className={cn(
          'flex items-center justify-between gap-2 rounded-xl',
          expanded && 'sticky top-2 z-10 mb-2 bg-secondary dark:bg-[color-mix(in_srgb,var(--foreground)_2.5%,var(--background))]'
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          data-scroll-anchor-ignore
          className="group flex min-w-0 flex-1 items-center rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <ChevronRight
              aria-hidden="true"
              className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
            />
            <span className="flex shrink-0 items-center gap-1 text-xs leading-4 font-medium whitespace-nowrap text-foreground">
              <span>
                {fileCount} changed file{fileCount === 1 ? '' : 's'}
              </span>
              {(summaryStat.additions > 0 || summaryStat.deletions > 0) && (
                <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
              )}
            </span>
            <span className="ml-1 hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground group-hover:text-foreground/80 @[24rem]/changed-files:inline">
              {expanded ? 'Hide files' : 'Show files'}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5 pr-1">
          {expanded ? (
            <Tooltip>
              <TooltipTrigger
                aria-label={allDirectoriesExpanded ? 'Collapse all folders' : 'Expand all folders'}
                data-scroll-anchor-ignore
                className={cn(buttonVariants({ variant: 'outline', size: 'icon-xs' }), '!size-[22px]')}
                onClick={toggleAllDirectories}
              >
                {allDirectoriesExpanded ? <ChevronsDownUp className="size-3" /> : <ChevronsUpDown className="size-3" />}
              </TooltipTrigger>
              <TooltipPopup side="top">{allDirectoriesExpanded ? 'Collapse all folders' : 'Expand all folders'}</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              aria-label="Open diff"
              className={buttonVariants({ variant: 'outline', size: 'xs' })}
              onClick={() => openTurnDiff(resolvedFiles?.[0]?.path)}
            >
              <FileDiff className="size-3" />
              <span className="hidden @[24rem]/changed-files:inline">Open diff</span>
            </TooltipTrigger>
            <TooltipPopup side="top">Open the full diff</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {expanded ? (
        resolvedFiles && resolvedFiles.length > 0 ? (
          <ChangedFilesTree
            key={`changed-files-tree:${turnId}`}
            files={resolvedFiles}
            allDirectoriesExpanded={allDirectoriesExpanded}
            onOpenFileDiff={(filePath) => openTurnDiff(filePath)}
          />
        ) : (
          <p className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">
            {files === null ? 'Loading files…' : files === 'error' ? 'File details unavailable.' : 'No files changed.'}
          </p>
        )
      ) : null}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Assistant message row
// ---------------------------------------------------------------------------

const AssistantTimelineRow = memo(function AssistantTimelineRow({
  row
}: {
  row: Extract<MessagesTimelineRow, { kind: 'message' }>
}): JSX.Element {
  const messageText = row.message.text || (row.message.streaming ? '' : '(empty response)')
  const copyText = row.message.text.trim()
  const copyVisible = row.showAssistantCopyButton && copyText.length > 0 && !row.assistantCopyStreaming

  return (
    <div className="relative min-w-0 px-1 py-0.5">
      <ChatMarkdown text={messageText} />
      {row.checkpoint && row.turnId ? <ChangedFilesCard checkpoint={row.checkpoint} turnId={row.turnId} /> : null}
      {row.showAssistantMeta ? (
        <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100">
          {copyVisible && <MessageCopyButton text={row.message.text} variant="ghost" />}
          {!row.message.streaming && <TimestampTooltip ts={row.message.updatedAt} />}
        </div>
      ) : null}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Work log rows (PlainWorkEntryRow port)
// ---------------------------------------------------------------------------

const toolCallExpandedBodyClassName =
  'max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-[0.6875rem] leading-relaxed select-text'

const stopRowToggle = (e: SyntheticEvent): void => e.stopPropagation()

const PlainWorkEntryRow = memo(function PlainWorkEntryRow({ workEntry }: { workEntry: TimelineWorkEntry }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const tone = workEntryTone(workEntry)
  const iconConfig = workToneIcon(tone)
  const entryIconName = workEntryIconName(workEntry)
  const heading = toolWorkEntryHeading(workEntry)
  const rawPreview = workEntryPreview(workEntry)
  const preview =
    rawPreview && normalizeCompactToolLabel(rawPreview).toLowerCase() === normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview
  const displayText = preview ? `${heading} - ${preview}` : heading
  const expandedBody = buildToolCallExpandedBody(workEntry)
  const canExpand = expandedBody !== null
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry)
  const showDestructiveRowStyle = showFailedIndicator && !workLogEntryIsToolLike(workEntry)
  const showSuccessIndicator = workEntryIndicatesToolSuccess(workEntry)
  const iconWrapperClass = cn(
    'flex size-5 shrink-0 items-center justify-center',
    showDestructiveRowStyle
      ? 'text-destructive'
      : tone === 'tool' || showFailedIndicator
        ? 'text-icon-muted'
        : iconConfig.className
  )
  const headingClass = showDestructiveRowStyle ? 'font-medium text-destructive' : 'font-medium text-foreground'
  const rowToggleProps = canExpand
    ? {
        role: 'button' as const,
        tabIndex: 0 as const,
        'aria-label': displayText,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded((v) => !v)
          }
        }
      }
    : {}

  return (
    <div
      className={cn(
        'flex flex-col rounded-md px-0.5 py-0.5 transition-colors',
        canExpand &&
          'cursor-pointer hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none'
      )}
      {...rowToggleProps}
    >
      <div className="flex items-center gap-1.5 transition-[opacity,translate] duration-200 select-none">
        <span className={iconWrapperClass}>
          <WorkEntryIconSvg name={entryIconName} className="block size-3.5 shrink-0 stroke-[1.8] opacity-80" />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex w-full min-w-0 items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn('min-w-0 shrink truncate', headingClass)}>{heading}</span>
              {preview && <span className="min-w-0 flex-1 truncate text-secondary-label">{preview}</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-icon-muted">
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden={!canExpand}>
              {canExpand ? (
                <ChevronDown
                  className={cn('size-3 shrink-0 opacity-70 transition-transform duration-200', expanded && 'rotate-180')}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" aria-label="Tool call failed" />}
                  >
                    <X className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex size-4 items-center justify-center" />}>
                    <Check className="block size-3 shrink-0 stroke-current" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      {expanded && canExpand && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
        </div>
      ) : null}
    </div>
  )
})

/** Renders one or more already-derived work log rows. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries
}: {
  groupedEntries: TimelineWorkEntry[]
}): JSX.Element | null {
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry)),
    [groupedEntries]
  )
  const onlyToolEntries = nonEmptyEntries.every((entry) => workLogEntryIsToolLike(entry))
  const groupLabel = onlyToolEntries
    ? nonEmptyEntries.length === 1
      ? '1 tool call'
      : `${nonEmptyEntries.length} tool calls`
    : 'Work Log'

  if (nonEmptyEntries.length === 0) return null

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label={groupLabel}>
      {!onlyToolEntries && <p className="px-0.5 pb-0.5 text-[11px] font-medium text-secondary-label">{groupLabel}</p>}
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <PlainWorkEntryRow key={workEntryId(workEntry)} workEntry={workEntry} />
        ))}
      </div>
    </section>
  )
})

function WorkGroupToggleTimelineRow({ row }: { row: Extract<MessagesTimelineRow, { kind: 'work-toggle' }> }): JSX.Element {
  const ctx = useContext(TimelineRowCtx)
  const labelNoun = row.onlyToolEntries
    ? row.hiddenCount === 1
      ? 'tool call'
      : 'tool calls'
    : row.hiddenCount === 1
      ? 'log entry'
      : 'log entries'

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none"
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-icon-muted">
        <ChevronDown
          className={cn('size-3.5 shrink-0 opacity-70 transition-transform duration-200', row.expanded && 'rotate-180')}
        />
      </span>
      {row.expanded ? (
        <span className="font-medium text-foreground">Show fewer {row.onlyToolEntries ? 'tool calls' : 'log entries'}</span>
      ) : (
        <span className="font-medium text-foreground">
          +{row.hiddenCount} previous {labelNoun}
        </span>
      )}
    </button>
  )
}

function TurnFoldTimelineRow({ row }: { row: Extract<MessagesTimelineRow, { kind: 'turn-fold' }> }): JSX.Element {
  const ctx = useContext(TimelineRowCtx)
  const Icon = row.expanded ? ChevronDown : ChevronRight

  return (
    <div className="border-b border-border/60 pt-1 pb-2">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId)}
        className="flex cursor-pointer items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset focus-visible:outline-none"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
    </div>
  )
}

function ProposedPlanTimelineRow({ row }: { row: Extract<MessagesTimelineRow, { kind: 'proposed-plan' }> }): JSX.Element {
  return (
    <div className="min-w-0 px-1 py-0.5">
      <div className="rounded-xl border border-violet/30 bg-violet/5 px-3.5 py-3">
        <div className="mb-1.5 flex items-center gap-[7px] text-xs font-semibold text-violet">
          <ListTodo className="size-[13px]" /> Proposed plan
        </div>
        <ChatMarkdown text={row.proposedPlan.text} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Working indicator
// ---------------------------------------------------------------------------

function formatWorkingTimer(startMs: number, endMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000))
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`

  const hours = Math.floor(elapsedSeconds / 3600)
  const minutes = Math.floor((elapsedSeconds % 3600) / 60)
  const seconds = elapsedSeconds % 60

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

/** Self-ticking "Working for Xs" label — mutates its own text node so the
 *  once-a-second clock never produces a React commit while streaming. */
function WorkingTimer({ createdAt }: { createdAt: number }): JSX.Element {
  const textRef = useRef<HTMLSpanElement>(null)
  const [initialText] = useState(() => formatWorkingTimer(createdAt, Date.now()))

  useEffect(() => {
    const updateText = (): void => {
      if (textRef.current) textRef.current.textContent = formatWorkingTimer(createdAt, Date.now())
    }
    updateText()
    const id = setInterval(updateText, 1000)
    return () => clearInterval(id)
  }, [createdAt])

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  )
}

function WorkingTimelineRow({ row }: { row: Extract<MessagesTimelineRow, { kind: 'working' }> }): JSX.Element {
  const { workingStepLabel } = useContext(TimelineRowActivityCtx)
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex min-w-0 items-center gap-2 pt-1 text-[11px] text-secondary-label tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 animate-status-pulse rounded-full bg-muted-foreground/30" />
          <span className="h-1 w-1 animate-status-pulse rounded-full bg-muted-foreground/30 [animation-delay:200ms]" />
          <span className="h-1 w-1 animate-status-pulse rounded-full bg-muted-foreground/30 [animation-delay:400ms]" />
        </span>
        <span className="shrink-0">
          {row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            'Working...'
          )}
        </span>
        {workingStepLabel ? <span className="min-w-0 truncate text-muted-foreground/55">· {workingStepLabel}</span> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row dispatcher
// ---------------------------------------------------------------------------

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: MessagesTimelineRow }): JSX.Element {
  return (
    <div
      className={cn(
        (row.kind === 'message' && row.message.role === 'assistant' && !row.showAssistantMeta) ||
          row.kind === 'work' ||
          row.kind === 'work-toggle'
          ? 'pb-2'
          : 'pb-4',
        row.kind === 'message' && row.message.role === 'assistant' ? 'group/assistant' : null
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === 'message' ? row.message.id : undefined}
      data-message-role={row.kind === 'message' ? row.message.role : undefined}
    >
      {row.kind === 'work' ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === 'work-toggle' ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === 'turn-fold' ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === 'message' && row.message.role === 'user' ? <UserTimelineRow row={row} /> : null}
      {row.kind === 'message' && row.message.role !== 'user' ? <AssistantTimelineRow row={row} /> : null}
      {row.kind === 'proposed-plan' ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === 'working' ? <WorkingTimelineRow row={row} /> : null}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Minimap (t3 port)
// ---------------------------------------------------------------------------

interface TimelineMinimapItem {
  readonly id: string
  readonly rowIndex: number
  readonly userText: string | null
  readonly assistantText: string | null
}

interface TimelinePositionState {
  readonly contentLength?: number
  readonly scroll?: number
  readonly scrollLength?: number
  readonly positionAtIndex?: (index: number) => number | undefined
  readonly sizeAtIndex?: (index: number) => number | undefined
}

function deriveTimelineMinimapItems(rows: ReadonlyArray<MessagesTimelineRow>): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row?.kind !== 'message' || row.message.role !== 'user') continue

    items.push({
      id: row.id,
      rowIndex: index,
      userText: compactMinimapPreview(row.message.text),
      assistantText: compactMinimapPreview(resolveFinalAssistantTextForTurn(rows, index))
    })
  }
  return items
}

function resolveFinalAssistantTextForTurn(rows: ReadonlyArray<MessagesTimelineRow>, userRowIndex: number): string | null {
  let finalAssistantText: string | null = null
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]
    if (row?.kind !== 'message') continue
    if (row.message.role === 'user') break
    if (row.message.role === 'assistant') finalAssistantText = row.message.text ?? null
  }
  return finalAssistantText
}

function compactMinimapPreview(text: string | null | undefined): string | null {
  const compact = text?.replace(/\s+/g, ' ').trim() ?? ''
  return compact.length > 0 ? compact : null
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number): number | null {
  const top = state.positionAtIndex?.(rowIndex)
  return typeof top === 'number' && Number.isFinite(top) ? top : null
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number): number | null {
  const height = state.sizeAtIndex?.(rowIndex)
  return typeof height === 'number' && Number.isFinite(height) ? height : null
}

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest('[data-minimap-preview]') !== null
}

function TimelineMinimap({
  hasPersistentGutter,
  hitStripWidth,
  items,
  stripMap,
  onSelect
}: {
  hasPersistentGutter: boolean
  hitStripWidth: number
  items: ReadonlyArray<TimelineMinimapItem>
  stripMap: Map<string, HTMLSpanElement>
  onSelect: (item: TimelineMinimapItem) => void
}): JSX.Element | null {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const resolvedActiveIndex = activeIndex !== null && activeIndex < items.length ? activeIndex : null
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null)
  const activeTopPercent =
    resolvedActiveIndex === null ? 0 : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length)
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? '-50%'
      : resolvedActiveIndex === 0
        ? '0%'
        : resolvedActiveIndex === items.length - 1
          ? '-100%'
          : '-50%'

  const resolveActiveIndexFromPointer = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY
      })
    },
    [items.length]
  )

  const updateActiveIndexFromPointer = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      setActiveIndex(resolveActiveIndexFromPointer(event))
    },
    [resolveActiveIndexFromPointer]
  )

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0
        return Math.max(0, Math.min(items.length - 1, base + delta))
      })
    },
    [items.length]
  )

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) return null

  return (
    <div
      className={cn(
        'group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block',
        hasPersistentGutter
          ? 'opacity-100'
          : 'opacity-0 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100'
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? 'true' : 'false'}
    >
      <div className="relative h-full w-full select-none">
        <button
          aria-label={`Jump to message: ${activeItem?.userText ?? 'User message'}`}
          className={cn(
            'absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none',
            // The strip is width-capped to the side gutter so it never overlays
            // the centered content column; with no usable gutter it goes inert.
            hitStripWidth > 0 ? 'pointer-events-auto' : 'pointer-events-none'
          )}
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            if (timelineMinimapEventTargetsPreview(event.target)) return
            const nextIndex = resolveActiveIndexFromPointer(event)
            const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null)
            if (nextItem) onSelect(nextItem)
            event.currentTarget.blur()
          }}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveActiveIndex(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveActiveIndex(-1)
            } else if (event.key === 'Home') {
              event.preventDefault()
              setActiveIndex(0)
            } else if (event.key === 'End') {
              event.preventDefault()
              setActiveIndex(items.length - 1)
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              if (activeItem) onSelect(activeItem)
            }
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={updateActiveIndexFromPointer}
          onMouseDown={(event) => {
            if (timelineMinimapEventTargetsPreview(event.target)) return
            event.preventDefault()
          }}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(hitStripWidth, activeItem !== null)
          }}
          type="button"
        >
          <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
          {items.map((item, index) => {
            const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`
            const activeDistance = resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex)
            return (
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90',
                  activeDistance === 0
                    ? 'w-6 bg-muted-foreground/75'
                    : activeDistance === 1
                      ? 'w-4'
                      : activeDistance === 2
                        ? 'w-2.5'
                        : 'w-2'
                )}
                data-in-view="false"
                data-minimap-strip
                key={item.id}
                ref={(node) => {
                  if (node) stripMap.set(item.id, node)
                  else stripMap.delete(item.id)
                }}
                style={{ top }}
              />
            )
          })}
          {activeItem ? (
            <span
              className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
              data-minimap-preview
              onMouseMove={(event) => event.stopPropagation()}
              style={{ top: `${activeTopPercent}%`, transform: `translateY(${activeTooltipTranslate})` }}
            >
              <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                <span className="block max-w-full overflow-hidden text-sm leading-5 font-medium text-ellipsis whitespace-nowrap">
                  {activeItem.userText ?? 'User message'}
                </span>
                {activeItem.assistantText ? (
                  <span
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-sm leading-5 text-muted-foreground"
                    style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3 }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner + scroll orchestration
// (t3's MessagesTimeline + the ChatView scroll modes, folded into one file
//  since Thread's ChatView keeps its thin contract)
// ---------------------------------------------------------------------------

const TIMELINE_LIST_HEADER = <div className="h-4" />
const TIMELINE_LIST_FOOTER = <div className="h-4" />

const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    itemLayout: true,
    layout: true
  }
} as const

const NOOP_IMAGE_EXPAND = (): void => {}

function keyExtractor(item: MessagesTimelineRow): string {
  return item.id
}

function getItemType(item: MessagesTimelineRow): string {
  return item.kind === 'message' ? `message:${item.message.role}` : item.kind
}

/** Structural sharing across derivations (t3's useStableRows) — a deliberate
 *  render-phase memo cache, so the ref access is intentional here. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({ byId: new Map(), result: [] })
  return useMemo(() => {
    // eslint-disable-next-line react-hooks/refs
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current)
    // eslint-disable-next-line react-hooks/refs
    prevState.current = nextState
    return nextState.result
  }, [rows])
}

export function MessagesTimeline({ detail, onOpenDiff, onImageExpand, bottomInset = 0 }: Props): JSX.Element {
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(() => new Set())
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(() => new Set())
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false)
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>())
  const disclosureAnchorKeyRef = useRef<string | null>(null)
  const disclosureSettleFrameRef = useRef<number | null>(null)
  const disclosureSettleSecondFrameRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (disclosureSettleFrameRef.current !== null) cancelAnimationFrame(disclosureSettleFrameRef.current)
      if (disclosureSettleSecondFrameRef.current !== null) cancelAnimationFrame(disclosureSettleSecondFrameRef.current)
    }
  }, [])

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string) => {
    disclosureAnchorKeyRef.current = anchorKey
    setDisclosureToggleSettling(true)
    if (disclosureSettleFrameRef.current !== null) cancelAnimationFrame(disclosureSettleFrameRef.current)
    if (disclosureSettleSecondFrameRef.current !== null) cancelAnimationFrame(disclosureSettleSecondFrameRef.current)
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null
        setDisclosureToggleSettling(false)
        disclosureSettleFrameRef.current = null
        disclosureSettleSecondFrameRef.current = null
      })
    })
  }, [])

  const shouldRestoreVisibleContentPosition = useCallback((row: MessagesTimelineRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey
  }, [])

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition
    }),
    [shouldRestoreVisibleContentPosition]
  )

  const onToggleTurnFold = useCallback(
    (turnId: string) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`)
      setExpandedTurnIds((existing) => {
        const next = new Set(existing)
        if (next.has(turnId)) next.delete(turnId)
        else next.add(turnId)
        return next
      })
    },
    [suspendEndScrollMaintenanceForDisclosure]
  )
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey)
      setExpandedWorkGroupIds((existing) => {
        const next = new Set(existing)
        if (next.has(groupId)) next.delete(groupId)
        else next.add(groupId)
        return next
      })
    },
    [suspendEndScrollMaintenanceForDisclosure]
  )

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  const latestTurn = useMemo(() => {
    let latest: { turnId: string; state: string } | null = null
    let latestStartedAt = -Infinity
    for (const t of detail.turns) {
      if (t.startedAt > latestStartedAt) {
        latestStartedAt = t.startedAt
        latest = { turnId: t.id, state: t.state }
      }
    }
    return latest
  }, [detail.turns])
  const previousLatestTurnRef = useRef(latestTurn)
  useEffect(() => {
    const previous = previousLatestTurnRef.current
    previousLatestTurnRef.current = latestTurn
    if (!latestTurn || previous?.turnId === undefined) return
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === 'running' && latestTurn.state === 'interrupted') {
        setExpandedTurnIds((existing) => {
          const next = new Set(existing)
          next.add(latestTurn.turnId)
          return next
        })
      }
      return
    }
    setExpandedTurnIds((existing) => {
      if (!existing.has(previous.turnId)) return existing
      const next = new Set(existing)
      next.delete(previous.turnId)
      return next
    })
  }, [latestTurn])

  const rawRows = useMemo(
    () => deriveMessagesTimelineRows({ detail, expandedTurnIds, expandedWorkGroupIds }),
    // keyed on the arrays/objects the derivation reads — the reducer replaces
    // exactly what an event touched, nothing else
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      detail.thread,
      detail.turns,
      detail.messages,
      detail.workItems,
      detail.plans,
      detail.checkpoints,
      expandedTurnIds,
      expandedWorkGroupIds
    ]
  )
  const rows = useStableRows(rawRows)
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows])
  const workingStepLabel = useMemo(
    () => deriveWorkingStepLabel(detail),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.workItems, detail.messages]
  )

  const listRef = useRef<LegendListRef | null>(null)
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(null)
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false)
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0)

  // --- scroll orchestration (t3 ChatView port) -----------------------------

  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [timelineLiveFollowEnabled, setTimelineLiveFollowEnabled] = useState(true)
  const [anchorMessageId, setAnchorMessageId] = useState<string | null>(null)
  const showPillTimerRef = useRef<number | null>(null)
  const timelineScrollModeRef = useRef<TimelineScrollMode>('following-end')
  const isAtEndRef = useRef(true)
  const pendingTimelineAnchorRef = useRef<string | null>(null)
  const positionedTimelineAnchorRef = useRef<string | null>(null)
  const settledTimelineAnchorRef = useRef<string | null>(null)
  const activeTimelineAnchorIndexRef = useRef<number | null>(null)
  const anchorUserScrollGenerationRef = useRef(0)
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0)
  /** last user message id — `false` until the first derivation initializes it */
  const lastUserMessageIdRef = useRef<string | null | false>(false)
  const bottomInsetRef = useRef(bottomInset)
  useLayoutEffect(() => {
    bottomInsetRef.current = bottomInset
  }, [bottomInset])

  useEffect(() => {
    return () => {
      if (showPillTimerRef.current != null) clearTimeout(showPillTimerRef.current)
    }
  }, [])

  const cancelShowPill = useCallback(() => {
    if (showPillTimerRef.current != null) {
      clearTimeout(showPillTimerRef.current)
      showPillTimerRef.current = null
    }
  }, [])

  // Debounce *showing* the pill so it doesn't flash while the list settles;
  // hiding is always immediate (t3's Debouncer wait: 150).
  const maybeShowPill = useCallback(() => {
    if (showPillTimerRef.current != null) return
    showPillTimerRef.current = window.setTimeout(() => {
      showPillTimerRef.current = null
      setShowScrollToBottom(true)
    }, 150)
  }, [])

  // Manual navigation stops live-follow without removing anchored end space —
  // collapsing that space during a gesture clamps the viewport back to the end.
  const cancelTimelineLiveFollowForUserNavigation = useCallback(() => {
    anchorUserScrollGenerationRef.current += 1
    timelineScrollModeRef.current = 'free-scrolling'
    liveFollowUserScrollGenerationRef.current = null
    setTimelineLiveFollowEnabled(false)
    pendingTimelineAnchorRef.current = null
    positionedTimelineAnchorRef.current = null
    settledTimelineAnchorRef.current = null
    activeTimelineAnchorIndexRef.current = null
  }, [])

  const getActiveTimelineTurnMetrics = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? listRef.current
      const anchorIndex = activeTimelineAnchorIndexRef.current
      const state = resolvedList?.getState()
      if (!resolvedList || !state || anchorIndex === null) return null

      return getAnchoredTurnMetrics({
        state,
        anchorIndex,
        composerOverlayHeight: bottomInset,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET
      })
    },
    [bottomInset]
  )

  const timelineRealContentOverflowsViewport = useCallback(() => {
    const state = listRef.current?.getState()
    if (!state || state.data.length === 0) return false

    const lastRowIndex = state.data.length - 1
    const lastRowTop = state.positionAtIndex(lastRowIndex)
    const lastRowHeight = state.sizeAtIndex(lastRowIndex)
    if (
      typeof lastRowTop !== 'number' ||
      typeof lastRowHeight !== 'number' ||
      !Number.isFinite(lastRowTop) ||
      !Number.isFinite(lastRowHeight)
    ) {
      return false
    }

    const realContentBottom = lastRowTop + Math.max(1, lastRowHeight)
    const visibleScrollLength = Math.max(0, (state.scrollLength ?? 0) - bottomInsetRef.current - CHAT_LIST_ANCHOR_OFFSET)
    return realContentBottom > visibleScrollLength
  }, [])

  // Live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  const scrollToEnd = useCallback(
    (animated = false) => {
      isAtEndRef.current = true
      timelineScrollModeRef.current = 'following-end'
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current
      setTimelineLiveFollowEnabled(true)
      pendingTimelineAnchorRef.current = null
      activeTimelineAnchorIndexRef.current = null
      cancelShowPill()
      setShowScrollToBottom(false)
      setAnchorMessageId((current) => (current === null ? current : null))
      requestAnimationFrame(() => {
        void listRef.current?.scrollToEnd?.({ animated })
      })
    },
    [cancelShowPill]
  )

  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      if (!isAtEnd && liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current) {
        cancelShowPill()
        setShowScrollToBottom(false)
        return
      }
      if (isAtEndRef.current === isAtEnd) return
      isAtEndRef.current = isAtEnd
      if (isAtEnd) {
        timelineScrollModeRef.current = 'following-end'
        liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current
        setTimelineLiveFollowEnabled(true)
        cancelShowPill()
        setShowScrollToBottom(false)
      } else {
        timelineScrollModeRef.current = 'free-scrolling'
        liveFollowUserScrollGenerationRef.current = null
        maybeShowPill()
      }
    },
    [cancelShowPill, maybeShowPill]
  )

  // Gesture opt-out listeners on the list's scroll node, retried across frames
  // because the list may not have mounted on the first frame.
  useEffect(() => {
    let removeListeners: (() => void) | null = null
    let frame: number | null = null
    const attach = (remainingAttempts: number): void => {
      frame = requestAnimationFrame(() => {
        frame = null
        const scrollNode = listRef.current?.getScrollableNode()
        if (!scrollNode) {
          if (remainingAttempts > 0) attach(remainingAttempts - 1)
          return
        }
        const handleManualNavigation = (): void => {
          cancelTimelineLiveFollowForUserNavigation()
        }
        const contentScrollsUp = (): boolean => timelineRealContentOverflowsViewport()
        const viewportIsAwayFromEnd = (): boolean =>
          resolveTimelineIsAtEnd(listRef.current?.getState(), bottomInsetRef.current) === false
        // Only an upward wheel is a navigation intent; wheeling down while
        // following either does nothing (at the end) or moves toward it.
        const handleWheel = (event: WheelEvent): void => {
          if (event.deltaY < 0 && contentScrollsUp()) handleManualNavigation()
        }
        // Touch direction isn't observable here — break only once the drag has
        // actually carried the viewport out of the end band.
        const handleTouchMove = (): void => {
          if (viewportIsAwayFromEnd()) handleManualNavigation()
        }
        // Scrollbar drags are the only pointerdowns whose target is the scroll
        // node itself. Content clicks break follow only away from the end.
        const handlePointerDown = (event: PointerEvent): void => {
          if (event.target === scrollNode) {
            if (contentScrollsUp()) handleManualNavigation()
            return
          }
          if (viewportIsAwayFromEnd()) handleManualNavigation()
        }
        // Keyboard scrolling bypasses wheel and pointer events entirely.
        const handleKeyDown = (event: KeyboardEvent): void => {
          switch (event.key) {
            case 'PageUp':
            case 'Home':
            case 'ArrowUp':
              if (contentScrollsUp()) handleManualNavigation()
              break
            default:
              break
          }
        }
        scrollNode.addEventListener('wheel', handleWheel, { passive: true })
        scrollNode.addEventListener('touchmove', handleTouchMove, { passive: true })
        scrollNode.addEventListener('pointerdown', handlePointerDown, { passive: true })
        scrollNode.addEventListener('keydown', handleKeyDown)
        removeListeners = () => {
          scrollNode.removeEventListener('wheel', handleWheel)
          scrollNode.removeEventListener('touchmove', handleTouchMove)
          scrollNode.removeEventListener('pointerdown', handlePointerDown)
          scrollNode.removeEventListener('keydown', handleKeyDown)
        }
      })
    }
    attach(12)

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      removeListeners?.()
    }
  }, [cancelTimelineLiveFollowForUserNavigation, timelineRealContentOverflowsViewport])

  // Sending always returns to the live edge: a new trailing user message
  // becomes the anchored end-space target so it lands near the top while the
  // response streams into the reserved space below it.
  useLayoutEffect(() => {
    let lastUserId: string | null = null
    for (const row of rows) {
      if (row.kind === 'message' && row.message.role === 'user') lastUserId = row.message.id
    }
    if (lastUserMessageIdRef.current === false) {
      lastUserMessageIdRef.current = lastUserId
      return
    }
    if (lastUserId !== null && lastUserId !== lastUserMessageIdRef.current) {
      lastUserMessageIdRef.current = lastUserId
      isAtEndRef.current = true
      timelineScrollModeRef.current = 'anchoring-new-turn'
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current
      setTimelineLiveFollowEnabled(true)
      pendingTimelineAnchorRef.current = lastUserId
      activeTimelineAnchorIndexRef.current = null
      cancelShowPill()
      setShowScrollToBottom(false)
      setAnchorMessageId(lastUserId)
    } else {
      lastUserMessageIdRef.current = lastUserId
    }
  }, [rows, cancelShowPill])

  // Anchor positioning: once the anchor row and everything after it have
  // authoritative sizes, scroll the sent message near the viewport top.
  const onTimelineAnchorReady = useCallback((messageId: string, anchorIndex: number) => {
    // Anchored-end space can be remeasured when the turn completes. Once the
    // user has scrolled away (or returned to ordinary end-following), that
    // remeasurement must not restart the send-time anchor positioning.
    if (timelineScrollModeRef.current !== 'anchoring-new-turn') return
    if (pendingTimelineAnchorRef.current === messageId) pendingTimelineAnchorRef.current = null
    activeTimelineAnchorIndexRef.current = anchorIndex
    if (positionedTimelineAnchorRef.current === messageId) return
    positionedTimelineAnchorRef.current = messageId
    settledTimelineAnchorRef.current = null
    const positionAnchor = (remainingAttempts: number): void => {
      requestAnimationFrame(() => {
        if (positionedTimelineAnchorRef.current !== messageId) return
        const list = listRef.current
        if (!list) {
          if (remainingAttempts > 0) positionAnchor(remainingAttempts - 1)
          return
        }
        void list
          .scrollToIndex({ index: anchorIndex, animated: true, viewPosition: 0, viewOffset: CHAT_LIST_ANCHOR_OFFSET })
          .then(() => {
            if (positionedTimelineAnchorRef.current !== messageId) return
            settledTimelineAnchorRef.current = messageId
          })
      })
    }
    requestAnimationFrame(() => positionAnchor(12))
  }, [])

  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onTimelineAnchorReady(anchorMessageId, info.anchorIndex)
      }
    },
    [anchorMessageId, onTimelineAnchorReady]
  )
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(rows, anchorMessageId, (row) =>
      row.kind === 'message' ? row.message.id : null
    )
    return config ? { ...config, onReady: handleAnchorReady } : undefined
  }, [anchorMessageId, handleAnchorReady, rows])

  // Anchored end space intentionally disables the list's normal end-follow so
  // the sent message can stay near the top; while streaming grows the turn
  // past the usable viewport, nudge the scroll to keep revealing the end.
  useEffect(() => {
    if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) return
    if (timelineScrollModeRef.current !== 'anchoring-new-turn') return

    let secondFrame: number | null = null
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) return
        if (pendingTimelineAnchorRef.current !== null) return
        if (
          positionedTimelineAnchorRef.current !== null &&
          settledTimelineAnchorRef.current !== positionedTimelineAnchorRef.current
        ) {
          return
        }
        const list = listRef.current
        if (!list) return

        const metrics = getActiveTimelineTurnMetrics(list)
        if (!metrics || metrics.scrollDeltaToRevealEnd <= 1) return

        const nextOffset = list.getState().scroll + metrics.scrollDeltaToRevealEnd
        void list.scrollToOffset({ offset: nextOffset, animated: false })
      })
    })

    return () => {
      cancelAnimationFrame(frame)
      if (secondFrame !== null) cancelAnimationFrame(secondFrame)
    }
  }, [rows, getActiveTimelineTurnMetrics])

  // Scroll handler: follow re-arm + pill + minimap in-view strips. Writes to
  // cached DOM nodes so per-frame scrolls never re-render React.
  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState()
    const isAtEnd = resolveTimelineIsAtEnd(state, bottomInsetRef.current)
    if (isAtEnd !== undefined) onIsAtEndChange(isAtEnd)
    if (!state || minimapItems.length === 0) return

    const scrollTop = state.scroll ?? 0
    const scrollBottom = scrollTop + (state.scrollLength ?? 0)

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id)
      if (!strip) continue

      const rowTop = resolveTimelineRowTop(state, item.rowIndex)
      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex)
      const inView = rowTop !== null && rowTop < scrollBottom && rowTop + Math.max(1, rowHeight ?? 1) > scrollTop

      strip.dataset.inView = inView ? 'true' : 'false'
    }
  }, [minimapItems, minimapStripMap, onIsAtEndChange])

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll)
    return () => cancelAnimationFrame(frame)
  }, [handleScroll, rows.length])

  // Minimap gutter measurement.
  useEffect(() => {
    if (!timelineViewportElement) return

    const measure = (): void => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(viewportWidth)
      setMinimapHasPersistentGutter((current) => (current === nextHasPersistentGutter ? current : nextHasPersistentGutter))
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth))
    }

    const frame = requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(timelineViewportElement)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [timelineViewportElement, rows.length])

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({ onOpenDiff, onToggleTurnFold, onToggleWorkGroup, onImageExpand: onImageExpand ?? NOOP_IMAGE_EXPAND }),
    [onOpenDiff, onToggleTurnFold, onToggleWorkGroup, onImageExpand]
  )
  const activityState = useMemo<TimelineRowActivityState>(() => ({ workingStepLabel }), [workingStepLabel])

  // Stable renderItem — no closure deps. Row components read shared state from
  // context, which propagates through LegendList's memo boundary.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    []
  )

  if (rows.length === 0) {
    // empty threads show the hero composer overlay instead (ChatView)
    return <div className="min-h-0 flex-1" />
  }

  return (
    <TooltipProvider>
      <TimelineRowCtx.Provider value={sharedState}>
        <TimelineRowActivityCtx.Provider value={activityState}>
          <div ref={setTimelineViewportElement} className="relative h-full min-h-0 flex-1">
            {/* eslint-disable react-hooks/refs -- anchoredEndSpace carries the
                anchor onReady callback (which touches scroll refs only when the
                list invokes it post-layout); the rule over-taints the config. */}
            <LegendList<MessagesTimelineRow>
              ref={listRef}
              data={rows}
              keyExtractor={keyExtractor}
              getItemType={getItemType}
              renderItem={renderItem}
              estimatedItemSize={90}
              initialScrollAtEnd
              {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
              contentInsetEndAdjustment={bottomInset}
              maintainScrollAtEnd={
                anchoredEndSpace || !timelineLiveFollowEnabled || disclosureToggleSettling
                  ? false
                  : TIMELINE_MAINTAIN_SCROLL_AT_END
              }
              maintainVisibleContentPosition={maintainVisibleContentPosition}
              onScroll={handleScroll}
              className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-5 [overflow-anchor:none]"
              ListHeaderComponent={TIMELINE_LIST_HEADER}
              ListFooterComponent={TIMELINE_LIST_FOOTER}
            />
            {/* eslint-enable react-hooks/refs */}
            <TimelineMinimap
              items={minimapItems}
              hasPersistentGutter={minimapHasPersistentGutter}
              hitStripWidth={minimapHitStripWidth}
              stripMap={minimapStripMap}
              onSelect={(item) => {
                cancelTimelineLiveFollowForUserNavigation()
                void listRef.current?.scrollToIndex({ index: item.rowIndex, animated: true, viewOffset: 24 })
              }}
            />

            {showScrollToBottom && (
              <div
                className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
                style={{ bottom: bottomInset + 4 }}
              >
                <Button
                  aria-label="Scroll to end"
                  size="xs"
                  variant="glass"
                  className="pointer-events-auto gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground"
                  onClick={() => scrollToEnd(true)}
                >
                  <ChevronDown className="size-3.5" /> Scroll to end
                </Button>
              </div>
            )}
          </div>
        </TimelineRowActivityCtx.Provider>
      </TimelineRowCtx.Provider>
    </TooltipProvider>
  )
}
