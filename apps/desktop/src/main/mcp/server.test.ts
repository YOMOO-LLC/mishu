import { OpenAiSettingsService } from '../services/openai-settings-service.js'
import { VoiceSettingsService } from '../services/voice-settings-service.js'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Agent, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC, type PhoneStatusSnapshot } from '../../shared/contracts.js'
import { CallStore } from '../call-store.js'
import { CampaignStore } from '../campaign-store.js'
import { AppointmentStore } from '../appointments/store.js'
import { CallService } from '../services/call-service.js'
import { CampaignService } from '../services/campaign-service.js'
import { ContactService } from '../services/contact-service.js'
import { PhoneService } from '../services/phone-service.js'
import { TaskService } from '../services/task-service.js'
import { McpAdminService } from '../services/mcp-admin-service.js'
import { ApprovalManager } from './approvals.js'
import { McpServerController } from './server.js'

const READY: PhoneStatusSnapshot = {
  runtimeMode: 'mock', phoneConnection: 'ready', codexConnection: { status: 'ready' },
  controlMode: 'ai', updatedAt: 1
}

class FakeIpcMain extends EventEmitter {}
const controllers: McpServerController[] = []

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'live-phone-mcp-server-'))
  const ipcMain = new FakeIpcMain()
  const callStore = new CallStore(join(directory, 'calls.sqlite3'))
  const campaignStore = new CampaignStore(join(directory, 'campaigns.sqlite3'))
  const appointmentStore = new AppointmentStore(callStore)
  const webContents = { isDestroyed: () => false, send: vi.fn() }
  const getWindow = () => ({
    isDestroyed: () => false,
    show: vi.fn(),
    focus: vi.fn(),
    flashFrame: vi.fn(),
    webContents
  }) as never
  const approvals = new ApprovalManager({ ipcMain: ipcMain as never, getWindow })
  const campaignService = new CampaignService(campaignStore)
  const phoneGateway = { getStatus: () => READY, send: vi.fn() }
  const contactService = new ContactService(callStore)
  const callService = new CallService(callStore, appointmentStore, { getRecordingsPath: () => directory } as never)
  const taskService = new TaskService({
    store: callStore,
    campaigns: campaignService,
    approvals: approvals.service,
    gateway: phoneGateway as never,
    contacts: contactService,
    calls: callService
  })
  const services = {
    openai: new OpenAiSettingsService({ userDataPath: directory, env: {}, fetch: async () => new Response('{}') }),
    voice: new VoiceSettingsService(directory),
    mcp: new McpAdminService(),
    approvals: approvals.service,
    campaigns: campaignService,
    contacts: contactService,
    tasks: taskService,
    calls: callService,
    phone: new PhoneService(phoneGateway as never, campaignService, approvals.service),
    settings: {
      general: (() => {
        let value = { minimizeToTray: true, launchAtLogin: false, startHidden: false }
        return {
          get: () => ({ ...value }),
          save: (input: Partial<typeof value>) => {
            value = { ...value, ...input }
            return { ...value }
          }
        }
      })()
    },
    twilio: {
      get: vi.fn(() => ({ configured: true, apiKeySecret: { configured: true, last4: 'alue', source: 'settings', readOnly: false } })),
      save: vi.fn((input) => ({ configured: Boolean(input.apiKeySecret), apiKeySecret: { configured: Boolean(input.apiKeySecret), last4: input.apiKeySecret?.slice(-4), source: 'settings', readOnly: false } })),
      test: vi.fn(async () => ({ ok: true, checks: [{ check: 'token', ok: true, code: 'OK' }] })),
      importEnv: vi.fn(() => ({ imported: ['TWILIO_ACCOUNT_SID'], settings: { configured: false } })),
      relaunch: vi.fn(() => ({ accepted: true }))
    },
    auditHttp: vi.fn()
  }
  const context = {
    ipcMain,
    getWindow,
    callStore,
    appointmentStore,
    campaignStore,
    phoneGateway,
    services,
    userDataPath: directory,
    isMock: true
  } as never
  const controller = new McpServerController(context, approvals)
  controllers.push(controller)
  return { controller, directory, approvals, ipcMain, webContents, campaignStore, callStore, services }
}

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
})

describe('McpServerController', () => {
  it('round-trips voice/OpenAI settings with sanitized HTTP and MCP results', async () => {
    const { controller, services } = setup()
    const status = await controller.setEnabled(true)
    const { token } = await controller.rotateToken()
    const base = status.endpoint!.replace(/\/mcp$/, '')
    const key = 'fake-secret-openai-1234'
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'settings-test' }
    const saved = await fetch(`${base}/v1/settings/openai`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: key }) }).then((r) => r.json())
    expect(saved).toMatchObject({ apiKey: { configured: true, last4: '1234' } })
    const voice = await fetch(`${base}/v1/settings/voice`, { method: 'PUT', headers, body: JSON.stringify({ provider: 'gpt-live-api' }) }).then((r) => r.json())
    expect(voice).toMatchObject({ provider: 'gpt-live-api', startPolicy: 'on_answer' })
    const tested = await fetch(`${base}/v1/settings/openai/test`, { method: 'POST', headers }).then((r) => r.json())
    expect(tested).toEqual({ ok: true, code: 'OK' })
    const client = new Client({ name: 'voice-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(status.endpoint!), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const read = await client.callTool({ name: 'settings_openai_get', arguments: {} })
    const mcpTest = await client.callTool({ name: 'settings_openai_test', arguments: {} })
    const mcpVoice = await client.callTool({ name: 'settings_voice_get', arguments: {} })
    expect(JSON.stringify({ mcpTest, mcpVoice })).not.toContain(key)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('settings_voice_get')
    expect(tools.tools.map((tool) => tool.name)).not.toContain('settings_openai_set')
    expect(JSON.stringify({ saved, voice, tested, read, audit: services.auditHttp.mock.calls })).not.toContain(key)
    await client.close()
  })

  it('restores a missing endpoint discovery file while the server is running', async () => {
    const { controller, directory } = setup()
    const status = await controller.setEnabled(true)
    const endpointPath = join(directory, 'mcp', 'endpoint.json')
    rmSync(endpointPath)
    expect(existsSync(endpointPath)).toBe(false)

    expect(controller.status()).toMatchObject({ running: true, endpoint: status.endpoint })
    expect(JSON.parse(readFileSync(endpointPath, 'utf8'))).toEqual({
      endpoint: status.endpoint,
      tokenPath: controller.tokenStore.tokenPath
    })
  })

  it('rejects missing/wrong bearer credentials and a non-loopback Origin', async () => {
    const { controller } = setup()
    const status = await controller.setEnabled(true)
    const endpoint = status.endpoint as string
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    expect((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401)
    expect((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer bad' }, body })).status).toBe(401)
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    expect((await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, Origin: 'https://evil.example' },
      body
    })).status).toBe(403)
  })

  it('connects with the SDK client and returns phone_get_status', async () => {
    const { controller } = setup()
    const status = await controller.setEnabled(true)
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const client = new Client({ name: 'mcp-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(status.endpoint as string), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
    await client.connect(transport)
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toContain('phone_get_status')
    expect(listed.tools.map((tool) => tool.name)).toContain('appointment_list')
    expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'call_answer', 'campaign_policy_update', 'settings_webhook_update',
      'settings_mcp_update', 'settings_appointments_update', 'settings_crm_update',
      'settings_mcp_client_configs_apply', 'approval_list', 'approval_decide',
      'call_analysis_get', 'call_audit_list'
      ,'settings_twilio_get', 'settings_twilio_test'
    ]))
    expect(listed.tools.find((tool) => tool.name === 'appointment_list')?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false
    })
    expect(listed.tools.find((tool) => tool.name === 'phone_get_status')?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false
    })
    const result = await client.callTool({ name: 'phone_get_status', arguments: {} })
    expect(result.structuredContent).toMatchObject({ runtimeMode: 'mock', phoneConnection: 'ready' })
    const resources = await client.listResources()
    expect(resources.resources.map((resource) => resource.uri)).toContain('live-phone://appointments')
    await client.close()
  })

  it('disposes promptly with a hanging keep-alive request', async () => {
    const { controller } = setup()
    const status = await controller.setEnabled(true)
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const agent = new Agent({ keepAlive: true })
    const request = httpRequest(status.endpoint as string, {
      method: 'POST',
      agent,
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': '1000'
      }
    })
    request.on('error', () => undefined)
    request.write('{')
    await new Promise<void>((resolve) => request.once('socket', (socket) => {
      if (socket.readyState === 'open') resolve()
      else socket.once('connect', resolve)
    }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const startedAt = performance.now()
    await expect(Promise.race([
      controller.dispose().then(() => 'disposed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 250))
    ])).resolves.toBe('disposed')
    expect(performance.now() - startedAt).toBeLessThan(250)

    request.destroy()
    agent.destroy()
  })

  it('invalidates the old token immediately after rotation', async () => {
    const { controller } = setup()
    const status = await controller.setEnabled(true)
    const oldToken = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    controller.rotateToken()
    const response = await fetch(status.endpoint as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${oldToken}` },
      body: '{}'
    })
    expect(response.status).toBe(401)
  })

  it('serves authenticated v1 routes with uniform authorization and error statuses', async () => {
    const { controller } = setup()
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    expect((await fetch(`${base}/v1/health`)).status).toBe(401)
    expect((await fetch(`${base}/v1/health`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${base}/v1/missing`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404)
    expect((await fetch(`${base}/v1/approvals/missing/decide`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true })
    })).status).toBe(409)
    expect((await fetch(`${base}/v1/campaigns`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' })
    })).status).toBe(422)
  })

  it('round-trips independent campaign scripts and personas over POST and PUT', async () => {
    const { controller } = setup()
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    const createdResponse = await fetch(`${base}/v1/campaigns?reveal=true`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: 'Script only', direction: 'outbound',
        systemPrompt: 'Follow the complete reminder script.', voice: 'sol',
        policy: { recordingDisclosure: false }
      })
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as {
      selectedCampaignId: string
      campaigns: Array<{ id: string; name: string; systemPrompt: string; policy: { persona: string } }>
    }
    const scriptOnly = created.campaigns.find(({ name }) => name === 'Script only')
    expect(scriptOnly).toMatchObject({
      systemPrompt: 'Follow the complete reminder script.', policy: { persona: '' }
    })

    const updatedResponse = await fetch(`${base}/v1/campaigns/${scriptOnly?.id}?reveal=true`, {
      method: 'PUT', headers,
      body: JSON.stringify({
        systemPrompt: '',
        policy: { persona: 'You are the appointment coordinator.', recordingDisclosure: false }
      })
    })
    expect(updatedResponse.status).toBe(200)
    const updated = await updatedResponse.json() as {
      campaigns: Array<{ id: string; systemPrompt: string; policy: { persona: string } }>
    }
    expect(updated.campaigns.find(({ id }) => id === scriptOnly?.id)).toMatchObject({
      systemPrompt: 'You are the appointment coordinator.',
      policy: { persona: 'You are the appointment coordinator.' }
    })

    const invalidResponse = await fetch(`${base}/v1/campaigns`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Empty', direction: 'outbound', voice: 'sol', policy: {} })
    })
    expect(invalidResponse.status).toBe(400)
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARGUMENT', message: 'System prompt cannot be empty' }
    })
  })

  it('serves authenticated contact card routes and rejects invalid cards', async () => {
    const { controller } = setup()
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    expect((await fetch(`${base}/v1/contacts/%2B13125550198`, {
      method: 'PUT', headers, body: JSON.stringify({ displayName: 'Ada', company: 'Analytical Engines' })
    })).status).toBe(200)
    const card = await fetch(`${base}/v1/contacts/%2B13125550198`, { headers }).then((response) => response.json()) as { displayName: string }
    expect(card.displayName).toBe('Ada')
    const listed = await fetch(`${base}/v1/contacts`, { headers }).then((response) => response.json()) as { contacts: Array<{ phone: string }> }
    expect(listed.contacts[0]?.phone).toContain('*')
    expect((await fetch(`${base}/v1/contacts:batch`, {
      method: 'POST', headers, body: JSON.stringify([
        { phone: '+14155550142', displayName: 'Grace' },
        { phone: '+17735550100', displayName: 'Linus' }
      ])
    })).status).toBe(200)
    expect((await fetch(`${base}/v1/tasks`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'contact-task' },
      body: JSON.stringify({
        to: '+12125550111', goal: 'Confirm attendance',
        contact: { displayName: 'Katherine', tier: 'VIP' }
      })
    })).status).toBe(202)
    const taskContact = await fetch(`${base}/v1/contacts/%2B12125550111`, { headers }).then((response) => response.json()) as { displayName: string }
    expect(taskContact.displayName).toBe('Katherine')
    expect((await fetch(`${base}/v1/contacts/%2B13125550198`, {
      method: 'PUT', headers, body: JSON.stringify({ notes: 'x'.repeat(2_001) })
    })).status).toBe(422)
    expect((await fetch(`${base}/v1/contacts/%2B13125550198`, { method: 'DELETE', headers })).status).toBe(200)
    expect((await fetch(`${base}/v1/contacts/%2B13125550198`, { headers })).status).toBe(404)
    expect((await fetch(`${base}/v1/contacts/%2B13125550198`)).status).toBe(401)
  })

  it('submits inline task campaigns and hides them from the default campaign list', async () => {
    const { controller, services } = setup()
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    const submitted = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'http-inline-campaign' },
      body: JSON.stringify({
        to: '+13125550198',
        goal: 'Confirm attendance',
        campaign: {
          name: 'One-time HTTP',
          direction: 'outbound',
          systemPrompt: 'Ask whether the guest will attend.',
          policy: { maxCallDurationSec: 120 }
        }
      })
    })
    expect(submitted.status).toBe(202)
    const { taskId } = await submitted.json() as { taskId: string }
    const task = await fetch(`${base}/v1/tasks/${taskId}`, { headers }).then((response) => response.json()) as {
      campaignId: string
    }

    const listed = await fetch(`${base}/v1/campaigns`, { headers }).then((response) => response.json()) as {
      campaigns: Array<{ id: string }>
    }
    expect(listed.campaigns.some(({ id }) => id === task.campaignId)).toBe(false)
    const withEphemeral = await fetch(`${base}/v1/campaigns?includeEphemeral=1`, { headers })
      .then((response) => response.json()) as { campaigns: Array<{ id: string; ephemeral: boolean }> }
    expect(withEphemeral.campaigns).toContainEqual(expect.objectContaining({
      id: task.campaignId,
      ephemeral: true
    }))
    expect(services.campaigns.get(task.campaignId, { reveal: true })).toMatchObject({
      voice: 'juniper',
      systemPrompt: 'Ask whether the guest will attend.',
      policy: { persona: '', maxCallDurationSec: 120 }
    })

    const selectResponse = await fetch(`${base}/v1/campaigns/${task.campaignId}/select`, {
      method: 'POST', headers
    })
    expect(selectResponse.status).toBe(400)
    const conflict = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'http-inline-conflict' },
      body: JSON.stringify({
        to: '+13125550198', goal: 'Invalid',
        campaignId: services.campaigns.workspace().selectedCampaignId,
        campaign: { direction: 'outbound', systemPrompt: 'Inline' }
      })
    })
    expect(conflict.status).toBe(400)
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('mutually exclusive') }
    })
  })

  it('replays the first response for a repeated idempotency key', async () => {
    const { controller, campaignStore } = setup()
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': 'campaign-once' },
      body: JSON.stringify({ name: 'API', direction: 'both', systemPrompt: 'Help', voice: 'juniper' })
    }
    const first = await fetch(`${base}/v1/campaigns`, init)
    const second = await fetch(`${base}/v1/campaigns`, init)
    expect(first.status).toBe(201)
    expect(await second.json()).toEqual(await first.json())
    expect(campaignStore.getWorkspace().campaigns.filter(({ name }) => name === 'API')).toHaveLength(1)
  })

  it('round-trips authenticated general settings over HTTP', async () => {
    const { controller } = setup()
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const updated = await fetch(`${base}/v1/settings/general`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ minimizeToTray: false, startHidden: true })
    })
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toEqual({
      minimizeToTray: false,
      launchAtLogin: false,
      startHidden: true
    })
    const current = await fetch(`${base}/v1/settings/general`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    await expect(current.json()).resolves.toEqual({
      minimizeToTray: false,
      launchAtLogin: false,
      startHidden: true
    })
  })

  it('allows the API to settle an approval before a later renderer decision', async () => {
    const { controller, approvals, ipcMain, webContents } = setup()
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const pending = approvals.request({ kind: 'call_dial', title: 'Dial', summary: 'Dial?', details: {}, requestedBy: 'test' })
    const listed = await fetch(`${base}/v1/approvals`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json()) as { approvals: Array<{ id: string }> }
    const id = listed.approvals[0]?.id as string
    expect((await fetch(`${base}/v1/approvals/${id}/decide`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true })
    })).status).toBe(200)
    ipcMain.emit(IPC.respondApproval, { sender: webContents }, { id, approved: false, decidedAt: Date.now() })
    await expect(pending).resolves.toMatchObject({ approved: true })
  })

  it('applies local MCP client configs through the authenticated HTTP route', async () => {
    const { controller, services } = setup()
    const expected = {
      results: [{ client: 'codex' as const, path: '/tmp/config.toml', action: 'updated' as const, backupPath: '/tmp/config.toml.bak-1' }],
      claudeDesktopInstalled: true,
      claudeDesktopMcpVisible: 'unverified' as const
    }
    vi.spyOn(services.mcp, 'applyClientConfigs').mockReturnValue(expected)
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()

    const response = await fetch(`${base}/v1/settings/mcp/client-configs/apply`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expected)
    expect(services.mcp.applyClientConfigs).toHaveBeenCalledOnce()
  })

  it('serves Twilio settings routes without returning an API Key Secret', async () => {
    const { controller, services } = setup()
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const saved = await fetch(`${base}/v1/settings/twilio`, {
      method: 'PUT', headers, body: JSON.stringify({ apiKeySecret: 'top-secret-value' })
    }).then((response) => response.json())
    const tested = await fetch(`${base}/v1/settings/twilio/test`, { method: 'POST', headers }).then((response) => response.json())
    expect(JSON.stringify({ saved, tested })).not.toContain('top-secret-value')
    expect(services.twilio.save).toHaveBeenCalledWith({ apiKeySecret: 'top-secret-value' })
  })

  it('serves the same generated OpenAPI document committed in docs', async () => {
    const { controller } = setup()
    const status = await controller.setEnabled(true)
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const endpoint = (status.endpoint as string).replace(/\/mcp$/, '/v1/openapi.json')
    const live = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json())
    const committed = JSON.parse(readFileSync(join(process.cwd(), 'docs/api/openapi.json'), 'utf8'))
    expect(live).toEqual(committed)
  })

  it('serves post-call analysis, sanitized audit, and optional task expansions', async () => {
    const { controller, callStore, services } = setup()
    const status = await controller.setEnabled(true)
    const base = (status.endpoint as string).replace(/\/mcp$/, '')
    const token = readFileSync(controller.tokenStore.tokenPath, 'utf8').trim()
    const headers = { Authorization: `Bearer ${token}` }
    callStore.report({
      call: { id: 'call-post', direction: 'outbound', peer: '+13125550198', status: 'active' },
      runtimeMode: 'mock'
    })
    callStore.reportTranscriptEntry({
      id: 'transcript-post', speaker: 'caller', text: 'Call +13125550198 tomorrow', final: true, timestamp: 1
    })
    callStore.report({
      call: { id: 'call-post', direction: 'outbound', peer: '+13125550198', status: 'ended' },
      runtimeMode: 'mock', endReason: 'hangup'
    })
    callStore.putCallResult({
      id: 'result-post', callId: 'call-post', schemaHash: 'schema-post', outcome: 'reached',
      summary: 'Customer reached', result: { booked: true }, confidence: 'high', model: 'mock', createdAt: 10
    })
    callStore.writeAudit('custom.sensitive', 'call-post', {
      peer: '+13125550198', accessToken: 'hidden-token', transcript: 'hidden words'
    })
    callStore.report({
      call: { id: 'call-unanalysed', direction: 'inbound', peer: '+14155550142', status: 'ended' },
      runtimeMode: 'mock', endReason: 'hangup'
    })
    const task = services.tasks.submit({
      to: '+13125550198', goal: 'Book', idempotencyKey: 'post-call-task'
    })
    services.tasks.transition(task.id, 'dialing', { attempts: 1, callId: 'call-post' })
    services.tasks.transition(task.id, 'in_call')
    services.tasks.transition(task.id, 'analyzing')
    services.tasks.transition(task.id, 'completed', {
      resultId: 'result-post', outcome: 'reached', result: { booked: true }
    })

    const analysis = await fetch(`${base}/v1/calls/call-post/analysis`, { headers })
    expect(analysis.status).toBe(200)
    await expect(analysis.json()).resolves.toMatchObject({
      resultId: 'result-post', summary: 'Customer reached', confidence: 'high', analyzedAt: 10
    })
    expect((await fetch(`${base}/v1/calls/missing/analysis`, { headers })).status).toBe(404)
    const unanalysed = await fetch(`${base}/v1/calls/call-unanalysed/analysis`, { headers })
    expect(unanalysed.status).toBe(404)
    await expect(unanalysed.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Call analysis not found' }
    })

    const audit = await fetch(`${base}/v1/calls/call-post/audit?limit=20&offset=0`, { headers })
      .then((response) => response.json()) as { audit: Array<{ action: string; details?: unknown }> }
    expect(audit.audit.map(({ action }) => action)).toEqual(expect.arrayContaining(['call.ended', 'custom.sensitive']))
    const serializedAudit = JSON.stringify(audit)
    expect(serializedAudit).not.toContain('+13125550198')
    expect(serializedAudit).not.toContain('hidden-token')
    expect(serializedAudit).not.toContain('hidden words')

    const plain = await fetch(`${base}/v1/tasks/${task.id}`, { headers }).then((response) => response.json()) as Record<string, unknown>
    expect(plain.transcript).toBeUndefined()
    const expanded = await fetch(
      `${base}/v1/tasks/${task.id}/wait?timeoutMs=0&include=transcript,analysis,call`, { headers }
    ).then((response) => response.json()) as Record<string, unknown>
    expect(expanded).toMatchObject({
      transcript: [{ text: expect.stringContaining('*') }],
      analysis: { resultId: 'result-post' },
      call: { id: 'call-post', peer: expect.stringContaining('*') }
    })
    expect((await fetch(`${base}/v1/tasks/${task.id}?include=unknown`, { headers })).status).toBe(422)
  })
})
