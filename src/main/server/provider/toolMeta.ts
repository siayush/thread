/**
 * Shared tool → work-item mapping.
 *
 * Both the Claude and Codex handlers normalize provider-native tool calls into
 * the same canonical `WorkItem` shape, so the timeline renders identically no
 * matter which vendor ran the tool. Kept vendor-neutral: keyed on the canonical
 * tool names (`Bash`, `Read`, `Edit`, `Write`, …) both handlers agree to use.
 *
 * @module provider/toolMeta
 */
import type { ApprovalKind, WorkItemType } from '@shared/domain'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toolMeta(
  name: string,
  input: any
): { itemType: WorkItemType; title: string; detail: string | null; changedFiles: string[] } {
  const n = name.toLowerCase()
  if (name === 'Bash') return { itemType: 'command_execution', title: 'Ran command', detail: input?.command ?? null, changedFiles: [] }
  if (name === 'Read' || name === 'NotebookRead') return { itemType: 'file_read', title: 'Read file', detail: input?.file_path ?? input?.notebook_path ?? null, changedFiles: [] }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update'].includes(name)) {
    const path = input?.file_path ?? input?.notebook_path ?? null
    return { itemType: 'file_change', title: name === 'Write' ? 'Wrote file' : 'Edited file', detail: path, changedFiles: path ? [path] : [] }
  }
  if (name === 'Glob' || name === 'Grep') return { itemType: 'generic', title: name === 'Glob' ? 'Searched files' : 'Searched code', detail: input?.pattern ?? null, changedFiles: [] }
  if (name === 'WebSearch') return { itemType: 'web_search', title: 'Web search', detail: input?.query ?? null, changedFiles: [] }
  if (name === 'WebFetch') return { itemType: 'web_search', title: 'Fetched URL', detail: input?.url ?? null, changedFiles: [] }
  if (name === 'TodoWrite') return { itemType: 'todo', title: 'Updated plan', detail: summarizeTodos(input?.todos), changedFiles: [] }
  if (name === 'Task') return { itemType: 'generic', title: 'Ran subagent', detail: input?.description ?? null, changedFiles: [] }
  if (n.startsWith('mcp__')) return { itemType: 'mcp_tool_call', title: name.replace(/^mcp__/, ''), detail: null, changedFiles: [] }
  return { itemType: 'generic', title: name, detail: null, changedFiles: [] }
}

export function summarizeTodos(todos: any): string | null {
  if (!Array.isArray(todos)) return null
  const done = todos.filter((t) => t.status === 'completed').length
  return `${done}/${todos.length} done`
}

export function approvalKind(name: string): ApprovalKind {
  if (name === 'Bash') return 'command'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'file-change'
  if (name === 'Read' || name === 'NotebookRead') return 'file-read'
  return 'other'
}

export function stringifyToolResult(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : JSON.stringify(c))).join('\n')
  }
  return content == null ? '' : JSON.stringify(content, null, 2)
}

export function bodyForInput(name: string, input: any): string | null {
  if (['Edit', 'MultiEdit'].includes(name) && input?.old_string != null) {
    return `- ${input.old_string}\n+ ${input.new_string ?? ''}`
  }
  if (name === 'Write' && input?.content != null) return String(input.content).slice(0, 4000)
  if (name === 'TodoWrite' && Array.isArray(input?.todos)) {
    return input.todos.map((t: any) => `${t.status === 'completed' ? '✔' : '○'} ${t.content}`).join('\n')
  }
  return null
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function sanitizeTitle(raw: string): string | null {
  let t = (raw.split('\n').find((l) => l.trim()) ?? '').trim()
  // strip surrounding quotes and a leading "Title:" label the model sometimes adds
  t = t.replace(/^title\s*[:\-]\s*/i, '').replace(/^["'`]|["'`]$/g, '').trim()
  t = t.replace(/[.,;:!?]+$/, '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  const words = t.split(' ')
  if (words.length > 10) t = words.slice(0, 10).join(' ')
  return t.length > 80 ? t.slice(0, 80).trim() : t
}

export function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim()) ?? ''
  return line.length > 140 ? line.slice(0, 140) + '…' : line
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s
}

export const TITLE_PROMPT = [
  'You write concise thread titles for coding conversations.',
  'Reply with ONLY the title text — nothing else.',
  'Rules:',
  "- Summarize the user's request, do not restate it verbatim.",
  '- Keep it short and specific (3-8 words).',
  '- No quotes, no filler, no prefixes, no trailing punctuation.'
].join('\n')
