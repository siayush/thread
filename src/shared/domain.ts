/**
 * Core domain entities. These are the read-model shapes the projector builds
 * from the event log and the renderer renders. Follows the
 * Project → Thread → (Messages / Turns / WorkItems / Checkpoints / Plans) model.
 */

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error'

/** Build = normal agent, Plan = read-only planning mode. */
export type InteractionMode = 'build' | 'plan'

/**
 * Runtime mode maps onto the Claude SDK permissionMode:
 *  supervised        -> 'default'          (ask before commands & edits)
 *  auto-accept-edits -> 'acceptEdits'      (auto-accept edits, ask for the rest)
 *  full-access       -> 'bypassPermissions'(never ask)
 */
export type RuntimeMode = 'supervised' | 'auto-accept-edits' | 'full-access'

export interface Project {
  id: string
  name: string
  folderPath: string
  isGitRepo: boolean
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
}

export interface Thread {
  id: string
  projectId: string
  title: string
  status: SessionStatus
  interactionMode: InteractionMode
  runtimeMode: RuntimeMode
  model: string | null
  /** reasoning-effort level; null = provider default */
  reasoningEffort: string | null
  /** the Claude SDK session id, for multi-turn resume */
  sdkSessionId: string | null
  activeTurnId: string | null
  lastError: string | null
  hasPendingApproval: boolean
  createdAt: number
  updatedAt: number
  lastVisitedAt: number
  latestActivityAt: number
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'reasoning'

export interface Message {
  id: string
  threadId: string
  turnId: string | null
  role: MessageRole
  text: string
  streaming: boolean
  createdAt: number
  updatedAt: number
}

export type TurnState = 'running' | 'completed' | 'interrupted' | 'error'

export interface Turn {
  id: string
  threadId: string
  state: TurnState
  assistantMessageId: string | null
  startedAt: number
  completedAt: number | null
  costUsd: number | null
}

/** tone drives the icon/color */
export type WorkTone = 'tool' | 'thinking' | 'info' | 'error'
export type WorkStatus = 'inProgress' | 'completed' | 'failed'
/** canonical tool-item categories */
export type WorkItemType =
  | 'command_execution'
  | 'file_change'
  | 'file_read'
  | 'web_search'
  | 'mcp_tool_call'
  | 'todo'
  | 'reasoning'
  | 'generic'

export interface WorkItem {
  id: string
  threadId: string
  turnId: string
  tone: WorkTone
  status: WorkStatus
  itemType: WorkItemType
  toolName: string | null
  title: string
  /** short preview line (command / path / summary) */
  detail: string | null
  /** full expandable body (command output, MCP payload, etc.) */
  body: string | null
  /** files touched by a file_change item */
  changedFiles: string[]
  createdAt: number
  updatedAt: number
}

export interface Checkpoint {
  id: string
  threadId: string
  turnId: string
  filesChanged: number
  additions: number
  deletions: number
  createdAt: number
}

export interface ProposedPlan {
  id: string
  threadId: string
  turnId: string
  text: string
  createdAt: number
}

export type ApprovalKind = 'command' | 'file-change' | 'file-read' | 'other'

export interface PendingApproval {
  id: string // requestId
  threadId: string
  turnId: string | null
  toolName: string
  kind: ApprovalKind
  detail: string
  input: Record<string, unknown>
  createdAt: number
}

/** Lightweight sidebar projection. */
export interface ThreadSummary {
  id: string
  projectId: string
  title: string
  status: SessionStatus
  interactionMode: InteractionMode
  hasPendingApproval: boolean
  latestActivityAt: number
  updatedAt: number
  lastVisitedAt: number
}

export interface ShellSnapshot {
  projects: Project[]
  threads: ThreadSummary[]
}

/** Full detail for one open thread. */
export interface ThreadDetail {
  thread: Thread
  messages: Message[]
  turns: Turn[]
  workItems: WorkItem[]
  plans: ProposedPlan[]
  checkpoints: Checkpoint[]
  pendingApprovals: PendingApproval[]
}

export type ApprovalDecision =
  | { behavior: 'allow'; scope: 'once' | 'session' }
  | { behavior: 'deny'; message?: string }

/**
 * Which vendor handler backs a turn.
 *  - `claude`     = Anthropic (bundled Claude Code CLI)
 *  - `codexAgent` = OpenAI via the `codex` CLI app-server (auth = `codex login`)
 */
export type ProviderKind = 'claude' | 'codexAgent'

/** available models surfaced in the composer picker */
export interface ModelOption {
  value: string
  label: string
  description: string
  /** which provider handler runs this model */
  provider: ProviderKind
  /** real model id to pass the provider, when it differs from `value` (routing prefix stripped) */
  slug?: string
  /** effort levels this model supports, ascending; empty/undefined hides the selector */
  reasoningEfforts?: string[]
  /** the model's default effort; null = no explicit default */
  defaultReasoningEffort?: string | null
}

export const RUNTIME_MODE_TO_PERMISSION: Record<RuntimeMode, string> = {
  supervised: 'default',
  'auto-accept-edits': 'acceptEdits',
  'full-access': 'bypassPermissions'
}
