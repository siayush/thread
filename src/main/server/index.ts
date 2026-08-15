import { dirname } from 'node:path'
import { Db } from './db'
import { Engine } from './engine'
import { registerRpc } from './rpc'
import { PROJECTION_VERSION, rebuildProjections } from './projections'
import { UsageService } from './usage/usageService'

export interface Server {
  engine: Engine
  dispose: () => void
}

/** Boots the whole local server stack: DB → projections → engine → IPC RPC. */
export function startServer(dbPath: string): Server {
  const db = Db.open(dbPath)

  // projector semantics changed since this DB was written → replay the log
  if (db.getMeta('projection_version') !== String(PROJECTION_VERSION)) {
    rebuildProjections(db)
    db.setMeta('projection_version', String(PROJECTION_VERSION))
  }

  const engine = new Engine(db)
  engine.recoverFromRestart()

  // usage snapshots (LiteLLM rate table) live next to the DB in userData
  const usage = new UsageService(dirname(dbPath))
  const unregisterRpc = registerRpc(engine, usage)
  return {
    engine,
    dispose: () => {
      unregisterRpc()
      // stop timers, in-flight turns, and provider child processes BEFORE the
      // DB closes, so no late callback writes to a closed handle
      engine.dispose()
      db.close()
    }
  }
}
