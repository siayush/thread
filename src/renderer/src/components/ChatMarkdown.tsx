import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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

/** Minimal hast shape — enough to pull language + source out of a `pre > code`. */
interface HastNode {
  type?: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

function hastText(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToPlainText).join('')
  if (node != null && typeof node === 'object' && 'props' in node) {
    return nodeToPlainText((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
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

const headingClass = 'mt-3.5 mb-2 text-[13px] font-semibold text-foreground first:mt-0'
const cellClass = 'border-b px-3 py-1.5 text-left align-top last:border-r-0'

/** Element overrides for react-markdown. Module-level constant: everything it
 * closes over is imperative (store reads), so no per-render identity churn. */
const components: Components = {
  p: ({ children }) => <p className="mb-2.5 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className={headingClass}>{children}</h3>,
  h2: ({ children }) => <h4 className={headingClass}>{children}</h4>,
  h3: ({ children }) => <h5 className={headingClass}>{children}</h5>,
  h4: ({ children }) => <h6 className={headingClass}>{children}</h6>,
  h5: ({ children }) => <h6 className={headingClass}>{children}</h6>,
  h6: ({ children }) => <h6 className={headingClass}>{children}</h6>,
  ul: ({ children }) => <ul className="mb-2.5 list-disc pl-5 [&_ol]:mb-0 [&_ul]:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2.5 list-decimal pl-5 [&_ol]:mb-0 [&_ul]:mb-0">{children}</ol>,
  li: ({ children }) => <li className="my-[3px]">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2.5 border-l-[3px] border-input px-3 py-1 text-muted-foreground [&_p]:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  details: ({ children }) => (
    <details className="group mb-2.5 rounded-[10px] border px-3 py-2">{children}</details>
  ),
  summary: ({ children }) => (
    <summary className="cursor-pointer select-none text-foreground group-open:mb-2">{children}</summary>
  ),
  table: ({ children }) => (
    <div className="mb-2.5 overflow-x-auto rounded-[10px] border">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-popover">{children}</thead>,
  th: ({ children }) => (
    <th className={cn(cellClass, 'border-r font-semibold text-foreground')}>{children}</th>
  ),
  td: ({ children }) => <td className={cn(cellClass, 'border-r')}>{children}</td>,
  tr: ({ children }) => <tr className="last:[&>td]:border-b-0">{children}</tr>,

  // Fenced blocks: pull language + source straight from the hast node so the
  // inline `code` override below never has to guess block vs inline.
  pre: ({ node, children }) => {
    const codeNode = (node as HastNode | undefined)?.children?.find((c) => c.tagName === 'code')
    if (!codeNode) return <pre className="mb-2.5 overflow-x-auto">{children}</pre>
    const className = Array.isArray(codeNode.properties?.className)
      ? codeNode.properties.className.join(' ')
      : ''
    const lang = /language-(\S+)/.exec(className)?.[1] ?? ''
    return <CodeBlock lang={lang} code={hastText(codeNode).replace(/\n$/, '')} />
  },

  // Inline code only (block code is consumed by `pre` above). File-looking
  // spans open the in-app file viewer.
  code: ({ children }) => {
    const inner = nodeToPlainText(children)
    const fileRef = parseFileRef(inner)
    if (fileRef) {
      return (
        <code
          role="button"
          tabIndex={0}
          className="cursor-pointer rounded-[5px] border bg-muted px-[5px] py-px font-mono text-[0.85em] outline-none hover:border-sky/50 hover:text-sky focus-visible:ring-3 focus-visible:ring-ring/50"
          title={`Open ${fileRef.path}${fileRef.line != null ? ` at line ${fileRef.line}` : ''}`}
          onClick={() => openFileRef(fileRef)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openFileRef(fileRef)
            }
          }}
        >
          {children}
        </code>
      )
    }
    return <code className="rounded-[5px] border bg-muted px-[5px] py-px font-mono text-[0.85em]">{children}</code>
  },

  // Links: no scheme → a file reference into the project (the label often
  // carries the :line); otherwise open in the system browser.
  a: ({ href = '', children }) => {
    const label = nodeToPlainText(children)
    const external = /^[a-z][a-z0-9+.-]*:/i.test(href)
    const fileRef = external ? null : (parseFileRef(href) ?? parseFileRef(label))
    return (
      <a
        className="border-b border-dotted border-sky/50 text-sky no-underline hover:border-solid"
        href={href}
        title={fileRef ? `Open ${fileRef.path}${fileRef.line != null ? ` at line ${fileRef.line}` : ''}` : href}
        onClick={(e) => {
          e.preventDefault()
          if (fileRef) openFileRef(fileRef)
          else void window.native.openExternal(href)
        }}
      >
        {children}
      </a>
    )
  },
}

const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeRaw, rehypeSanitize]

/** Chat markdown renderer: react-markdown + remark-gfm (tables, task lists,
 * strikethrough), with Thread-specific overrides for code blocks, file
 * references (in-app file viewer), and links (system browser).
 * Memoized: rendering is pure in `text`, and during streaming every other
 * message's markdown must not re-parse per delta. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="text-[13px] leading-relaxed text-foreground/80 [&_strong]:font-semibold [&_strong]:text-foreground">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
