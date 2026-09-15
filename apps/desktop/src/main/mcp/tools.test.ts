import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpScope, PhoneStatusSnapshot } from '../../shared/contracts.js'
import { CallStore } from '../call-store.js'
import { CampaignStore } from '../campaign-store.js'
import { AppointmentStore } from '../appointments/store.js'
import { ApprovalService } from '../services/approval-service.js'
import { CallService } from '../services/call-service.js'
import { CampaignService } from '../services/campaign-service.js'
import { ContactService } from '../services/contact-service.js'
import { PhoneService } from '../services/phone-service.js'
import { TaskService } from '../services/task-service.js'
import { BudgetService } from '../services/budget-service.js'
import { McpToolService, type ApprovalRequester } from './tools.js'

const READY: PhoneStatusSnapshot = {
  runtimeMode: 'mock',
  phoneConnection: 'ready',
  codexConnection: { status: 'ready' },
  controlMode: 'ai',
  updatedAt: 1
}

function textResult(result: Awaited<ReturnType<McpToolService['invoke']>>) {
  return JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}') as Record<string, unknown>
}

function setup(scopes: McpScope[] = ['read']) {
  const directory = mkdtempSync(join(tmpdir(), 'live-phone-mcp-tools-'))
  const callStore = new CallStore(join(directory, 'calls.sqlite3'))
  const campaignStore = new CampaignStore(join(directory, 'campaigns.sqlite3'))
  const appointmentStore = new AppointmentStore(callStore)
  const send = vi.fn(async () => ({ requestId: 'r', ok: true as const, status: READY }))
  const phoneGateway = { getStatus: vi.fn(() => READY), send }
  const approvals: ApprovalRequester = { request: vi.fn(async () => ({ approved: true as const, decision: { id: 'a', approved: true, decidedAt: 1 } })) }
  const approvalService = new ApprovalService()
  vi.spyOn(approvalService, 'create').mockImplementation((input) => ({
    request: { id: 'a', ...input, expiresAt: Date.now() + 60_000 },
    outcome: approvals.request({ ...input, kind: 'call_dial' })
  }))
  const campaignService = new CampaignService(campaignStore)
  const contactService = new ContactService(callStore)
  const callService = new CallService(callStore, appointmentStore, { getRecordingsPath: () => directory } as never)
  const taskService = new TaskService({
    store: callStore, campaigns: campaignService, approvals: approvalService,
    gateway: phoneGateway as never, contacts: contactService, calls: callService
  })
  const services = {
    approvals: approvalService,
    campaigns: campaignService,
    contacts: contactService,
    calls: callService,
    phone: new PhoneService(phoneGateway as never, campaignService, approvalService),
    tasks: taskService,
    budget: new BudgetService(callStore),
    settings: {
      general: {
        get: vi.fn(() => ({ minimizeToTray: true, launchAtLogin: false, startHidden: false })),
        save: vi.fn((input) => ({ minimizeToTray: true, launchAtLogin: false, startHidden: false, ...input }))
      }
    },
    twilio: {
      get: vi.fn(() => ({ configured: true, apiKeySecret: { configured: true, last4: 'alue', source: 'settings', readOnly: false } })),
      test: vi.fn(async () => ({ ok: true, checks: [{ check: 'token', ok: true, code: 'OK' }] }))
    },
    webhooks: { get: vi.fn(() => ({ enabled: false, url: '', events: [], hasSecret: false })), save: vi.fn((input) => input), test: vi.fn(async () => ({ id: 'w', eventType: 'webhook.test', status: 'delivered', attempts: 1, createdAt: 1 })) },
    mcp: { status: vi.fn(() => ({ enabled: true, running: true, scopes: [], clients: { codex: false, claudeDesktop: false } })), setEnabled: vi.fn(), setScopes: vi.fn(), rotateToken: vi.fn(() => ({ status: {}, token: 'once' })) },
    appointments: { get: vi.fn(() => ({ provider: 'mock', autoConfirm: false, businessHours: { days: [1], start: '09:00', end: '17:00' }, timeZone: 'UTC' })), save: vi.fn((input) => input) },
    crm: { get: vi.fn(() => ({ provider: 'mock', connected: true, hasCredentials: false, postCallSync: false })), save: vi.fn(async (input) => input), test: vi.fn(async () => ({ ok: true })) }
  }
  const service = new McpToolService({
    context: { callStore, appointmentStore, campaignStore, phoneGateway, services } as never,
    approvals,
    getScopes: () => new Set(scopes)
  })
  return { service, callStore, campaignStore, phoneGateway, approvals, approvalService, services }
}

describe('McpToolService', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('enforces scope before invoking a tool and audits the denial', async () => {
    const { service, callStore } = setup([])
    const result = await service.invoke('phone_get_status')
    expect(result.isError).toBe(true)
    expect(textResult(result)).toMatchObject({ error: { code: 'SCOPE_DENIED' } })
    expect(callStore.listAudit()[0]).toMatchObject({ actor: 'mcp', action: 'mcp.tool' })
  })

  it('returns only masked Twilio settings and safe test codes', async () => {
    const { service } = setup(['read'])
    const settings = textResult(await service.invoke('settings_twilio_get'))
    const tested = textResult(await service.invoke('settings_twilio_test'))
    expect(settings).toMatchObject({ apiKeySecret: { configured: true, last4: 'alue' } })
    expect(tested).toMatchObject({ ok: true, checks: [{ code: 'OK' }] })
    expect(JSON.stringify({ settings, tested })).not.toContain('top-secret-value')
  })

  it('preserves the call store masking in call_list without corrupting the number', async () => {
    const { service, callStore } = setup(['read'])
    callStore.report({
      call: { id: 'call-1', direction: 'inbound', peer: '+14155550142', status: 'ended' },
      runtimeMode: 'mock'
    })
    const result = textResult(await service.invoke('call_list', { limit: 10, offset: 0 })) as {
      calls: Array<{ peer: string }>
    }
    expect(result.calls[0]?.peer).toContain('*')
    expect(result.calls[0]?.peer).not.toContain('4155550142')
  })

  it('masks phone mappings returned by campaign management tools', async () => {
    const { service } = setup(['manage_campaigns'])
    const result = textResult(await service.invoke('campaign_create', {
      name: 'Outbound',
      direction: 'outbound',
      systemPrompt: 'Be helpful',
      voice: 'juniper',
      outboundCallerId: '+13125550198'
    })) as { campaigns: Array<{ name: string; outboundCallerId?: string }> }
    const created = result.campaigns.find((campaign) => campaign.name === 'Outbound')
    expect(created?.outboundCallerId).toContain('*')
    expect(created?.outboundCallerId).not.toContain('3125550198')
  })

  it('keeps campaign scripts and personas independent across MCP create and update', async () => {
    const { service } = setup(['manage_campaigns'])
    const scriptWorkspace = textResult(await service.invoke('campaign_create', {
      name: 'Script only', direction: 'outbound',
      systemPrompt: 'Follow the complete reminder script.', voice: 'sol',
      policy: { recordingDisclosure: false }
    })) as { campaigns: Array<{ id: string; name: string; systemPrompt: string; policy: { persona: string } }> }
    const scriptOnly = scriptWorkspace.campaigns.find(({ name }) => name === 'Script only')
    expect(scriptOnly).toMatchObject({
      systemPrompt: 'Follow the complete reminder script.', policy: { persona: '' }
    })

    const personaWorkspace = textResult(await service.invoke('campaign_update', {
      id: scriptOnly?.id,
      systemPrompt: '',
      policy: { persona: 'You are the appointment coordinator.', recordingDisclosure: false }
    })) as { campaigns: Array<{ id: string; systemPrompt: string; policy: { persona: string } }> }
    expect(personaWorkspace.campaigns.find(({ id }) => id === scriptOnly?.id)).toMatchObject({
      systemPrompt: 'You are the appointment coordinator.',
      policy: { persona: 'You are the appointment coordinator.' }
    })

    expect(textResult(await service.invoke('campaign_create', {
      name: 'Empty', direction: 'outbound', voice: 'sol', policy: {}
    }))).toMatchObject({ error: { code: 'INVALID_ARGUMENT', message: 'System prompt cannot be empty' } })
  })

  it('lists appointments as a read-scoped tool with masked phone numbers', async () => {
    const { service, callStore } = setup(['read'])
    const appointmentStore = new AppointmentStore(callStore)
    appointmentStore.create({
      campaignId: 'campaign-1', peer: '+13125550198',
      startAt: '2030-01-07T15:00:00Z', endAt: '2030-01-07T15:30:00Z',
      timeZone: 'UTC', source: 'mcp'
    })
    const result = textResult(await service.invoke('appointment_list', { limit: 10 })) as {
      appointments: Array<{ peer: string }>
    }
    expect(result.appointments[0]?.peer).toBe('+1******0198')
    expect(result.appointments[0]?.peer).not.toContain('13125550198')
  })

  it('returns CALL_IN_PROGRESS before requesting approval', async () => {
    const { service, phoneGateway, approvals } = setup(['read', 'control_calls'])
    phoneGateway.getStatus.mockReturnValue({ ...READY, call: { id: 'c', direction: 'outbound', peer: '+12125550111', status: 'active' } })
    const result = await service.invoke('call_dial', { peer: '+12125550112', idempotency_key: 'key-1' })
    expect(textResult(result)).toMatchObject({ error: { code: 'CALL_IN_PROGRESS' } })
    expect(approvals.request).not.toHaveBeenCalled()
  })

  it('returns the first result for a repeated idempotency key', async () => {
    const { service, phoneGateway } = setup(['control_calls'])
    const args = { peer: '+12125550112', idempotency_key: 'same-key' }
    const first = await service.invoke('call_dial', args)
    const second = await service.invoke('call_dial', args)
    expect(second).toEqual(first)
    expect(phoneGateway.send).toHaveBeenCalledTimes(1)
  })

  it('rate limits the same number after a successful dial', async () => {
    const { service, phoneGateway } = setup(['control_calls'])
    await service.invoke('call_dial', { peer: '+12125550112', idempotency_key: 'one' })
    const result = await service.invoke('call_dial', { peer: '+12125550112', idempotency_key: 'two' })
    expect(textResult(result)).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(phoneGateway.send).toHaveBeenCalledTimes(1)
  })

  it('returns approval timeout without dialing', async () => {
    const { service, phoneGateway, approvals } = setup(['control_calls'])
    vi.mocked(approvals.request).mockResolvedValue({ approved: false, code: 'APPROVAL_TIMEOUT' })
    const result = await service.invoke('call_dial', { peer: '+12125550112', idempotency_key: 'timeout' })
    expect(textResult(result)).toMatchObject({ error: { code: 'APPROVAL_TIMEOUT' } })
    expect(phoneGateway.send).not.toHaveBeenCalled()
  })

  it('updates campaign policy and exposes answer, approval, and settings tools through services', async () => {
    const { service, phoneGateway, approvalService, services } = setup([
      'read', 'manage_campaigns', 'control_calls', 'send_messages'
    ])
    const campaign = service.campaigns()[0]!
    const updated = textResult(await service.invoke('campaign_policy_update', {
      id: campaign.id,
      policy: { ...campaign.policy, persona: 'API policy' }
    })) as { campaigns: Array<{ policy: { persona: string } }> }
    expect(updated.campaigns.find(({ policy }) => policy.persona === 'API policy')).toBeTruthy()

    await service.invoke('call_answer')
    expect(phoneGateway.send).toHaveBeenCalledWith({ type: 'answer' }, { actor: 'mcp' })

    const pending = approvalService.requestExisting({
      id: 'approval-tool', kind: 'call_dial', title: 'Dial', summary: 'Dial?',
      details: { peer: '+13125550198' }, requestedBy: 'test', expiresAt: Date.now() + 10_000
    })
    expect(textResult(await service.invoke('approval_list'))).toMatchObject({
      approvals: [{ id: 'approval-tool', details: { peer: expect.stringContaining('*') } }]
    })
    await service.invoke('approval_decide', { id: 'approval-tool', approved: true })
    await expect(pending).resolves.toMatchObject({ approved: true })

    await service.invoke('settings_webhook_update', { enabled: false })
    await service.invoke('settings_appointments_update', { timeZone: 'UTC' })
    await service.invoke('settings_crm_test')
    expect(services.webhooks.save).toHaveBeenCalled()
    expect(services.appointments.save).toHaveBeenCalled()
    expect(services.crm.test).toHaveBeenCalled()
  })

  it('exposes task and budget tools with transport scopes', async () => {
    const { service, services, callStore } = setup(['read', 'control_calls'])
    const task = textResult(await service.invoke('task_submit', {
      to: '+13125550198', goal: 'Book a demo', idempotency_key: 'mcp-task-1',
      result_schema: { type: 'object', properties: {} }
    })) as { id: string; to: string }
    expect(task.id).toBeTruthy()
    expect(task.to).toContain('*')
    expect(textResult(await service.invoke('task_get', { id: task.id }))).toMatchObject({ id: task.id })
    expect(textResult(await service.invoke('task_list'))).toMatchObject({ tasks: [{ id: task.id }] })
    expect(textResult(await service.invoke('task_cancel', { id: task.id }))).toMatchObject({ status: 'cancelled' })

    const inline = textResult(await service.invoke('task_submit', {
      to: '+13125550198', goal: 'Confirm attendance', idempotency_key: 'mcp-task-inline',
      campaign: {
        name: 'One-time MCP', direction: 'outbound', systemPrompt: 'Ask whether the guest will attend.'
      }
    })) as { campaignId: string }
    expect(services.campaigns.get(inline.campaignId, { reveal: true })).toMatchObject({
      name: 'One-time MCP', ephemeral: true
    })
    expect(services.campaigns.list().some(({ id }) => id === inline.campaignId)).toBe(false)
    expect(JSON.stringify(callStore.listAudit())).not.toContain('Ask whether the guest will attend.')
    expect(textResult(await service.invoke('task_submit', {
      to: '+13125550198', goal: 'Invalid', idempotency_key: 'mcp-task-conflict',
      campaign_id: services.campaigns.workspace().selectedCampaignId,
      campaign: { direction: 'outbound', systemPrompt: 'Inline' }
    }))).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })

    expect(textResult(await service.invoke('budget_get'))).toMatchObject({ enabled: false })
    expect(textResult(await service.invoke('budget_update', {
      enabled: true, dailyMaxCalls: 5, dailyMaxMinutes: 20,
      allowedNumbers: ['+13125550198'], allowedPrefixes: [],
      allowedHours: { timeZone: 'UTC', windows: [] }, killSwitch: false
    }))).toMatchObject({ enabled: true, dailyMaxCalls: 5 })
  })

  it('gets analysis and sanitized audit and expands task data on demand', async () => {
    const { service, services, callStore } = setup(['read'])
    callStore.report({
      call: { id: 'call-post', direction: 'outbound', peer: '+13125550198', status: 'active' },
      runtimeMode: 'mock'
    })
    callStore.reportTranscriptEntry({
      id: 't-post', speaker: 'caller', text: 'Reach me at +13125550198', final: true, timestamp: 1
    })
    callStore.report({
      call: { id: 'call-post', direction: 'outbound', peer: '+13125550198', status: 'ended' },
      runtimeMode: 'mock', endReason: 'hangup'
    })
    callStore.putCallResult({
      id: 'result-post', callId: 'call-post', schemaHash: 'schema-post', outcome: 'reached',
      summary: 'Reached', confidence: 'high', model: 'mock', createdAt: 2
    })
    callStore.writeAudit('sensitive', 'call-post', { peer: '+13125550198', refreshToken: 'secret-value' })
    const task = services.tasks.submit({ to: '+13125550198', goal: 'Reach', idempotencyKey: 'mcp-expand' })
    services.tasks.transition(task.id, 'dialing', { attempts: 1, callId: 'call-post' })
    services.tasks.transition(task.id, 'in_call')
    services.tasks.transition(task.id, 'analyzing')
    services.tasks.transition(task.id, 'completed', { resultId: 'result-post', outcome: 'reached' })

    expect(textResult(await service.invoke('call_analysis_get', { id: 'call-post' }))).toMatchObject({
      resultId: 'result-post', summary: 'Reached'
    })
    const audit = textResult(await service.invoke('call_audit_list', { id: 'call-post', limit: 20 }))
    expect(JSON.stringify(audit)).not.toContain('+13125550198')
    expect(JSON.stringify(audit)).not.toContain('secret-value')
    expect(textResult(await service.invoke('task_get', {
      id: task.id, include: 'transcript,analysis,call'
    }))).toMatchObject({
      transcript: [{ text: expect.stringContaining('*') }],
      analysis: { resultId: 'result-post' },
      call: { id: 'call-post', peer: expect.stringContaining('*') }
    })
  })

  it('enforces write scope and round-trips contact cards', async () => {
    const denied = setup(['read'])
    expect(textResult(await denied.service.invoke('contact_card_set', {
      phone: '+13125550198', displayName: 'Ada'
    }))).toMatchObject({ error: { code: 'SCOPE_DENIED' } })

    const { service, callStore } = setup(['read', 'manage_campaigns'])
    expect(textResult(await service.invoke('contact_card_set', {
      phone: '+13125550198', displayName: 'Ada', company: 'Analytical Engines'
    }))).toMatchObject({ displayName: 'Ada', phone: '+13125550198' })
    expect(JSON.stringify(callStore.listAudit()[0])).not.toContain('Analytical Engines')
    expect(textResult(await service.invoke('contact_card_get', { phone: '+13125550198' }))).toMatchObject({ displayName: 'Ada' })
    expect(textResult(await service.invoke('contact_card_list'))).toMatchObject({
      contacts: [{ displayName: 'Ada', phone: expect.stringContaining('*') }]
    })
    expect(textResult(await service.invoke('contact_card_delete', { phone: '+13125550198' }))).toMatchObject({ deleted: true })
  })

  it('round-trips general settings through MCP tools', async () => {
    const { service, services } = setup(['read', 'manage_campaigns'])
    expect(textResult(await service.invoke('settings_general_get'))).toEqual({
      minimizeToTray: true,
      launchAtLogin: false,
      startHidden: false
    })
    expect(textResult(await service.invoke('settings_general_update', {
      minimizeToTray: false,
      startHidden: true
    }))).toMatchObject({ minimizeToTray: false, startHidden: true })
    expect(services.settings.general.save).toHaveBeenCalledWith({
      minimizeToTray: false,
      startHidden: true
    })
  })
})
