import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALLS_SCHEMA_VERSION, CallStore } from '../call-store.js'
import { AppointmentStore } from './store.js'

describe('AppointmentStore', () => {
  let directory: string
  let callStore: CallStore
  let store: AppointmentStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'live-phone-appointments-'))
    callStore = new CallStore(join(directory, 'calls.sqlite3'))
    reportCall(callStore)
    store = new AppointmentStore(callStore)
  })

  afterEach(() => {
    callStore.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('migrates the shared calls database to the current version', () => {
    const row = callStore.getDatabase().prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }
    expect(row.version).toBe(CALLS_SCHEMA_VERSION)
    expect(callStore.getDatabase().prepare("SELECT name FROM sqlite_master WHERE name = 'appointments'").get()).toBeTruthy()
  })

  it('creates, updates, lists, and queries appointments by call and peer', () => {
    const listener = vi.fn()
    store.onEvent(listener)
    const created = store.create({
      callId: 'call-1',
      campaignId: 'campaign-1',
      peer: '+1 (312) 555-0198',
      contactName: 'Jordan',
      startAt: '2030-01-07T10:00:00Z',
      endAt: '2030-01-07T10:30:00Z',
      timeZone: 'UTC',
      source: 'copilot',
      notes: 'Initial visit'
    })

    expect(store.get(created.id)).toMatchObject({ peer: '+13125550198', status: 'tentative' })
    expect(store.getByCall('call-1')).toHaveLength(1)
    expect(store.listByPeer('+13125550198')).toHaveLength(1)
    expect(store.list({ limit: 10, offset: 0 })).toHaveLength(1)

    const confirmed = store.update(created.id, { status: 'confirmed', externalRef: 'calendar-1' })
    expect(confirmed).toMatchObject({ status: 'confirmed', externalRef: 'calendar-1' })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'appointment.created' }))
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'appointment.confirmed' }))
    expect(callStore.listAudit({ limit: 20 }).map((entry) => entry.action)).toContain('appointment.confirmed')
  })

  it('returns the existing row for the same peer and start time', () => {
    const input = {
      callId: 'call-1',
      campaignId: 'campaign-1',
      peer: '+13125550198',
      startAt: '2030-01-07T10:00:00Z',
      endAt: '2030-01-07T10:30:00Z',
      timeZone: 'UTC',
      source: 'copilot' as const
    }
    expect(store.create(input).id).toBe(store.create(input).id)
    expect(store.list()).toHaveLength(1)
  })
})

function reportCall(callStore: CallStore): void {
  callStore.report({
    call: { id: 'call-1', direction: 'inbound', peer: '+13125550198', status: 'active' },
    runtimeMode: 'mock',
    campaign: {
      id: 'campaign-1', name: 'Appointments', direction: 'both', systemPrompt: 'Help', voice: 'juniper',
      policy: {
        persona: 'Help', allowedTopics: [], forbiddenTopics: [], forbiddenClaims: [], negativePrompt: '',
        recordingDisclosure: true, maxCallDurationSec: 600,
        callingHours: { timeZone: 'UTC', windows: [] }, doNotCall: [], blockedCallers: []
      },
      createdAt: 1, updatedAt: 1
    }
  })
}
