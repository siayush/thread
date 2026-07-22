import { Db } from './db'
import { Engine } from './engine'
import { startWsServer, type RunningServer } from './wsServer'
import { PROJECTION_VERSION, rebuildProjections } from './projections'
import { DEFAULT_SERVER_HOST } from '@shared/rpc'

export interface Server {
  host: string
  port: number
  engine: Engine
  dispose: () => void
}

/** Boots the whole local server stack: DB → projections → engine → WS RPC. */
export async function startServer(dbPath: string): Promise<Server> {
  const db = await Db.open(dbPath)

  // projector semantics changed since this DB was written → replay the log
  if (db.getMeta('projection_version') !== String(PROJECTION_VERSION)) {
    rebuildProjections(db)
    db.setMeta('projection_version', String(PROJECTION_VERSION))
  }

  const engine = new Engine(db)
  engine.recoverFromRestart()

  const running: RunningServer = await startWsServer(engine, DEFAULT_SERVER_HOST)
  return {
    host: running.host,
    port: running.port,
    engine,
    dispose: () => {
      running.close()
      db.close()
    }
  }
}
