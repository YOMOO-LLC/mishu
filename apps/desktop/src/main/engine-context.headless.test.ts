import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemClock, systemIdGen } from '@mishu/core/clock'
import { AppointmentStore } from './appointments/store.js'
import { CallStore } from './call-store.js'
import { CampaignStore } from './campaign-store.js'
import { ToolRegistry } from './copilot/registry.js'
import type { EngineContext } from './engine-context.js'
import { HttpApiRouter } from './http/router.js'
import { RecordingWriter } from './recording-writer.js'
import { createMainServices } from './services/index.js'
import { TwilioSettingsService } from './services/twilio-settings-service.js'
import { localTenantContext } from './tenant.js'
import type { EngineTelephony } from './telephony/engine-telephony.js'
import { WebhookBridge } from './webhook/bridge.js'
import { WebhookConfigStore } from './webhook/config-store.js'
import type { PhoneCommand, PhoneCommandResult, PhoneStatusSnapshot } from '../shared/contracts.js'

vi.mock('electron', () => {
  throw new Error('headless engine imported electron')
})

const here = dirname(fileURLToPath(import.meta.url))
const IDLE: PhoneStatusSnapshot = {
  runtimeMode: 'mock',
  phoneConnection: 'ready',
  codexConnection: { status: 'ready' },
  controlMode: 'ai',
  updatedAt: 1
}

const ENGINE_ENTRYPOINTS = [
  join(here, 'engine-context.ts'),
  join(here, 'http/router.ts'),
  join(here, 'services/index.ts')
]

const IMPORT_FROM = /(?:import|export)(?:\s+type)?\s+(?:[\s\S]*?)\sfrom\s+['"]([^'"]+)['"]/g
const SIDE_EFFECT_IMPORT = /^import\s+['"]([^'"]+)['"]/gm

const servers: Array<{ server: Server; directory: string; context: EngineContext }> = []

function fakeTelephony(): EngineTelephony {
  let status: PhoneStatusSnapshot = { ...IDLE }
  const execute = async (command: PhoneCommand): Promise<PhoneCommandResult> => {
    if (command.type === 'dial') {
      status = {
        ...IDLE,
        call: { id: 'headless-call', direction: 'outbound', peer: command.peer, status: 'active' }
      }
    } else if (command.type === 'hangup' && status.call) {
      status = { ...IDLE, call: { ...status.call, status: 'ended' } }
    }
    return { requestId: 'headless', ok: true, status }
  }
  return {
    capabilities: () => ({ concurrentCalls: 'single', ownerKinds: ['local_takeover'] }),
    getStatus: () => status,
    execute,
    dial: async (input) => {
      await execute({ type: 'dial', peer: input.peer })
    },
    answer: async () => undefined,
    reject: async () => undefined,
    hangup: async () => {
      await execute({ type: 'hangup' })
    },
    transferToOwner: async () => undefined,
    subscribe: () => () => undefined
  }
}

function assembleHeadless(directory: string): EngineContext {
  const tenant = localTenantContext()
  const campaignStore = new CampaignStore(join(directory, 'campaigns.sqlite3'), { tenantId: tenant.tenantId })
  const callStore = new CallStore(join(directory, 'calls.sqlite3'), { tenantId: tenant.tenantId })
  const appointmentStore = new AppointmentStore(callStore)
  const recordingWriter = new RecordingWriter(callStore, join(directory, 'recordings'))
  recordingWriter.initialize()
  const webhookBridge = new WebhookBridge({
    store: callStore,
    configStore: new WebhookConfigStore(join(directory, 'webhooks'))
  })
  const telephony = fakeTelephony()
  const services = createMainServices({
    userDataPath: directory,
    isMock: true,
    campaignStore,
    callStore,
    appointmentStore,
    recordingWriter,
    webhookBridge,
    telephony,
    clock: systemClock,
    loadTwilioToken: async () => undefined,
    twilioSettings: new TwilioSettingsService({ userDataPath: directory, env: {} }),
    emitConnecting: () => undefined,
    approvalTimeoutMs: 5_000,
    codex: () => {
      throw new Error('codex is unavailable in the headless engine')
    }
  })
  return {
    callStore,
    appointmentStore,
    campaignStore,
    recordingWriter,
    webhookBridge,
    toolRegistry: new ToolRegistry(),
    telephony,
    approvals: services.approvals,
    clock: systemClock,
    idGen: systemIdGen,
    tenant,
    userDataPath: directory,
    isMock: true,
    services
  }
}

async function listen(context: EngineContext): Promise<Server> {
  const router = new HttpApiRouter(context)
  const server = createServer((request, response) => {
    void router.handle(request, response).then((handled) => {
      if (!handled) {
        response.statusCode = 404
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push({ server, directory: context.userDataPath, context })
  return server
}

async function api(
  server: Server,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const address = server.address() as AddressInfo
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}

function collectValueImports(source: string): string[] {
  const specs: string[] = []
  for (const match of source.matchAll(IMPORT_FROM)) {
    const spec = match[1]
    const statement = match[0]
    if (!spec) continue
    if (/^(?:import|export)\s+type\b/.test(statement.trim())) continue
    specs.push(spec)
  }
  SIDE_EFFECT_IMPORT.lastIndex = 0
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    if (match[1]) specs.push(match[1])
  }
  return specs
}

function resolveRelative(fromFile: string, spec: string): string | undefined {
  const withoutJs = spec.replace(/\.js$/, '.ts')
  const candidates = [
    resolve(dirname(fromFile), withoutJs),
    resolve(dirname(fromFile), spec),
    resolve(dirname(fromFile), join(withoutJs, 'index.ts'))
  ]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

function walkEngineGraph(entry: string, seen: Set<string>, electronFiles: string[]): void {
  if (seen.has(entry)) return
  seen.add(entry)
  const source = readFileSync(entry, 'utf8')
  if (/from ['"]electron(?:\/[^'"]*)?['"]/.test(source)) {
    electronFiles.push(relative(join(here, '../..'), entry))
  }
  for (const spec of collectValueImports(source)) {
    if (spec === 'electron' || spec.startsWith('electron/')) {
      electronFiles.push(relative(join(here, '../..'), entry))
      continue
    }
    if (!spec.startsWith('.')) continue
    const resolved = resolveRelative(entry, spec)
    if (resolved) walkEngineGraph(resolved, seen, electronFiles)
  }
}

function listTsFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listTsFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ server, directory, context }) => {
    context.services.dispose()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    rmSync(directory, { recursive: true, force: true })
  }))
})

describe('headless EngineContext', () => {
  it('keeps electron out of the engine import graph', () => {
    const seen = new Set<string>()
    const electronFiles: string[] = []
    for (const entry of ENGINE_ENTRYPOINTS) walkEngineGraph(entry, seen, electronFiles)
    expect(electronFiles, electronFiles.join('\n')).toEqual([])
    expect(seen.has(join(here, 'phone-gateway.ts'))).toBe(false)
    expect(seen.has(join(here, 'module-context.ts'))).toBe(false)
    expect(seen.has(join(here, 'index.ts'))).toBe(false)
  })

  it('does not mention electron in http or services sources', () => {
    const files = [
      ...listTsFiles(join(here, 'http')),
      ...listTsFiles(join(here, 'services'))
    ]
    const hits = files.filter((file) => /from ['"]electron['"]/.test(readFileSync(file, 'utf8')))
    expect(hits).toEqual([])
  })

  it('serves health, campaigns, and a headless approval dial on loopback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'live-phone-headless-'))
    const context = assembleHeadless(directory)
    const server = await listen(context)

    const health = await api(server, 'GET', '/v1/health')
    expect(health).toEqual({ status: 200, body: { status: 'ok' } })

    const created = await api(server, 'POST', '/v1/campaigns', {
      name: 'Headless',
      direction: 'outbound',
      systemPrompt: 'Help the caller.',
      voice: 'juniper'
    })
    expect(created.status).toBe(201)
    const workspace = created.body as { campaigns: Array<{ id: string; name: string }> }
    const campaign = workspace.campaigns.find((item) => item.name === 'Headless')
    expect(campaign?.id).toBeTruthy()

    const fetched = await api(server, 'GET', `/v1/campaigns/${campaign?.id}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body).toMatchObject({ id: campaign?.id, name: 'Headless' })

    const dial = await api(server, 'POST', '/v1/calls', {
      peer: '+13125550198',
      campaignId: campaign?.id,
      idempotencyKey: 'headless-dial'
    })
    expect(dial.status).toBe(202)
    const approvalId = (dial.body as { approvalId: string }).approvalId
    expect(approvalId).toBeTruthy()

    const pending = await api(server, 'GET', '/v1/approvals')
    expect(pending.status).toBe(200)
    expect((pending.body as { approvals: Array<{ id: string }> }).approvals.map(({ id }) => id)).toContain(approvalId)

    const decided = await api(server, 'POST', `/v1/approvals/${approvalId}/decide`, { approved: true })
    expect(decided).toEqual({ status: 200, body: { id: approvalId, approved: true } })
  })
})
