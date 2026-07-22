import { dirname } from 'node:path'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/**
 * A thin synchronous SQLite wrapper over the Node built-in `node:sqlite`.
 * Real on-disk SQLite — every statement/transaction is durable as written.
 */
export class Db {
  private constructor(private readonly db: DatabaseSync) {}

  static open(filePath: string): Db {
    mkdirSync(dirname(filePath), { recursive: true })
    const instance = new Db(Db.load(filePath))
    instance.migrate()
    return instance
  }

  /** Open the DB file; if it's unreadable/corrupt, set it aside and start fresh. */
  private static load(filePath: string): DatabaseSync {
    if (!existsSync(filePath)) return new DatabaseSync(filePath)
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(filePath)
      // cheap integrity probe — throws if the file isn't a usable database
      db.exec('PRAGMA quick_check')
      return db
    } catch {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
      try {
        renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      return new DatabaseSync(filePath)
    }
  }

  private migrate(): void {
    this.db.exec(`
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
        latest_activity_at INTEGER, deleted INTEGER DEFAULT 0
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
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_id ON events (id);')
    } catch {
      /* a pre-existing DB with duplicate event ids keeps working without the index */
    }
    // additive column migrations (CREATE TABLE IF NOT EXISTS won't alter an existing table)
    try {
      this.db.exec('ALTER TABLE threads ADD COLUMN reasoning_effort TEXT;')
    } catch {
      /* column already exists */
    }
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.prepare(sql).run(...(params as SQLInputValue[]))
  }

  /** Run `fn` inside a transaction; rolls back and rethrows on failure. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  /** Read rows as objects. */
  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[]
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
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO events (id, ts, stream_id, type, payload) VALUES (?,?,?,?,?)')
      .run(id, ts, streamId, type, payloadJson)
    return Number(lastInsertRowid)
  }

  close(): void {
    this.db.close()
  }
}
