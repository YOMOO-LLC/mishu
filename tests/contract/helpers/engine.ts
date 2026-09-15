import { spawn, type ChildProcess, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineFilePath, normalizeBaseUrl, repoRoot } from './paths.js'
import { poll } from './poll.js'
import type { EngineConnection } from './types.js'

const require = createRequire(import.meta.url)

export interface LocalEngineHandle {
  connection: EngineConnection
  userData: string
  stop: () => Promise<void>
}

function electronBinary(): string {
  return require('electron') as string
}

function writeEngineFile(connection: EngineConnection): void {
  writeFileSync(engineFilePath(), `${JSON.stringify(connection, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export function envEngine(): EngineConnection | undefined {
  const baseUrl = process.env.CONTRACT_BASE_URL
  const token = process.env.CONTRACT_TOKEN
  if (!baseUrl || !token) return undefined
  return { baseUrl: normalizeBaseUrl(baseUrl), token }
}

export function ensureBuilt(): void {
  const main = join(repoRoot, 'out/main/index.js')
  if (existsSync(main) && process.env.CONTRACT_FORCE_BUILD !== '1') return
  execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' })
  if (!existsSync(main)) throw new Error('pnpm build did not produce out/main/index.js')
}

export async function startLocalEngine(): Promise<LocalEngineHandle> {
  ensureBuilt()
  const userData = mkdtempSync(join(tmpdir(), 'mishu-contract-'))
  const mcpDirectory = join(userData, 'mcp')
  mkdirSync(mcpDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(join(mcpDirectory, 'settings.json'), JSON.stringify({
    enabled: true,
    scopes: ['read', 'manage_campaigns', 'control_calls', 'send_messages']
  }))

  const logPath = join(userData, 'electron.log')
  const log = (chunk: Buffer | string) => {
    writeFileSync(logPath, chunk, { flag: 'a' })
  }

  const child: ChildProcess = spawn(
    electronBinary(),
    ['.', `--user-data-dir=${userData}`],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        LIVE_PHONE_USE_MOCKS: '1',
        LIVE_PHONE_SKIP_ENV_FILE: '1',
        LIVE_PHONE_APPROVAL_TIMEOUT_MS: '10000',
        TWILIO_ACCOUNT_SID: '',
        TWILIO_API_KEY_SID: '',
        TWILIO_API_KEY_SECRET: '',
        TWILIO_TWIML_APP_SID: '',
        TWILIO_PHONE_NUMBER: '+15555550198',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.stdout?.on('data', log)
  child.stderr?.on('data', log)

  let exited = false
  child.once('exit', (code, signal) => {
    exited = true
    log(`\nelectron exited code=${code} signal=${signal}\n`)
  })

  try {
    const endpointFile = join(mcpDirectory, 'endpoint.json')
    const endpoint = await poll(
      async () => {
        if (exited) throw new Error(`electron exited before writing endpoint.json; log: ${safeLog(logPath)}`)
        try {
          return JSON.parse(readFileSync(endpointFile, 'utf8')) as { endpoint?: string; apiEndpoint?: string; tokenPath?: string }
        } catch {
          return undefined
        }
      },
      (value): value is { endpoint?: string; apiEndpoint?: string; tokenPath?: string } =>
        Boolean(value?.endpoint || value?.apiEndpoint),
      { timeoutMs: 60_000, label: 'endpoint.json' }
    )
    const rawEndpoint = endpoint.apiEndpoint ?? endpoint.endpoint
    if (!rawEndpoint) throw new Error('endpoint metadata is incomplete')
    const tokenPath = endpoint.tokenPath ?? join(mcpDirectory, 'token')
    const token = readFileSync(tokenPath, 'utf8').trim()
    const connection: EngineConnection = { baseUrl: normalizeBaseUrl(rawEndpoint), token }
    writeEngineFile(connection)
    await waitUntilReady(connection)
    await configureBudget(connection)
    return {
      connection,
      userData,
      stop: async () => {
        await stopChild(child)
        rmSync(userData, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await stopChild(child)
    throw error
  }
}

async function waitUntilReady(connection: EngineConnection): Promise<void> {
  await poll(
    async () => {
      const response = await fetch(`${connection.baseUrl}/health`, {
        headers: { authorization: `Bearer ${connection.token}` }
      })
      return response.status
    },
    (status) => status === 200,
    { timeoutMs: 30_000, label: 'GET /v1/health' }
  )
  await poll(
    async () => {
      const response = await fetch(`${connection.baseUrl}/status`, {
        headers: { authorization: `Bearer ${connection.token}` }
      })
      if (!response.ok) return undefined
      return await response.json() as { phone?: { phoneConnection?: string } }
    },
    (body) => body?.phone?.phoneConnection === 'ready',
    { timeoutMs: 30_000, label: 'phoneConnection ready' }
  )
}

async function configureBudget(connection: EngineConnection): Promise<void> {
  const response = await fetch(`${connection.baseUrl}/settings/budget`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${connection.token}`,
      'content-type': 'application/json',
      'idempotency-key': 'contract-budget-setup'
    },
    body: JSON.stringify({
      enabled: true,
      dailyMaxCalls: 100,
      dailyMaxMinutes: 1_000,
      allowedPrefixes: ['+1555'],
      allowedNumbers: [],
      allowedHours: { timeZone: 'UTC', windows: [] },
      killSwitch: false
    })
  })
  if (!response.ok) {
    throw new Error(`budget setup failed (${response.status}): ${await response.text()}`)
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.kill('SIGTERM') } catch { resolve() }
  })
}

function safeLog(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-4_000)
  } catch {
    return '(no log)'
  }
}
