import { Db } from './db'
import { Engine } from './engine'
import { registerRpc } from './rpc'
import { PROJECTION_VERSION, rebuildProjections } from './projections'

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

  const unregisterRpc = registerRpc(engine)
  return {
    engine,
    dispose: () => {
      unregisterRpc()
      db.close()
    }
  }
}
