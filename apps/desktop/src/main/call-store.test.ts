import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  CallLifecycleReport,
  Campaign,
  PhoneCall,
  TranscriptEntry
} from '../shared/contracts'
import { CALLS_SCHEMA_VERSION, CallStore, ORPHANED_CALL_THRESHOLD_MS } from './call-store'

function inboundCall(status: PhoneCall['status'], id = 'call-1'): PhoneCall {
  return { id, direction: 'inbound', peer: '+13125550198', status }
}

function report(
  call: PhoneCall,
  overrides: Partial<CallLifecycleReport> = {}
): CallLifecycleReport {
  return {
    call,
    runtimeMode: 'mock',
    campaign: {
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
    },
    threadId: 'thread-1',
    sessionId: 'session-1',
    ...overrides
  }
}

describe('CallStore', () => {
  let directory: string
  let databasePath: string
  let store: CallStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mishu-calls-'))
    databasePath = join(directory, 'calls.sqlite3')
    store = new CallStore(databasePath)
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('creates a session with the campaign snapshot and runtime mode', () => {
    store.report(report(inboundCall('ringing')))

    const session = store.getCall('call-1')

    expect(session).toMatchObject({
      id: 'call-1',
      direction: 'inbound',
      peer: '+13125550198',
      status: 'ringing',
      runtimeMode: 'mock',
      campaignId: 'campaign-1',
      campaignName: 'Default Campaign',
      campaignSystemPrompt: 'Answer inbound calls politely',
      campaignVoice: 'juniper',
      threadId: 'thread-1',
      sessionId: 'session-1'
    })
    expect(session?.createdAt).toBeGreaterThan(0)
    expect(session?.updatedAt).toBeGreaterThan(0)
  })

  it('stores the actual API voice and provider in a new call snapshot', () => {
    store.report(report(inboundCall('ringing')), { provider: 'gpt-live-api', voice: 'marin' })
    expect(store.getCall('call-1')).toMatchObject({
      campaignVoice: 'marin',
      voiceProvider: 'gpt-live-api'
    })
  })

  it('persists contact cards and freezes the summary used by a call', () => {
    const card = store.putContactCard({
      phone: '+13125550198', displayName: 'Ada', company: 'Analytical Engines',
      tier: 'Gold', language: 'en', notes: 'Pilot customer', facts: { owner: 'agent' },
      source: 'external-agent', createdAt: 100, updatedAt: 100
    })
    expect(store.getContactCard(card.phone)).toEqual(card)
    expect(store.listContactCards({}, 101)).toEqual([card])

    store.report(report(inboundCall('ringing')))
    store.attachContactCard('call-1', {
      displayName: card.displayName,
      company: card.company,
      tier: card.tier,
      language: card.language,
      notes: card.notes
    })
    store.putContactCard({ ...card, displayName: 'Changed', updatedAt: 200 })
    expect(store.getCall('call-1')?.contactCard).toMatchObject({ displayName: 'Ada', tier: 'Gold' })
    expect(store.deleteContactCard(card.phone)).toBe(true)
    expect(store.getContactCard(card.phone)).toBeUndefined()
  })

  it('persists call tasks, enforces idempotency, and stores the global budget', () => {
    const now = Date.now()
    const task = store.createCallTask({
      id: 'task-1', to: '+13125550198', campaignId: 'campaign-1', goal: 'Book a demo',
      constraints: { maxAttempts: 2 }, idempotencyKey: 'idem-1', status: 'queued', attempts: 0,
      createdBy: 'http', createdAt: now, updatedAt: now
    })
    expect(task).toMatchObject({ id: 'task-1', to: '+13125550198', status: 'queued' })
    expect(store.getCallTaskByIdempotencyKey('idem-1')?.id).toBe('task-1')
    expect(store.updateCallTask('task-1', { status: 'dialing', attempts: 1, updatedAt: now + 1 })).toMatchObject({
      status: 'dialing', attempts: 1
    })
    expect(store.listCallTasks({ status: 'dialing' })).toHaveLength(1)

    expect(store.getCallBudget()).toMatchObject({ enabled: false, killSwitch: false })
    expect(store.saveCallBudget({
      enabled: true, dailyMaxCalls: 5, dailyMaxMinutes: 30,
      allowedPrefixes: ['+1'], allowedNumbers: ['+13125550198'],
      allowedHours: { timeZone: 'UTC', windows: [] }, killSwitch: false
    })).toMatchObject({ enabled: true, dailyMaxCalls: 5 })
  })

  it('migrates ringing -> active -> ended and records answered/ended timestamps', () => {
    store.report(report(inboundCall('ringing')))
    store.report(report(inboundCall('active'), { endReason: undefined }))
    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))

    const session = store.getCall('call-1')

    expect(session?.status).toBe('ended')
    expect(session?.answeredAt).toBeDefined()
    expect(session?.endedAt).toBeDefined()
    expect(session?.durationMs).toBeGreaterThanOrEqual(0)
    expect(session?.endReason).toBe('hangup')
  })

  it.each([
    ['remote_hangup', 'ended'],
    ['local_hangup', 'ended'],
    ['carrier_error', 'error'],
    ['session_error', 'ended']
  ] as const)('persists the explicit %s end reason', (endReason, status) => {
    store.report(report(inboundCall('active')))
    store.report(report(inboundCall(status), { endReason }))

    expect(store.getCall('call-1')?.endReason).toBe(endReason)
  })

  it('keeps multiple reports for the same callId idempotent', () => {
    store.report(report(inboundCall('ringing')))
    store.report(report(inboundCall('ringing')))
    store.report(report(inboundCall('active')))
    store.report(report(inboundCall('active')))
    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))

    expect(store.listCalls({})).toHaveLength(1)
    const session = store.getCall('call-1')
    expect(session?.status).toBe('ended')
  })

  it('attaches a late provider CallSid without creating a second session', () => {
    store.report(report({
      id: 'outbound-provisional', direction: 'outbound', peer: '+13125550198', status: 'dialing'
    }))
    store.report(report({
      id: 'outbound-provisional', direction: 'outbound', peer: '+13125550198',
      status: 'active', providerCallSid: 'CA-provider'
    }))

    expect(store.listCalls({})).toHaveLength(1)
    expect(store.getCall('outbound-provisional')).toMatchObject({
      id: 'outbound-provisional',
      providerCallSid: 'CA-provider',
      status: 'active'
    })
  })

  it('finalizes stale pre-connect sessions on startup and audits the cleanup', () => {
    const startedAt = Date.now() - ORPHANED_CALL_THRESHOLD_MS - 1
    store.report(report({
      id: 'orphaned-dial', direction: 'outbound', peer: '+13125550198',
      status: 'dialing', startedAt
    }))
    store.getDatabase().prepare(`
      UPDATE call_sessions SET created_at = ?, started_at = ?, updated_at = ? WHERE id = ?
    `).run(startedAt, startedAt, startedAt, 'orphaned-dial')
    store.close()
    store = new CallStore(databasePath)

    expect(store.getCall('orphaned-dial')).toMatchObject({
      status: 'ended',
      endReason: 'unknown',
      endedAt: expect.any(Number)
    })
    expect(store.listAudit({ limit: 10 })).toContainEqual(expect.objectContaining({
      action: 'call.orphaned',
      callId: 'orphaned-dial',
      details: {
        previousStatus: 'dialing',
        staleAfterMs: ORPHANED_CALL_THRESHOLD_MS
      }
    }))
  })

  it('upserts transcript entries by id, letting a final entry overwrite a delta', () => {
    store.report(report(inboundCall('ringing')))
    store.reportTranscriptEntry({
      id: 't1',
      speaker: 'caller',
      text: 'Hello',
      final: false,
      timestamp: 10
    })
    store.reportTranscriptEntry({
      id: 't1',
      speaker: 'caller',
      text: 'Hello, I would like to ask a question',
      final: true,
      timestamp: 20
    })

    const transcript = store.getCallTranscript('call-1')

    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({
      id: 't1',
      speaker: 'caller',
      text: 'Hello, I would like to ask a question',
      final: true
    })
  })

  it('lists calls in reverse chronological order with pagination', async () => {
    store.report({ ...report(inboundCall('ended'), { endReason: 'hangup' }), call: { ...inboundCall('ended'), id: 'call-1' } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.report({ ...report(inboundCall('ended'), { endReason: 'hangup' }), call: { ...inboundCall('ended'), id: 'call-2' } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.report({ ...report(inboundCall('ended'), { endReason: 'hangup' }), call: { ...inboundCall('ended'), id: 'call-3' } })

    const first = store.listCalls({ limit: 2, offset: 0 })
    const second = store.listCalls({ limit: 2, offset: 2 })

    expect(first.map(({ id }) => id)).toEqual(['call-3', 'call-2'])
    expect(second.map(({ id }) => id)).toEqual(['call-1'])
  })

  it('masks peer numbers in listCalls but exposes the full number in getCall', () => {
    store.report(report(inboundCall('ringing')))

    const summaries = store.listCalls({})
    const session = store.getCall('call-1')

    expect(summaries[0]?.peer).toBe('+1******0198')
    expect(session?.peer).toBe('+13125550198')
  })

  it('returns undefined for an unknown call', () => {
    expect(store.getCall('missing')).toBeUndefined()
  })

  it('freezes the campaign snapshot after the session is created', () => {
    store.report(report(inboundCall('ringing')))
    const changedCampaign: Campaign = {
      id: 'campaign-1',
      name: 'Renamed Campaign',
      direction: 'both',
      systemPrompt: 'Updated system prompt',
      voice: 'maple',
      policy: {
        persona: 'Updated system prompt',
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
      updatedAt: 2
    }
    store.report(report(inboundCall('active'), { campaign: changedCampaign }))

    const session = store.getCall('call-1')

    expect(session?.campaignName).toBe('Default Campaign')
    expect(session?.campaignSystemPrompt).toBe('Answer inbound calls politely')
    expect(session?.campaignVoice).toBe('juniper')
  })

  it('writes audit entries when a session is created and ended', () => {
    store.report(report(inboundCall('ringing')))
    store.report(report(inboundCall('active')))
    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))

    const audit = store.listAudit({ limit: 10 })

    expect(audit.length).toBeGreaterThanOrEqual(2)
    expect(audit.some(({ action }) => action === 'call.created')).toBe(true)
    expect(audit.some(({ action }) => action === 'call.ended')).toBe(true)
  })

  it('drops transcript entries for unknown sessions into the audit log without throwing', () => {
    expect(() =>
      store.reportTranscriptEntry({
        id: 'orphan',
        speaker: 'caller',
        text: 'No active session',
        final: true,
        timestamp: 5
      })
    ).not.toThrow()

    const audit = store.listAudit({ limit: 10 })
    expect(audit.some(({ action }) => action === 'transcript.dropped')).toBe(true)
  })

  it('tracks the active call id and clears it once the call ends', () => {
    store.report(report(inboundCall('ringing')))

    expect(store.getActiveCallId()).toBe('call-1')

    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))

    expect(store.getActiveCallId()).toBeUndefined()
  })

  it('rejects transcript text longer than 20000 characters', () => {
    store.report(report(inboundCall('ringing')))

    expect(() =>
      store.reportTranscriptEntry({
        id: 'too-long',
        speaker: 'caller',
        text: 'x'.repeat(20_001),
        final: true,
        timestamp: 1
      })
    ).toThrow('cannot exceed 20000 characters')
  })

  it('upserts recording rows and reports incomplete recordings', () => {
    store.report(report(inboundCall('ringing')))
    store.report(report(inboundCall('ended'), { endReason: 'hangup', call: inboundCall('ended') }))
    store.report(report(inboundCall('ringing', 'call-2')))
    store.report(report(inboundCall('ended', 'call-2'), { endReason: 'hangup', call: inboundCall('ended', 'call-2') }))
    expect(store.getCall('call-1')?.id).toBe('call-1')
    expect(store.getCall('call-2')?.id).toBe('call-2')
    store.putRecording({ callId: 'call-1', path: '/tmp/call-1.webm', mime: 'audio/webm', status: 'recording' })

    expect(store.getRecording('call-1')).toMatchObject({
      callId: 'call-1',
      playbackUrl: 'live-phone-recording://call/call-1',
      mime: 'audio/webm',
      status: 'recording'
    })
    expect(store.getRecording('call-1')?.playbackUrl).toBeTruthy()
    expect((store.getRecording('call-1') as { path?: string }).path).toBeUndefined()
    expect(store.getRecordingPath('call-1')).toBe('/tmp/call-1.webm')

    store.updateRecordingStatus('call-1', 'complete', { bytes: 12, sha256: 'abc', durationMs: 340 })
    expect(store.getRecording('call-1')).toMatchObject({ status: 'complete', bytes: 12, sha256: 'abc', durationMs: 340 })

    store.putRecording({ callId: 'call-1', path: '/tmp/call-1.webm', mime: 'audio/webm', status: 'recording' })
    store.putRecording({ callId: 'call-2', path: '/tmp/call-2.webm', mime: 'audio/webm', status: 'recording' })
    expect(store.listIncompleteRecordings().map(({ callId }) => callId).sort()).toEqual(['call-1', 'call-2'])
  })

  it('records guardrail events to the audit log and lists them back', () => {
    store.report(report(inboundCall('ringing')))

    store.recordGuardrailEvent({ callId: 'call-1', kind: 'max_duration', at: 100, details: { limitSec: 600 } })
    store.recordGuardrailEvent({ callId: 'call-1', kind: 'forbidden_claim', at: 200 })

    const events = store.listGuardrailEvents('call-1')
    expect(events).toEqual([
      { callId: 'call-1', kind: 'max_duration', at: 100, details: { limitSec: 600 } },
      { callId: 'call-1', kind: 'forbidden_claim', at: 200 }
    ])
    expect(store.listAudit({ limit: 20 }).some(({ action }) => action === 'guardrail.max_duration')).toBe(true)
  })

  it('rejects guardrail events with an invalid kind or unknown callId', () => {
    expect(() => store.recordGuardrailEvent({ callId: 'call-1', kind: 'nope' as never, at: 1 })).toThrow('kind is invalid')

    expect(() => store.recordGuardrailEvent({ callId: 'missing', kind: 'blocked_caller', at: 1 })).toThrow('session does not exist')
  })

  it('records pre-dial guardrail events without a session into the audit log', () => {
    store.recordGuardrailEvent({
      callId: 'pre-dial',
      kind: 'dnc_blocked',
      at: 123,
      details: { peer: '+1******0198', message: 'Number is on the DNC list' }
    })

    const audit = store.listAudit({ limit: 10 })
    const entry = audit.find(({ action }) => action === 'guardrail.dnc_blocked')
    expect(entry).toBeDefined()
    expect(entry?.callId).toBeUndefined()
    expect(entry?.details).toEqual({
      kind: 'dnc_blocked',
      at: 123,
      details: { peer: '+1******0198', message: 'Number is on the DNC list' }
    })
  })

  it('migrates and stores idempotent call analysis results', () => {
    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))
    const first = store.putCallResult({
      id: 'result-1',
      callId: 'call-1',
      schemaHash: 'schema-a',
      outcome: 'reached',
      summary: 'The customer is willing to keep talking',
      result: { interested: true },
      confidence: 'high',
      model: 'mock-analysis',
      createdAt: 100
    })
    const duplicate = store.putCallResult({
      ...first,
      id: 'result-2',
      summary: 'should not overwrite',
      createdAt: 200
    })

    expect(duplicate).toEqual(first)
    expect(store.getCallResult('call-1', 'schema-a')).toEqual(first)
    const latest = store.putCallResult({
      ...first,
      id: 'result-latest',
      schemaHash: 'schema-b',
      summary: 'latest analysis',
      createdAt: 300
    })
    expect(store.getLatestCallResult('call-1')).toEqual(latest)
    expect(
      store.getDatabase().prepare('SELECT MAX(version) AS version FROM schema_version').get()
    ).toEqual({ version: CALLS_SCHEMA_VERSION })
  })

  it('lists one call audit chronologically with offset pagination', () => {
    store.report(report(inboundCall('ringing')))
    store.writeAudit('custom.first', 'call-1', { sequence: 1 })
    store.writeAudit('custom.second', 'call-1', { sequence: 2 })
    store.writeAudit('other.call', 'call-other')

    const page = store.listCallAudit('call-1', { limit: 2, offset: 1 })
    expect(page.map(({ action }) => action)).toEqual(['custom.first', 'custom.second'])
    expect(page.map(({ details }) => details)).toEqual([{ sequence: 1 }, { sequence: 2 }])
  })

  it('persists and advances analysis retry jobs', () => {
    store.report(report(inboundCall('ended'), { endReason: 'hangup' }))
    const job = store.enqueueAnalysisJob({
      callId: 'call-1',
      schemaHash: 'schema-a',
      resultSchema: { type: 'object', properties: { note: { type: ['string', 'null'] } } },
      goal: "Learn the customer's intent",
      now: 100
    })

    expect(store.listDueAnalysisJobs(99)).toEqual([])
    expect(store.listDueAnalysisJobs(100)).toEqual([job])

    store.markAnalysisJobProcessing(job.id, 101)
    store.markAnalysisJobFailed(job.id, {
      status: 'failed',
      attempts: 1,
      nextAttemptAt: 1_101,
      lastError: 'temporary failure',
      updatedAt: 101
    })

    expect(store.getAnalysisJob('call-1', 'schema-a')).toMatchObject({
      status: 'failed',
      attempts: 1,
      nextAttemptAt: 1_101,
      lastError: 'temporary failure'
    })
    expect(store.listDueAnalysisJobs(1_100)).toEqual([])
    expect(store.listDueAnalysisJobs(1_101)).toHaveLength(1)

    store.markAnalysisJobSucceeded(job.id, 2, 1_102)
    expect(store.getAnalysisJob('call-1', 'schema-a')).toMatchObject({
      status: 'succeeded',
      attempts: 2
    })
  })
})
