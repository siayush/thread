import type { AgentHost } from './types'

const DELTA_FLUSH_MS = 100

export interface DeltaBatcher {
  /** Buffer a delta for `messageId`; switching message flushes the previous one. */
  queue: (messageId: string, text: string) => void
  /** Persist whatever is buffered now (also runs on the ~100ms timer). */
  flush: () => void
}

/** One persisted message.delta per ~100ms instead of one event per token. */
export function createDeltaBatcher(host: AgentHost, threadId: string, turnId: string): DeltaBatcher {
  let buf = ''
  let msgId: string | null = null
  let timer: NodeJS.Timeout | null = null
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (msgId && buf) host.onAssistantTextDelta(threadId, turnId, msgId, buf)
    buf = ''
  }
  const queue = (messageId: string, text: string): void => {
    if (msgId && msgId !== messageId) flush()
    msgId = messageId
    buf += text
    timer ??= setTimeout(flush, DELTA_FLUSH_MS)
  }
  return { queue, flush }
}
