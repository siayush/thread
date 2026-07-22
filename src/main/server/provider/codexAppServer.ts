/**
 * Minimal newline-delimited JSON-RPC client for `codex app-server`.
 *
 * It spawns the `codex` CLI in `app-server` mode and speaks its stdio protocol —
 * one JSON object per line, `{ id, method, params }` for requests, `{ method,
 * params }` for notifications, `{ id, result | error }` for responses. Codex
 * does not require the `"jsonrpc": "2.0"` envelope field, so we omit it.
 *
 * The client is transport-only: it correlates request/response ids, routes
 * server→client notifications and requests to registered handlers, and lets the
 * caller respond to server requests (the approval prompts).
 *
 * @module provider/codexAppServer
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

type Json = unknown
type NotificationHandler = (params: any) => void // eslint-disable-line @typescript-eslint/no-explicit-any
type ServerRequestHandler = (params: any) => Promise<Json> // eslint-disable-line @typescript-eslint/no-explicit-any

interface Pending {
  resolve: (v: Json) => void
  reject: (e: Error) => void
}

export interface CodexAppServerOptions {
  readonly binaryPath?: string
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  readonly onStderr?: (line: string) => void
  readonly onExit?: (code: number | null) => void
}

export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, Pending>()
  private notificationHandlers = new Map<string, NotificationHandler>()
  private requestHandlers = new Map<string, ServerRequestHandler>()
  private stdoutBuf = ''
  private stderrBuf = ''
  private closed = false

  constructor(opts: CodexAppServerOptions) {
    const binary = opts.binaryPath || process.env.CODEX_BINARY || 'codex'
    this.child = spawn(binary, ['app-server'], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env }
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuf += chunk
      const lines = this.stderrBuf.split('\n')
      this.stderrBuf = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) opts.onStderr?.(line)
    })
    this.child.on('error', (err) => this.failAll(err))
    this.child.on('exit', (code) => {
      this.closed = true
      this.failAll(new Error(`codex app-server exited (${code})`))
      opts.onExit?.(code)
    })
  }

  /** Register a handler for a server→client notification (fire-and-forget). */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler)
  }

  /** Register a handler for a server→client request; its result is sent back. */
  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  /** Send a request and await its response. */
  request(method: string, params?: Json): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('codex app-server is closed'))
    const id = this.nextId++
    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: Json): void {
    if (this.closed) return
    this.write({ method, ...(params !== undefined ? { params } : {}) })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error('closed'))
    this.child.kill('SIGKILL')
  }

  // ---------- internals ----------
  private write(msg: Record<string, Json>): void {
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private respond(id: string | number, result: Json): void {
    this.write({ id, result })
  }

  private respondError(id: string | number, message: string): void {
    this.write({ id, error: { code: -32601, message } })
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    const lines = this.stdoutBuf.split('\n')
    this.stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let msg: any // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        msg = JSON.parse(trimmed)
      } catch {
        continue
      }
      this.route(msg)
    }
  }

  private route(msg: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const hasId = msg?.id !== undefined && msg?.id !== null
    const isResponse = hasId && (('result' in msg) || ('error' in msg)) && typeof msg.method !== 'string'
    if (isResponse) {
      const pending = this.pending.get(Number(msg.id))
      if (!pending) return
      this.pending.delete(Number(msg.id))
      if (msg.error) pending.reject(new Error(msg.error?.message ?? 'codex request error'))
      else pending.resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string' && hasId) {
      // server → client request; must respond
      const handler = this.requestHandlers.get(msg.method)
      if (!handler) {
        this.respondError(msg.id, `method not found: ${msg.method}`)
        return
      }
      handler(msg.params)
        .then((result) => this.respond(msg.id, result))
        .catch((err) => this.respondError(msg.id, err instanceof Error ? err.message : String(err)))
      return
    }
    if (typeof msg.method === 'string') {
      this.notificationHandlers.get(msg.method)?.(msg.params)
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }
}
