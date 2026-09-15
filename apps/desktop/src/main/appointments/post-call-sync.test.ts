import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallStore } from '../call-store.js'
import { WebhookBridge } from '../webhook/bridge.js'
import { WebhookConfigStore } from '../webhook/config-store.js'
import type { CalendarAdapter } from './calendar-adapter.js'
import { MockCalendarAdapter } from './mock-calendar.js'
import { AppointmentPostCallSync } from './post-call-sync.js'
import { AppointmentStore } from './store.js'

describe('AppointmentPostCallSync', () => {
  let directory: string
  let callStore: CallStore
  let appointmentStore: AppointmentStore
  let webhookBridge: WebhookBridge
  let sync: AppointmentPostCallSync
  let calendar: CalendarAdapter

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'appointment-post-call-'))
    callStore = new CallStore(join(directory, 'calls.sqlite3'))
    appointmentStore = new AppointmentStore(callStore)
    const webhookConfig = new WebhookConfigStore(join(directory, 'webhooks'))
    webhookConfig.save({
      url: 'http://127.0.0.1:9/hook', secret: 'secret', enabled: true,
      events: ['appointment.created', 'appointment.confirmed', 'appointment.failed']
    })
    webhookBridge = new WebhookBridge({ store: callStore, configStore: webhookConfig })
    calendar = new MockCalendarAdapter()
  })

  afterEach(() => {
    sync?.dispose()
    webhookBridge.close()
    callStore.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('leaves tentative appointments local and emits appointment.created when auto confirm is off', async () => {
    sync = createSync(false)
    report('active')
    const appointment = createAppointment()
    report('ended')
    await tick()

    expect(appointmentStore.get(appointment.id)?.status).toBe('tentative')
    expect(sync.list()).toHaveLength(0)
    expect(webhookBridge.outbox.list(10).map((row) => row.eventType)).toContain('appointment.created')
  })

  it('confirms an appointment in the calendar and writes audit and webhook records', async () => {
    sync = createSync(true)
    report('active')
    const appointment = createAppointment()
    report('ended')
    await waitFor('succeeded')

    expect(appointmentStore.get(appointment.id)).toMatchObject({ status: 'confirmed', externalRef: expect.stringContaining('mock-calendar-') })
    expect(callStore.listAudit({ limit: 20 }).map((entry) => entry.action)).toContain('appointment.confirmed')
    expect(webhookBridge.outbox.list(10).map((row) => row.eventType)).toContain('appointment.confirmed')
  })

  it('marks failures and retries the same appointment with backoff', async () => {
    calendar = new FailingCalendar()
    sync = createSync(true, () => 100)
    report('active')
    const appointment = createAppointment()
    report('ended')
    await waitFor('failed')

    expect(appointmentStore.get(appointment.id)?.status).toBe('failed')
    expect(sync.list()[0]).toMatchObject({ attempts: 1, nextAttemptAt: 1100, lastError: 'calendar unavailable' })
    expect(webhookBridge.outbox.list(10).map((row) => row.eventType)).toContain('appointment.failed')

    calendar = new MockCalendarAdapter()
    await sync.processDue(1100)
    expect(sync.list()[0]?.status).toBe('succeeded')
    expect(appointmentStore.get(appointment.id)?.status).toBe('confirmed')
  })

  function createSync(autoConfirm: boolean, now: () => number = Date.now): AppointmentPostCallSync {
    return new AppointmentPostCallSync({
      callStore, appointmentStore, getCalendar: () => calendar,
      isAutoConfirm: () => autoConfirm, webhookBridge, now
    })
  }

  function report(status: 'active' | 'ended'): void {
    callStore.report({
      call: { id: 'call-1', direction: 'inbound', peer: '+13125550198', status },
      runtimeMode: 'mock', endReason: status === 'ended' ? 'hangup' : undefined,
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

  function createAppointment() {
    return appointmentStore.create({
      callId: 'call-1', campaignId: 'campaign-1', peer: '+13125550198',
      startAt: '2030-01-07T15:00:00Z', endAt: '2030-01-07T15:30:00Z',
      timeZone: 'UTC', source: 'copilot'
    })
  }

  async function waitFor(status: string): Promise<void> {
    const started = Date.now()
    while (sync.list()[0]?.status !== status) {
      if (Date.now() - started > 2_000) throw new Error(`Timed out waiting for ${status}`)
      await tick()
    }
  }
})

class FailingCalendar implements CalendarAdapter {
  readonly name = 'failing'
  async checkSlot() { return { available: true, alternatives: [] } }
  async createEvent(): Promise<never> { throw new Error('calendar unavailable') }
  async cancelEvent(): Promise<void> {}
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}
