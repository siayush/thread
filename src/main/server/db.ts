import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'

const require = createRequire(import.meta.url)

/**
 * A thin synchronous SQLite wrapper over sql.js (WASM — no native build).
 * The whole DB is held in memory and flushed to a single file, debounced,
 * after each write. This is the "local JSON file"-equivalent, but real SQL.
 */
export class Db {
  private db: Database
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  private constructor(
    db: Database,
    private readonly filePath: string
  ) {
    this.db = db
  }

  static async open(filePath: string): Promise<Db> {
    const wasmDir = dirname(require.resolve('sql.js'))
    const SQL: SqlJsStatic = await initSqlJs({
      locateFile: (file: string) => join(wasmDir, file)
    })
    mkdirSync(dirname(filePath), { recursive: true })
    const db = Db.load(SQL, filePath)
    const instance = new Db(db, filePath)
    instance.migrate()
    return instance
  }

  /** Load the DB file; if it's unreadable/corrupt, set it aside and start fresh. */
  private static load(SQL: SqlJsStatic, filePath: string): Database {
    if (!existsSync(filePath)) return new SQL.Database()
    try {
      const db = new SQL.Database(readFileSync(filePath))
      // cheap integrity probe — throws if the file is truncated/corrupt
      db.exec('SELECT 1')
      return db
    } catch {
      try {
        renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      return new SQL.Database()
    }
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY, value TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        stream_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_stream ON events (stream_id, seq);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT, folder_path TEXT, is_git_repo INTEGER,
        created_at INTEGER, updated_at INTEGER, last_opened_at INTEGER, removed INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT,
        interaction_mode TEXT, runtime_mode TEXT, model TEXT, reasoning_effort TEXT, sdk_session_id TEXT,
        active_turn_id TEXT, last_error TEXT, has_pending_approval INTEGER DEFAULT 0,
        created_at INTEGER, updated_at INTEGER, last_visited_at INTEGER,
        latest_activity_at INTEGER, archived_at INTEGER, deleted INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, role TEXT, text TEXT,
        streaming INTEGER, created_at INTEGER, updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, created_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, thread_id TEXT, state TEXT, assistant_message_id TEXT,
        started_at INTEGER, completed_at INTEGER, cost_usd REAL
      );
      CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns (thread_id, started_at);
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, tone TEXT, status TEXT,
        item_type TEXT, tool_name TEXT, title TEXT, detail TEXT, body TEXT,
        changed_files TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_work_thread ON work_items (thread_id, created_at);
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, files_changed INTEGER,
        additions INTEGER, deletions INTEGER, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, text TEXT, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, tool_name TEXT, kind TEXT,
        detail TEXT, input TEXT, created_at INTEGER, resolved INTEGER DEFAULT 0
      );
      -- git tree snapshots taken at turn boundaries, for per-turn diffs (derived infra)
      CREATE TABLE IF NOT EXISTS turn_git (
        turn_id TEXT PRIMARY KEY, thread_id TEXT, before_tree TEXT, after_tree TEXT
      );
    `)
    try {
      this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_id ON events (id);')
    } catch {
      /* a pre-existing DB with duplicate event ids keeps working without the index */
    }
    // additive column migrations (CREATE TABLE IF NOT EXISTS won't alter an existing table)
    try {
      this.db.run('ALTER TABLE threads ADD COLUMN reasoning_effort TEXT;')
    } catch {
      /* column already exists */
    }
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as never)
    this.markDirty()
  }

  /** Run `fn` inside a transaction; rolls back and rethrows on failure. */
  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN')
    try {
      const result = fn()
      this.db.run('COMMIT')
      this.markDirty()
      return result
    } catch (err) {
      try {
        this.db.run('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  /** Read rows as objects. */
  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params as never)
    const rows: T[] = []
    while (stmt.step()) rows.push(stmt.getAsObject() as T)
    stmt.free()
    return rows
  }

  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  getMeta(key: string): string | null {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [key])?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)', [key, value])
  }

  /** Insert an event and return its auto-assigned seq. */
  insertEvent(id: string, ts: number, streamId: string, type: string, payloadJson: string): number {
    this.db.run('INSERT INTO events (id, ts, stream_id, type, payload) VALUES (?,?,?,?,?)', [
      id,
      ts,
      streamId,
      type,
      payloadJson
    ] as never)
    const row = this.get<{ seq: number }>('SELECT last_insert_rowid() AS seq')
    this.markDirty()
    return row?.seq ?? 0
  }

  private markDirty(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 250)
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty) return
    const bytes = this.db.export()
    // temp file + rename so a crash mid-write can't corrupt the DB
    const tmpPath = `${this.filePath}.tmp`
    writeFileSync(tmpPath, Buffer.from(bytes))
    renameSync(tmpPath, this.filePath)
    this.dirty = false
  }

  close(): void {
    this.flush()
    this.db.close()
  }
}
