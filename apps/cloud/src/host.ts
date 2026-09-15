import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleCloudEngine, type AssembledCloudEngine } from './assemble.js'
import { listenCloudHttp, type CloudHttpHost, type CloudReadyLine } from './http-host.js'

export interface CloudHostOptions {
  dataDir?: string
  port?: number
}

export interface CloudHost {
  ready: CloudReadyLine
  dataDir: string
  ephemeral: boolean
  engine: AssembledCloudEngine
  http: CloudHttpHost
  stop(): Promise<void>
}

export async function startCloudHost(options: CloudHostOptions = {}): Promise<CloudHost> {
  const ephemeral = !options.dataDir
  const dataDir = options.dataDir
    ? (mkdirSync(options.dataDir, { recursive: true, mode: 0o700 }), options.dataDir)
    : mkdtempSync(join(tmpdir(), 'mishu-cloud-'))
  const engine = assembleCloudEngine(dataDir)
  try {
    const http = await listenCloudHttp({
      context: engine.context,
      tokenStore: engine.tokenStore,
      ...(options.port !== undefined ? { port: options.port } : {})
    })
    return {
      ready: http.ready,
      dataDir,
      ephemeral,
      engine,
      http,
      async stop() {
        await http.close()
        engine.dispose()
        if (ephemeral) rmSync(dataDir, { recursive: true, force: true })
      }
    }
  } catch (error) {
    engine.dispose()
    if (ephemeral) rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}

export function parseHostArgs(argv: string[]): CloudHostOptions {
  const options: CloudHostOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--data-dir' && argv[i + 1]) {
      options.dataDir = argv[++i]
      continue
    }
    if (arg === '--port' && argv[i + 1]) {
      const port = Number(argv[++i])
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('--port must be an integer from 0 to 65535')
      }
      options.port = port
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.port = undefined
      continue
    }
    if (arg?.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}
