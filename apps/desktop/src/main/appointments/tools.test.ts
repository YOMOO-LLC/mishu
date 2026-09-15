import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallStore } from '../call-store.js'
import type { ToolExecutionContext } from '../copilot/registry.js'
import { MockCalendarAdapter } from './mock-calendar.js'
import { AppointmentStore } from './store.js'
import { createAppointmentTools } from './tools.js'

const context: ToolExecutionContext = {
  campaignId: 'ignored-model-campaign', callSessionId: 'call-1', actor: 'copilot'
}

describe('appointment copilot tools', () => {
  let directory: string
  let callStore: CallStore
  let store: AppointmentStore
  let calendar: MockCalendarAdapter

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'live-phone-appointment-tools-'))
    callStore = new CallStore(join(directory, 'calls.sqlite3'))
    reportCall(callStore)
    store = new AppointmentStore(callStore)
    calendar = new MockCalendarAdapter()
  })

  afterEach(() => {
    callStore.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('declares the required risk levels and validates slot arguments', () => {
    const [check, make, list] = tools()
    expect([check?.risk, make?.risk, list?.risk]).toEqual(['read', 'draft-write', 'read'])
    expect(() => check?.validate({ start_at: 'bad', time_zone: 'UTC' })).toThrow('ISO 8601')
    expect(() => make?.validate({ start_at: '2030-01-07T10:00:00Z', time_zone: 'Nope/Nowhere' })).toThrow('IANA')
  })

  it('checks availability and emits bounded model text', async () => {
    const check = tools()[0]!
    const args = check.validate({ start_at: '2030-01-07T15:00:00Z', time_zone: 'UTC' })
    const result = await check.execute(context, args)
    expect(check.toModelText(result)).toContain('is available')
    expect(check.toModelText(result).length).toBeLessThan(1000)
  })

  it('creates a tentative appointment using peer and campaign from the call and stays idempotent', async () => {
    const make = tools()[1]!
    const args = make.validate({
      start_at: '2030-01-07T15:00:00Z', time_zone: 'UTC', duration_min: 30,
      contact_name: 'Jordan', notes: 'First visit'
    })
    const first = await make.execute(context, args)
    const second = await make.execute(context, args)
    expect(make.toModelText(first)).toContain('a confirmation will be sent later')
    expect(second).toMatchObject({ created: true, idempotent: true })
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ peer: '+13125550198', campaignId: 'campaign-1', status: 'tentative' })
  })

  it('returns alternatives without writing when the slot is unavailable', async () => {
    const make = tools()[1]!
    const args = make.validate({ start_at: '2030-01-05T15:00:00Z', time_zone: 'UTC' })
    const result = await make.execute(context, args)
    expect(result).toMatchObject({ created: false })
    expect(make.toModelText(result)).toContain('alternatives')
    expect(store.list()).toHaveLength(0)
  })

  it('lists only this caller future appointments without exposing the phone number', async () => {
    const make = tools()[1]!
    await make.execute(context, make.validate({ start_at: '2030-01-07T15:00:00Z', time_zone: 'UTC' }))
    const list = tools()[2]!
    const result = await list.execute(context, list.validate({}))
    const text = list.toModelText(result)
    expect(text).toContain('Tentative')
    expect(text).not.toContain('13125550198')
  })

  function tools() {
    return createAppointmentTools({ callStore, appointmentStore: store, getCalendar: () => calendar, now: () => 1 })
  }
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
