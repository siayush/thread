/**
 * Commands the renderer dispatches to the server (write side).
 * The engine runs each through the decider → events → projections → broadcast.
 */
import type { ApprovalDecision, InteractionMode, RuntimeMode } from './domain'

export type Command =
  | { type: 'project.add'; folderPath: string; name?: string }
  | { type: 'project.rename'; projectId: string; name: string }
  | { type: 'project.remove'; projectId: string }
  | { type: 'project.open'; projectId: string }
  | { type: 'thread.create'; projectId: string; title?: string }
  | { type: 'thread.rename'; threadId: string; title: string }
  | { type: 'thread.delete'; threadId: string }
  | { type: 'thread.visit'; threadId: string }
  | {
      type: 'thread.setConfig'
      threadId: string
      interactionMode?: InteractionMode
      runtimeMode?: RuntimeMode
      model?: string | null
      reasoningEffort?: string | null
    }
  | { type: 'turn.send'; threadId: string; text: string }
  | { type: 'turn.interrupt'; threadId: string }
  | { type: 'approval.respond'; threadId: string; requestId: string; decision: ApprovalDecision }

export type CommandType = Command['type']

export interface CommandResult {
  ok: boolean
  error?: string
  /** e.g. the id of a newly created project/thread */
  data?: Record<string, unknown>
}
