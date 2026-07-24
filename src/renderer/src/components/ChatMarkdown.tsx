import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUi, type FileTarget } from '../state/uiStore'

/** Parse a chat file reference — `src/foo.ts`, `foo.ts:42`, `src/foo.ts#L42` —
 * into a path + line. Returns null for anything that doesn't look like a file. */
function parseFileRef(raw: string): FileTarget | null {
  let path = raw.trim()
  let line: number | null = null
  const hash = path.match(/^(.*?)#L(\d+)(?:-L?\d+)?$/)
  const colon = path.match(/^(.*?):(\d+)(?:[:-]\d+)?$/)
  if (hash) {
    path = hash[1]
    line = parseInt(hash[2], 10)
  } else if (colon) {
    path = colon[1]
    line = parseInt(colon[2], 10)
  }
  path = path.replace(/^\.\//, '')
  // segments of word chars/dots/dashes, ending in a letter-led extension — rejects prose, versions ("1.5"), URLs
  if (!/^\/?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z]\w{0,9}$/.test(path)) return null
  return { path, line }
}

/** Open a referenced file over the active thread (chat is always the active thread). */
function openFileRef(target: FileTarget): void {
  const ui = useUi.getState()
  if (ui.activeThreadId) ui.openFile(ui.activeThreadId, target)
}

/** A compact, dependency-free markdown renderer covering the constructs the
 * agent emits: fenced code, headings, lists, blockquotes, inline code, bold,
 * italic, links (system browser), and file references (in-app file viewer). */
export function ChatMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="text-[13px] leading-relaxed text-foreground/80 [&_strong]:font-semibold [&_strong]:text-foreground">
      {renderBlocks(text)}
    </div>
  )
}

function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // fenced code block
    const fence = line.match(/^```(\w+)?\s*$/)
    if (fence) {
      const lang = fence[1] ?? ''
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++])
      i++ // closing fence
      out.push(<CodeBlock key={key++} lang={lang} code={buf.join('\n')} />)
      continue
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const Tag = (`h${Math.min(level + 2, 6)}`) as keyof JSX.IntrinsicElements
      out.push(
        <Tag key={key++} className="mt-3.5 mb-2 text-[13px] font-semibold text-foreground first:mt-0">
          {renderInline(h[2])}
        </Tag>
      )
      i++
      continue
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      out.push(
        <blockquote key={key++} className="mb-2.5 border-l-[3px] border-input px-3 py-1 text-muted-foreground">
          {renderInline(buf.join(' '))}
        </blockquote>
      )
      continue
    }

    // list (ordered or unordered)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''))
      }
      const ListTag = ordered ? 'ol' : 'ul'
      out.push(
        <ListTag key={key++} className={`mb-2.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, idx) => (
            <li key={idx} className="my-[3px]">
              {renderInline(it)}
            </li>
          ))}
        </ListTag>
      )
      continue
    }

    // blank line
    if (line.trim() === '') {
      i++
      continue
    }

    // paragraph (gather consecutive non-empty, non-special lines)
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i++])
    }
    out.push(
      <p key={key++} className="mb-2.5 last:mb-0">
        {renderInline(buf.join('\n'))}
      </p>
    )
  }

  return out
}

function CodeBlock({ lang, code }: { lang: string; code: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="mb-2.5 overflow-hidden rounded-[10px] border bg-background">
      <div className="flex items-center justify-between border-b bg-popover px-2.5 py-[5px]">
        <span className="font-mono text-[10.5px] text-muted-foreground">{lang || 'text'}</span>
        <Button
          variant="ghost"
          size="xs"
          className="h-auto gap-[5px] px-1 py-0.5 text-[10.5px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
          onClick={copy}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="m-0 overflow-x-auto p-3">
        <code className="font-mono text-xs leading-[1.55] text-foreground/80">{code}</code>
      </pre>
    </div>
  )
}

/** Inline formatting: `code`, **bold**, *italic*, [text](url). */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // italic requires non-space chars just inside the asterisks so "a * b * c" isn't emphasized
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s](?:[^*]*[^*\s])?\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      const inner = tok.slice(1, -1)
      const fileRef = parseFileRef(inner)
      nodes.push(
        fileRef ? (
          <code
            key={key++}
            className="cursor-pointer rounded-[5px] border bg-muted px-[5px] py-px font-mono text-[0.85em] hover:border-sky/50 hover:text-sky"
            title={`Open ${fileRef.path}${fileRef.line != null ? ` at line ${fileRef.line}` : ''}`}
            onClick={() => openFileRef(fileRef)}
          >
            {inner}
          </code>
        ) : (
          <code key={key++} className="rounded-[5px] border bg-muted px-[5px] py-px font-mono text-[0.85em]">
            {inner}
          </code>
        )
      )
    }
    else if (tok.startsWith('**')) nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('*')) nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    else {
      const linkMatch = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (linkMatch) {
        const [, label, url] = linkMatch
        // no scheme → a file reference into the project; try the label too, it often carries the :line
        const external = /^[a-z][a-z0-9+.-]*:/i.test(url)
        const fileRef = external ? null : (parseFileRef(url) ?? parseFileRef(label))
        nodes.push(
          <a
            key={key++}
            className="border-b border-dotted border-sky/50 text-sky no-underline hover:border-solid"
            href={url}
            title={fileRef ? `Open ${fileRef.path}${fileRef.line != null ? ` at line ${fileRef.line}` : ''}` : url}
            onClick={(e) => {
              e.preventDefault()
              if (fileRef) openFileRef(fileRef)
              else void window.native.openExternal(url)
            }}
          >
            {label}
          </a>
        )
      } else nodes.push(tok)
    }
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}
