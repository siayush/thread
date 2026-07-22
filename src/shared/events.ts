/**
 * The append-only domain event log (CQRS write model). The projector folds
 * these into read-model tables; subscriptions replay/stream them by `seq`.
 */
import type {
  ApprovalKind,
  InteractionMode,
  MessageRole,
  RuntimeMode,
  SessionStatus,
  TurnState,
  WorkItemType,
  WorkStatus,
  WorkTone
} from './domain'

export type EventType = OrchestrationEvent['type']

interface Base {
  /** monotonically increasing, assigned by the event store on append */
  seq: number
  id: string
  ts: number
  /** aggregate/stream this event belongs to: a threadId, projectId, or 'root' */
  streamId: string
}

export type OrchestrationEvent =
  | (Base & { type: 'project.created'; payload: { projectId: string; name: string; folderPath: string; isGitRepo: boolean } })
  | (Base & { type: 'project.updated'; payload: { projectId: string; name?: string } })
  | (Base & { type: 'project.opened'; payload: { projectId: string } })
  | (Base & { type: 'project.removed'; payload: { projectId: string } })
  | (Base & { type: 'thread.created'; payload: { threadId: string; projectId: string; title: string; interactionMode: InteractionMode; runtimeMode: RuntimeMode; model: string | null; reasoningEffort: string | null } })
  | (Base & { type: 'thread.updated'; payload: { threadId: string; title?: string; interactionMode?: InteractionMode; runtimeMode?: RuntimeMode; model?: string | null; reasoningEffort?: string | null } })
  | (Base & { type: 'thread.visited'; payload: { threadId: string } })
  | (Base & { type: 'thread.deleted'; payload: { threadId: string } })
  | (Base & { type: 'thread.session'; payload: { threadId: string; status?: SessionStatus; sdkSessionId?: string | null; lastError?: string | null } })
  | (Base & { type: 'turn.started'; payload: { threadId: string; turnId: string } })
  | (Base & { type: 'turn.completed'; payload: { threadId: string; turnId: string; state: TurnState; assistantMessageId: string | null; costUsd: number | null } })
  | (Base & { type: 'message.created'; payload: { messageId: string; threadId: string; turnId: string | null; role: MessageRole; text: string; streaming: boolean } })
  | (Base & { type: 'message.delta'; payload: { messageId: string; threadId: string; delta: string } })
  | (Base & { type: 'message.completed'; payload: { messageId: string; threadId: string; text: string } })
  | (Base & { type: 'work.upserted'; payload: WorkUpsert })
  | (Base & { type: 'checkpoint.created'; payload: { checkpointId: string; threadId: string; turnId: string; filesChanged: number; additions: number; deletions: number } })
  | (Base & { type: 'plan.proposed'; payload: { planId: string; threadId: string; turnId: string; text: string } })
  | (Base & { type: 'approval.requested'; payload: { requestId: string; threadId: string; turnId: string | null; toolName: string; kind: ApprovalKind; detail: string; input: Record<string, unknown> } })
  | (Base & { type: 'approval.resolved'; payload: { requestId: string; threadId: string } })

export interface WorkUpsert {
  workId: string
  threadId: string
  turnId: string
  tone: WorkTone
  status: WorkStatus
  itemType: WorkItemType
  toolName: string | null
  title: string
  detail: string | null
  body: string | null
  changedFiles: string[]
}

/** Distributive Omit so the discriminated union is preserved across members. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event before the store assigns it a sequence number. */
export type NewEvent = DistributiveOmit<OrchestrationEvent, 'seq'>
