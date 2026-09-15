import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AppointmentStore } from '../appointments/store.js'
import { CallStore } from '../call-store.js'
import { CampaignStore } from '../campaign-store.js'
import { RecordingWriter } from '../recording-writer.js'
import { WebhookBridge } from '../webhook/bridge.js'
import { WebhookConfigStore } from '../webhook/config-store.js'
import { AppointmentService } from './appointment-service.js'
import { ApprovalService } from './approval-service.js'
import { CallService } from './call-service.js'
import { CampaignService } from './campaign-service.js'
import { ContactService } from './contact-service.js'
import { CrmService } from './crm-service.js'
import { PhoneService } from './phone-service.js'
import { RecordingService } from './recording-service.js'
import { RealtimeService } from './realtime-service.js'
import { RuntimeService } from './runtime-service.js'
import { ServiceError } from './service-error.js'
import { WebhookService } from './webhook-service.js'
import { TaskService } from './task-service.js'
import { BudgetService } from './budget-service.js'
import { AppointmentsConfigStore } from '../appointments/config-store.js'
import { SettingsService } from './settings-service.js'
import { policyFromLegacyPrompt } from '../../shared/policy.js'

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'live-phone-services-'))
  const calls = new CallStore(join(directory, 'calls.sqlite3'))
  const campaigns = new CampaignStore(join(directory, 'campaigns.sqlite3'))
  const appointments = new AppointmentStore(calls)
  const writer = new RecordingWriter(calls, join(directory, 'recordings'))
  writer.initialize()
  const bridge = new WebhookBridge({
    store: calls,
    configStore: new WebhookConfigStore(join(directory, 'webhooks')),
    fetch: vi.fn()
  })
  return { directory, calls, campaigns, appointments, writer, bridge }
}

describe('transport-independent services', () => {
  it('creates, reads, updates, and masks campaigns', () => {
    const value = setup()
    const service = new CampaignService(value.campaigns)
    const workspace = service.create({
      name: 'Outbound', direction: 'outbound', systemPrompt: 'Help', voice: 'juniper',
      outboundCallerId: '+13125550198'
    })
    const created = workspace.campaigns.find(({ name }) => name === 'Outbound')
    expect(created?.outboundCallerId).toContain('*')
    expect(service.update(created?.id, { name: 'Updated' }).campaigns.some(({ name }) => name === 'Updated')).toBe(true)
    expect(() => service.get('missing')).toThrowError(ServiceError)
  })

  it('keeps campaign scripts and personas distinct and maps missing instructions to INVALID_ARGUMENT', () => {
    const value = setup()
    const service = new CampaignService(value.campaigns)
    const scriptOnly = service.create({
      name: 'Script only', direction: 'outbound', systemPrompt: 'Run the full reminder script.', voice: 'sol',
      policy: policyFromLegacyPrompt('')
    }, { reveal: true }).campaigns.find(({ name }) => name === 'Script only')
    expect(scriptOnly).toMatchObject({
      systemPrompt: 'Run the full reminder script.',
      policy: { persona: '' }
    })

    const personaOnly = service.create({
      name: 'Persona only', direction: 'outbound', systemPrompt: '', voice: 'sol',
      policy: { ...policyFromLegacyPrompt(''), persona: 'You are the appointment coordinator.' }
    }, { reveal: true }).campaigns.find(({ name }) => name === 'Persona only')
    expect(personaOnly).toMatchObject({
      systemPrompt: 'You are the appointment coordinator.',
      policy: { persona: 'You are the appointment coordinator.' }
    })

    try {
      service.create({
        name: 'Missing instructions', direction: 'outbound', systemPrompt: '', voice: 'sol',
        policy: policyFromLegacyPrompt('')
      })
      throw new Error('Expected campaign creation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError)
      expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'System prompt cannot be empty' })
    }
  })

  it('reads calls, transcripts, guardrails, recordings, and appointments', () => {
    const value = setup()
    value.calls.report({ call: { id: 'call-1', direction: 'inbound', peer: '+13125550198', status: 'active' }, runtimeMode: 'mock' })
    value.calls.reportTranscriptEntry({ id: 't-1', speaker: 'caller', text: 'hello', final: true, timestamp: 1 })
    value.calls.recordGuardrailEvent({ callId: 'call-1', kind: 'forbidden_claim', at: 2 })
    value.appointments.create({ campaignId: 'campaign-1', callId: 'call-1', peer: '+13125550198', startAt: '2030-01-01T10:00:00Z', endAt: '2030-01-01T10:30:00Z', timeZone: 'UTC', source: 'manual' })
    const service = new CallService(value.calls, value.appointments, value.writer)
    expect(service.get('call-1').peer).toContain('*')
    expect(service.transcript('call-1')).toHaveLength(1)
    expect(service.guardrails('call-1')).toHaveLength(1)
    expect(service.callAppointments('call-1')[0]?.peer).toContain('*')
    expect(() => service.recording('call-1')).toThrowError(ServiceError)
    value.calls.putCallResult({
      id: 'result-1', callId: 'call-1', schemaHash: 'schema-1', outcome: 'reached',
      summary: 'Reached the customer', confidence: 'high', model: 'mock', createdAt: 10
    })
    value.calls.writeAudit('custom.sensitive', 'call-1', {
      peer: '+13125550198', nested: { accessToken: 'do-not-return', transcript: 'private words' }
    })
    expect(service.analysis('call-1')).toMatchObject({
      resultId: 'result-1', summary: 'Reached the customer', analyzedAt: 10
    })
    const audit = service.audit('call-1')
    expect(JSON.stringify(audit)).not.toContain('+13125550198')
    expect(JSON.stringify(audit)).not.toContain('do-not-return')
    expect(JSON.stringify(audit)).not.toContain('private words')
    expect(service.audit('call-1', {}, { reveal: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ details: expect.objectContaining({ peer: '+13125550198' }) })
    ]))
    expect(() => service.analysis('missing')).toThrowError(ServiceError)
  })

  it('optionally inlines call, transcript, and analysis into task reads and waits', async () => {
    const value = setup()
    const campaigns = new CampaignService(value.campaigns)
    const approvals = new ApprovalService()
    const status = { runtimeMode: 'mock' as const, phoneConnection: 'ready' as const, codexConnection: { status: 'ready' as const }, controlMode: 'ai' as const, updatedAt: 1 }
    const gateway = { getStatus: vi.fn(() => status), send: vi.fn() }
    const calls = new CallService(value.calls, value.appointments, value.writer)
    const tasks = new TaskService({ store: value.calls, campaigns, approvals, gateway: gateway as never, calls })
    const task = tasks.submit({ to: '+13125550198', goal: 'Confirm', idempotencyKey: 'inline-read' })
    value.calls.report({ call: { id: 'call-inline', direction: 'outbound', peer: '+13125550198', status: 'active' }, runtimeMode: 'mock' })
    value.calls.reportTranscriptEntry({ id: 't-inline', speaker: 'caller', text: 'Call +13125550198 tomorrow', final: true, timestamp: 1 })
    value.calls.report({ call: { id: 'call-inline', direction: 'outbound', peer: '+13125550198', status: 'ended' }, runtimeMode: 'mock', endReason: 'hangup' })
    value.calls.putCallResult({
      id: 'result-inline', callId: 'call-inline', schemaHash: 'schema-inline', outcome: 'reached',
      summary: 'Confirmed', confidence: 'high', model: 'mock', createdAt: 2
    })
    tasks.transition(task.id, 'dialing', { attempts: 1, callId: 'call-inline' })
    tasks.transition(task.id, 'in_call')
    tasks.transition(task.id, 'analyzing')
    tasks.transition(task.id, 'completed', { resultId: 'result-inline', outcome: 'reached' })

    expect(tasks.get(task.id)).not.toHaveProperty('transcript')
    const included = await tasks.wait(task.id, 0, { include: ['transcript', 'analysis', 'call'] })
    expect(included).toMatchObject({
      call: { id: 'call-inline', peer: expect.stringContaining('*') },
      analysis: { resultId: 'result-inline', summary: 'Confirmed' },
      transcript: [{ text: expect.stringContaining('*') }]
    })
  })

  it('resolves one approval once and ignores later decisions', async () => {
    const service = new ApprovalService({ timeoutMs: 1_000 })
    const pending = service.create({ kind: 'call_dial', title: 'Dial', summary: 'Dial?', details: {}, requestedBy: 'test' })
    expect(service.listPending()).toHaveLength(1)
    expect(service.decide({ id: pending.request.id, approved: true, decidedAt: Date.now() })).toBe(true)
    expect(service.decide({ id: pending.request.id, approved: false, decidedAt: Date.now() })).toBe(false)
    await expect(pending.outcome).resolves.toMatchObject({ approved: true })
  })

  it('shares phone rate limits, approval, and command dispatch', async () => {
    const value = setup()
    const approvals = new ApprovalService()
    const campaigns = new CampaignService(value.campaigns)
    const status = { runtimeMode: 'mock' as const, phoneConnection: 'ready' as const, codexConnection: { status: 'ready' as const }, controlMode: 'ai' as const, updatedAt: 1 }
    const gateway = { getStatus: vi.fn(() => status), send: vi.fn(async () => ({ requestId: 'r', ok: true as const, status })) }
    const service = new PhoneService(gateway as never, campaigns, approvals)
    const pending = service.startDial({ peer: '+13125550198', idempotencyKey: 'one', actor: 'http' })
    approvals.decide({ id: pending.approvalId, approved: true, decidedAt: Date.now() })
    await expect(pending.completion).resolves.toEqual(status)
    expect(service.startDial({ peer: '+13125550198', idempotencyKey: 'one', actor: 'http' })).toBe(pending)
    await expect(service.hangup('copilot')).resolves.toEqual(status)
    expect(gateway.send).toHaveBeenLastCalledWith({ type: 'hangup' }, { actor: 'copilot' })
  })

  it('round-trips appointment, CRM, webhook, recording, runtime, and realtime service paths', async () => {
    const value = setup()
    const appointment = new AppointmentService(new AppointmentsConfigStore(value.directory))
    expect(appointment.save({ timeZone: 'America/Chicago' }).timeZone).toBe('America/Chicago')
    const crm = new CrmService(value.directory, true)
    expect(crm.get()).toMatchObject({ provider: 'mock', connected: true })
    await expect(crm.test()).resolves.toEqual({ ok: true })
    const webhook = new WebhookService(value.bridge)
    expect(webhook.get()).toMatchObject({ enabled: false })
    const recording = new RecordingService(value.calls, value.writer)
    expect(() => recording.start({ callId: '', mime: '' })).toThrow()
    const runtime = new RuntimeService(async () => undefined, true)
    await expect(runtime.getConfig()).resolves.toHaveProperty('mockMode')
    const realtime = new RealtimeService(() => ({ startRealtime: vi.fn() }) as never, vi.fn())
    await expect(realtime.start({ sdp: '' })).rejects.toThrowError(ServiceError)
  })

  it('submits idempotent tasks, validates input, and enforces task transitions', () => {
    const value = setup()
    const campaigns = new CampaignService(value.campaigns)
    const approvals = new ApprovalService()
    const status = { runtimeMode: 'mock' as const, phoneConnection: 'ready' as const, codexConnection: { status: 'ready' as const }, controlMode: 'ai' as const, updatedAt: 1 }
    const gateway = { getStatus: vi.fn(() => status), send: vi.fn() }
    const contacts = new ContactService(value.calls)
    const tasks = new TaskService({ store: value.calls, campaigns, approvals, gateway: gateway as never, contacts })
    const input = { to: '+13125550198', goal: 'Book a demo', idempotencyKey: 'task-key' }
    const first = tasks.submit(input, 'http')
    const second = tasks.submit(input, 'http')
    expect(second.id).toBe(first.id)
    expect(second.to).toContain('*')
    expect(tasks.get(first.id, { reveal: true }).to).toBe('+13125550198')
    expect(tasks.transition(first.id, 'dialing', { attempts: 1 }).status).toBe('dialing')
    expect(() => tasks.transition(first.id, 'completed')).toThrowError(ServiceError)
    expect(() => tasks.submit({ ...input, idempotencyKey: 'bad', to: '555' })).toThrowError(ServiceError)
    tasks.submit({
      ...input,
      idempotencyKey: 'with-contact',
      contact: { displayName: 'Ada', company: 'Analytical Engines', facts: { segment: 'pilot' } }
    })
    expect(contacts.get('+13125550198')).toMatchObject({ displayName: 'Ada', company: 'Analytical Engines' })
    expect(() => tasks.submit({
      ...input,
      idempotencyKey: 'wrong-contact',
      contact: { phone: '+14155550142', displayName: 'Wrong' }
    })).toThrowError('contact.phone must match')
  })

  it('creates a retained ephemeral campaign for an inline task campaign', () => {
    const value = setup()
    const campaigns = new CampaignService(value.campaigns)
    campaigns.create({
      name: 'Selected voice', direction: 'outbound', systemPrompt: 'Default prompt', voice: 'maple'
    })
    const approvals = new ApprovalService()
    const status = { runtimeMode: 'mock' as const, phoneConnection: 'ready' as const, codexConnection: { status: 'ready' as const }, controlMode: 'ai' as const, updatedAt: 1 }
    const gateway = { getStatus: vi.fn(() => status), send: vi.fn() }
    const tasks = new TaskService({ store: value.calls, campaigns, approvals, gateway: gateway as never })

    const input = {
      to: '+13125550198',
      goal: 'Confirm attendance',
      idempotencyKey: 'inline-campaign',
      campaign: {
        direction: 'outbound',
        systemPrompt: 'Ask whether the guest will attend.'
      }
    } as const
    const task = tasks.submit(input)
    const replayed = tasks.submit(input)
    const campaign = campaigns.get(task.campaignId, { reveal: true })

    expect(replayed.campaignId).toBe(task.campaignId)
    expect(campaign).toMatchObject({
      voice: 'maple', ephemeral: true
    })
    expect(campaign.name).toMatch(/^Task [0-9a-f]{8}$/)
    expect(campaigns.list({ includeEphemeral: true })).toContainEqual(campaign)
    expect(campaigns.list({ includeEphemeral: true }).filter(({ ephemeral }) => ephemeral)).toHaveLength(1)
    expect(campaigns.list()).not.toContainEqual(campaign)
    expect(campaigns.workspace().selectedCampaignId).not.toBe(campaign.id)
    expect(() => campaigns.select(campaign.id)).toThrowError('cannot be selected')
    expect(() => tasks.submit({
      to: '+13125550198', goal: 'Invalid', idempotencyKey: 'conflicting-campaign',
      campaignId: campaigns.workspace().selectedCampaignId,
      campaign: { direction: 'outbound', systemPrompt: 'Inline prompt' }
    })).toThrowError('mutually exclusive')
  })

  it('applies the same script/persona fallback rules to inline task campaigns', () => {
    const value = setup()
    const campaigns = new CampaignService(value.campaigns)
    const approvals = new ApprovalService()
    const status = { runtimeMode: 'mock' as const, phoneConnection: 'ready' as const, codexConnection: { status: 'ready' as const }, controlMode: 'ai' as const, updatedAt: 1 }
    const gateway = { getStatus: vi.fn(() => status), send: vi.fn() }
    const tasks = new TaskService({ store: value.calls, campaigns, approvals, gateway: gateway as never })

    const scriptTask = tasks.submit({
      to: '+13125550198', goal: 'Confirm attendance', idempotencyKey: 'inline-script-only',
      campaign: {
        direction: 'outbound', systemPrompt: 'Use the complete reminder script.',
        policy: policyFromLegacyPrompt('')
      }
    })
    expect(campaigns.get(scriptTask.campaignId, { reveal: true })).toMatchObject({
      systemPrompt: 'Use the complete reminder script.', policy: { persona: '' }
    })

    const personaTask = tasks.submit({
      to: '+13125550198', goal: 'Confirm attendance', idempotencyKey: 'inline-persona-only',
      campaign: {
        direction: 'outbound', systemPrompt: '',
        policy: { ...policyFromLegacyPrompt(''), persona: 'You are the attendance coordinator.' }
      }
    })
    expect(campaigns.get(personaTask.campaignId, { reveal: true })).toMatchObject({
      systemPrompt: 'You are the attendance coordinator.',
      policy: { persona: 'You are the attendance coordinator.' }
    })

    expect(() => tasks.submit({
      to: '+13125550198', goal: 'Confirm attendance', idempotencyKey: 'inline-empty',
      campaign: { direction: 'outbound', systemPrompt: '', policy: policyFromLegacyPrompt('') }
    })).toThrowError('campaign.systemPrompt or campaign.policy.persona is required')
  })

  it('validates, expires, masks, and deletes contact cards', () => {
    const value = setup()
    let now = 1_000
    const contacts = new ContactService(value.calls, () => now)
    contacts.upsert({
      phone: '+1 (312) 555-0198', displayName: 'Ada', company: 'Analytical Engines',
      notes: 'Interested in a pilot.', facts: { owner: 'agent' }, source: 'external-agent'
    })
    contacts.upsert({ phone: '+14155550142', displayName: 'Expired', expiresAt: 1_500 })
    expect(contacts.get('+13125550198')).toMatchObject({ phone: '+13125550198', displayName: 'Ada' })
    expect(contacts.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ phone: '+1******0198', displayName: 'Ada' })
    ]))
    now = 1_500
    expect(() => contacts.get('+14155550142')).toThrowError('Contact card not found')
    expect(contacts.list().some(({ displayName }) => displayName === 'Expired')).toBe(false)
    expect(() => contacts.upsert({ phone: '+13125550198', notes: 'x'.repeat(2_001) })).toThrowError(ServiceError)
    expect(() => contacts.upsert({ phone: '+13125550198', facts: { huge: 'x'.repeat(4_001) } })).toThrowError(ServiceError)
    expect(() => contacts.upsert({ phone: '+13125550198', timeZone: 'not/a-zone' })).toThrowError(ServiceError)
    expect(contacts.delete('+13125550198')).toEqual({ deleted: true, phone: '+13125550198' })
    expect(() => contacts.get('+13125550198')).toThrowError(ServiceError)
  })

  it('evaluates global budget allowlists and daily call counts', () => {
    const value = setup()
    const budget = new BudgetService(value.calls, () => Date.UTC(2030, 0, 2, 12))
    expect(budget.isWithinBudget({ to: '+13125550198' })).toBe(false)
    budget.save({
      enabled: true, dailyMaxCalls: 2, dailyMaxMinutes: 10,
      allowedNumbers: ['+13125550198'], allowedPrefixes: [],
      allowedHours: { timeZone: 'UTC', windows: [] }, killSwitch: false
    })
    expect(budget.isWithinBudget({ to: '+13125550198' })).toBe(true)
    expect(budget.isWithinBudget({ to: '+14155550142' })).toBe(false)
    expect(budget.save({ killSwitch: true }).killSwitch).toBe(true)
    expect(budget.isWithinBudget({ to: '+13125550198' })).toBe(false)
  })

  it('persists general settings and applies login launch only on supported platforms', () => {
    const value = setup()
    const setLoginItemSettings = vi.fn()
    const settings = new SettingsService({
      userDataPath: value.directory,
      platform: 'darwin',
      setLoginItemSettings
    })
    expect(settings.general.get()).toEqual({
      minimizeToTray: true,
      launchAtLogin: false,
      startHidden: false
    })
    expect(settings.general.save({ launchAtLogin: true, startHidden: true })).toEqual({
      minimizeToTray: true,
      launchAtLogin: true,
      startHidden: true
    })
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect(new SettingsService({ userDataPath: value.directory }).general.get()).toMatchObject({
      launchAtLogin: true,
      startHidden: true
    })

    const linuxLogin = vi.fn()
    const linux = new SettingsService({
      userDataPath: join(value.directory, 'linux'),
      platform: 'linux',
      setLoginItemSettings: linuxLogin
    })
    linux.general.save({ launchAtLogin: true })
    expect(linuxLogin).not.toHaveBeenCalled()
  })
})
