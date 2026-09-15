import { describe, expect, it } from 'vitest'
import type { Appointment } from '../../shared/contracts.js'
import { MockCalendarAdapter } from './mock-calendar.js'

const config = () => ({
  businessHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  timeZone: 'UTC'
})

describe('MockCalendarAdapter', () => {
  it('accepts slots inside weekday business hours and rejects outside hours', async () => {
    const calendar = new MockCalendarAdapter(config)
    await expect(calendar.checkSlot(slot('2030-01-07T09:00:00Z'))).resolves.toMatchObject({ available: true })
    await expect(calendar.checkSlot(slot('2030-01-07T18:00:00Z'))).resolves.toMatchObject({ available: false })
    await expect(calendar.checkSlot(slot('2030-01-05T10:00:00Z'))).resolves.toMatchObject({ available: false })
  })

  it('detects conflicts and returns the nearest two available alternatives', async () => {
    const calendar = new MockCalendarAdapter(config)
    await calendar.createEvent(appointment('2030-01-07T15:00:00Z'))
    const result = await calendar.checkSlot(slot('2030-01-07T15:00:00Z'))
    expect(result.available).toBe(false)
    expect(result.alternatives).toEqual([
      { startAt: '2030-01-07T15:30:00.000Z', endAt: '2030-01-07T16:00:00.000Z' },
      { startAt: '2030-01-07T16:00:00.000Z', endAt: '2030-01-07T16:30:00.000Z' }
    ])
  })

  it('frees occupied time when an event is cancelled', async () => {
    const calendar = new MockCalendarAdapter(config)
    const event = await calendar.createEvent(appointment('2030-01-07T15:00:00Z'))
    await calendar.cancelEvent(event.externalRef)
    await expect(calendar.checkSlot(slot('2030-01-07T15:00:00Z'))).resolves.toMatchObject({ available: true })
  })
})

function slot(startAt: string) {
  return { startAt, endAt: new Date(Date.parse(startAt) + 30 * 60_000).toISOString(), timeZone: 'UTC' }
}

function appointment(startAt: string): Appointment {
  return {
    id: 'appointment-1', callId: 'call-1', campaignId: 'campaign-1', peer: '+13125550198',
    startAt, endAt: new Date(Date.parse(startAt) + 30 * 60_000).toISOString(), timeZone: 'UTC',
    status: 'tentative', source: 'copilot', createdAt: 1, updatedAt: 1
  }
}
