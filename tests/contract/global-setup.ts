import { envEngine, startLocalEngine, type LocalEngineHandle } from './helpers/engine.js'

export default async function setup(): Promise<() => Promise<void>> {
  if (envEngine()) {
    return async () => undefined
  }
  const handle: LocalEngineHandle = await startLocalEngine()
  return async () => {
    await handle.stop()
  }
}
