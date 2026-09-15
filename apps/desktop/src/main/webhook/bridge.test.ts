import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  CallLifecycleReport,
  CallTask,
  Campaign,
  GuardrailEvent,
  PhoneCall,
  TranscriptEntry
} from '../../shared/contracts'
import { CallStore } from '../call-store'
import { WebhookBridge } from './bridge'
import { WebhookConfigStore } from './config-store'

function inboundCall(status: PhoneCall['status'], id = 'call-1'): PhoneCall {
  return { id, direction: 'inbound', peer: '+13125550198', status }
}

function makeCampaign(): Campaign {
  return {
    id: 'campaign-1',
    name: 'Default Campaign',
    direction: 'both',
    systemPrompt: 'Answer inbound calls politely',
    voice: 'juniper',
    policy: {
      persona: 'Answer inbound calls politely',
      allowedTopics: [],
      forbiddenTopics: [],
      forbiddenClaims: [],
      negativePrompt: '',
      recordingDisclosure: true,
      maxCallDurationSec: 600,
      callingHours: { timeZone: 'UTC', windows: [] },
      doNotCall: [],
      blockedCallers: []
    },
    createdAt: 1,
    updatedAt: 1
  }
}

function report(
  call: PhoneCall,
  overrides: Partial<CallLifecycleReport> = {}
): CallLifecycleReport {
  return {
    call,
    runtimeMode: 'mock',
    campaign: makeCampaign(),
    threadId: 'thread-1',
    sessionId: 'session-1',
    ...overrides
  }
}

function transcriptEntry(id: string, text: string, speaker: TranscriptEntry['speaker'] = 'caller'): TranscriptEntry {
  return { id, speaker, text, final: true, timestamp: 10 }
}

describe('WebhookBridge', () => {
  let directory: string
  let store: CallStore
  let configStore: WebhookConfigStore
  let bridge: WebhookBridge

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mishu-webhook-bridge-'))
    store = new CallStore(join(directory, 'calls.sqlite3'))
    configStore = new WebhookConfigStore(join(directory, 'webhooks'))
    configStore.save({
      url: 'http://127.0.0.1:9/hook',
      secret: 'test-webhook-secret',
      enabled: true,
      events: [
        'call.started',
        'call.ended',
        'call.transcript.final',
        'recording.ready',
        'guardrail.triggered'
      ]
    })
    bridge = new WebhookBridge({ store, configStore })
  })

  afterEach(() => {
    bridge.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('enqueues a full mock call lifecycle into the outbox with masked numbers', () => {
    store.report(report(inboundCall('ringing')))
    store.reportTranscriptEntry(transcriptEntry('t1', 'Hello'))
    store.reportTranscriptEntry(transcriptEntry('t2', 'Hello, how can I help you?', 'assistant'))
    store.report(report(inboundCall('active')))
    store.putRecording({
      callId: 'call-1',
      path: '/tmp/call-1.webm',
      mime: 'audio/webm',
      status: 'recording'
    })
    store.updateRecordingStatus('call-1', 'complete', {
      bytes: 1234,
      sha256: 'abc123',
      durationMs: 5000
    })
    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))

    const records = bridge.outbox.list(50)
    const types = records.map((record) => record.eventType)
    expect(types).toContain('call.started')
    expect(types).toContain('call.ended')
    expect(types.filter((type) => type === 'call.transcript.final')).toHaveLength(2)
    expect(types).toContain('recording.ready')

    const started = records.find((record) => record.eventType === 'call.started')
    expect(started?.payload.data).toMatchObject({
      callId: 'call-1',
      direction: 'inbound',
      peer: '+1******0198'
    })
    expect(String(started?.payload.data)).not.toContain('13125550198')

    const ended = records.find((record) => record.eventType === 'call.ended')
    expect(ended?.payload.data).toMatchObject({
      endReason: 'hangup',
      campaignName: 'Default Campaign',
      peer: '+1******0198'
    })
    expect(ended?.payload.data).toHaveProperty('durationMs')

    const recording = records.find((record) => record.eventType === 'recording.ready')
    expect(recording?.payload.data).toMatchObject({
      bytes: 1234,
      sha256: 'abc123',
      durationMs: 5000,
      mime: 'audio/webm',
      status: 'complete'
    })
    expect(recording?.payload.data).toHaveProperty('playbackUrl')
    expect(JSON.stringify(recording?.payload.data)).not.toContain('/tmp/')
  })

  it('emits call.ended exactly once and transcript.final per entry id (idempotency)', () => {
    store.report(report(inboundCall('ringing')))
    store.reportTranscriptEntry(transcriptEntry('t1', 'Hello'))
    store.reportTranscriptEntry(transcriptEntry('t1', 'Hello, I would like to ask'))
    store.report(report(inboundCall('active')))
    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))
    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))

    const records = bridge.outbox.list(50)
    expect(records.filter((record) => record.eventType === 'call.started')).toHaveLength(1)
    expect(records.filter((record) => record.eventType === 'call.ended')).toHaveLength(1)
    expect(
      records.filter((record) => record.eventType === 'call.transcript.final')
    ).toHaveLength(1)
  })

  it('emits guardrail.triggered with kind and details', () => {
    store.report(report(inboundCall('ringing')))
    const guardrail: GuardrailEvent = {
      callId: 'call-1',
      kind: 'dnc_blocked',
      at: 42,
      details: { phone: '+13125550198', list: 'internal' }
    }
    store.recordGuardrailEvent(guardrail)

    const record = bridge.outbox
      .list(50)
      .find((entry) => entry.eventType === 'guardrail.triggered')
    expect(record?.payload.data).toMatchObject({
      callId: 'call-1',
      kind: 'dnc_blocked',
      at: 42,
      details: { list: 'internal' }
    })
  })

  it('does not enqueue events that are not subscribed', () => {
    configStore.save({
      url: 'http://127.0.0.1:9/hook',
      secret: 'test-webhook-secret',
      enabled: true,
      events: ['call.ended']
    })
    store.report(report(inboundCall('ringing')))
    store.reportTranscriptEntry(transcriptEntry('t1', 'Hello'))

    const types = bridge.outbox.list(50).map((record) => record.eventType)
    expect(types).not.toContain('call.started')
    expect(types).not.toContain('call.transcript.final')
  })

  it('publishes approval.requested with masked details', () => {
    configStore.save({
      url: 'http://127.0.0.1:9/hook',
      secret: 'test-webhook-secret',
      enabled: true,
      events: ['approval.requested']
    })
    bridge.publishApprovalRequested({
      id: 'approval-1', kind: 'call_dial', title: 'Dial', summary: 'Dial?',
      details: { peer: '+13125550198' }, requestedBy: 'http', expiresAt: 123
    })
    const record = bridge.outbox.list(5)[0]
    expect(record?.eventType).toBe('approval.requested')
    expect(record?.payload.data).toMatchObject({
      approvalId: 'approval-1', details: { peer: '+1******0198' }
    })
  })

  it('does not enqueue anything when webhook is disabled', () => {
    configStore.save({
      url: 'http://127.0.0.1:9/hook',
      secret: 'test-webhook-secret',
      enabled: false,
      events: ['call.started', 'call.ended']
    })
    store.report(report(inboundCall('ringing')))
    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))

    expect(bridge.outbox.list(50)).toHaveLength(0)
  })

  it('keeps the existing secret on save when none is provided', () => {
    configStore.save({
      url: 'http://127.0.0.1:9/hook',
      secret: 'existing-secret',
      enabled: true,
      events: ['call.ended']
    })
    const result = bridge.saveConfig({ events: ['call.ended', 'call.started'] })

    expect(result.hasSecret).toBe(true)
    const saved = configStore.load()
    expect(saved?.secret).toBe('existing-secret')
    expect(JSON.stringify(result)).not.toContain('existing-secret')
  })

  it('rotates the secret, persists it with mode 0600, and returns it once', () => {
    const result = bridge.rotateSecret()

    expect(result.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(result.config.hasSecret).toBe(true)
    expect(JSON.stringify(result.config)).not.toContain(result.secret)
    const saved = configStore.load()
    expect(saved?.secret).toBe(result.secret)
    const filePath = join(directory, 'webhooks', 'webhook-config.json')
    const mode = statSync(filePath).mode & 0o777
    expect(mode).toBe(0o600)

    const publicConfig = bridge.getPublicConfig()
    expect(publicConfig.hasSecret).toBe(true)
    expect(JSON.stringify(publicConfig)).not.toContain(result.secret)
  })

  it('rejects a non-local http url in saveConfig', () => {
    expect(() => bridge.saveConfig({ url: 'http://example.com/hook' })).toThrow()
  })

  it('publishes a subscribed crm.synced event with a bounded payload', () => {
    configStore.save({
      url: 'http://127.0.0.1:9/hook',
      secret: 'test-webhook-secret',
      enabled: true,
      events: ['crm.synced']
    })

    bridge.publishExternalEvent(
      'crm.synced',
      { callId: 'call-1', status: 'succeeded' },
      'crm.synced:call-1'
    )

    const record = bridge.outbox.list(10)[0]
    expect(record?.eventType).toBe('crm.synced')
    expect(record?.payload.data).toEqual({ callId: 'call-1', status: 'succeeded' })
  })

  it('publishes appointment lifecycle events with masked phone numbers', () => {
    configStore.save({
      url: 'http://127.0.0.1:9/hook',
      secret: 'test-webhook-secret',
      enabled: true,
      events: ['appointment.created', 'appointment.confirmed', 'appointment.failed']
    })
    bridge.publishAppointmentEvent('appointment.confirmed', {
      id: 'appointment-1', callId: 'call-1', campaignId: 'campaign-1', peer: '+13125550198',
      startAt: '2030-01-07T15:00:00.000Z', endAt: '2030-01-07T15:30:00.000Z',
      timeZone: 'UTC', status: 'confirmed', source: 'copilot', externalRef: 'calendar-1',
      createdAt: 1, updatedAt: 2
    })
    const record = bridge.outbox.list(10)[0]
    expect(record?.eventType).toBe('appointment.confirmed')
    expect(record?.payload.data).toMatchObject({
      appointmentId: 'appointment-1', peer: '+1******0198', externalRef: 'calendar-1'
    })
    expect(JSON.stringify(record?.payload.data)).not.toContain('13125550198')
  })

  it('publishes task lifecycle and call.analyzed events with masked result values', () => {
    configStore.save({
      url: 'http://127.0.0.1:9/hook',
      secret: 'test-webhook-secret',
      enabled: true,
      events: ['task.queued', 'task.started', 'task.completed', 'task.failed', 'task.cancelled', 'call.analyzed']
    })
    const task: CallTask = {
      id: 'task-1', to: '+13125550198', campaignId: 'campaign-1', goal: 'Confirm attendance',
      constraints: { maxAttempts: 1 }, idempotencyKey: 'task-key', status: 'completed',
      attempts: 1, callId: 'call-1', resultId: 'result-1', outcome: 'reached',
      result: { callback: '+13125550198' }, createdBy: 'http', createdAt: 1, updatedAt: 2
    }

    bridge.publishTaskEvent('task.queued', { ...task, status: 'queued', attempts: 0 })
    bridge.publishTaskEvent('task.started', { ...task, status: 'dialing' })
    bridge.publishTaskEvent('task.completed', task)
    bridge.publishTaskEvent('task.failed', { ...task, status: 'failed' })
    bridge.publishTaskEvent('task.cancelled', { ...task, status: 'cancelled' })
    bridge.publishCallAnalyzed({
      callId: 'call-1', resultId: 'result-1', schemaHash: 'schema-1', outcome: 'reached',
      summary: 'Reached +13125550198', result: { phone: '+13125550198' }, confidence: 'high',
      model: 'mock-analysis', createdAt: 2
    })

    const records = bridge.outbox.list(20)
    expect(records.map(({ eventType }) => eventType)).toEqual(expect.arrayContaining([
      'task.queued', 'task.started', 'task.completed', 'task.failed', 'task.cancelled', 'call.analyzed'
    ]))
    const completed = records.find(({ eventType }) => eventType === 'task.completed')
    const analyzed = records.find(({ eventType }) => eventType === 'call.analyzed')
    expect(completed?.payload.data).toMatchObject({
      taskId: 'task-1', status: 'completed', outcome: 'reached', callId: 'call-1',
      result: { callback: '+1******0198' }
    })
    expect(analyzed?.payload.data).toMatchObject({
      callId: 'call-1', resultId: 'result-1', result: { phone: '+1******0198' }
    })
    expect(JSON.stringify({ completed: completed?.payload.data, analyzed: analyzed?.payload.data })).not.toContain('13125550198')
  })
})
