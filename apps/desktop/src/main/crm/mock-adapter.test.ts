import { describe, expect, it } from 'vitest'
import { MockCrmAdapter } from './mock-adapter'

describe('MockCrmAdapter', () => {
  it('normalizes formatted phone numbers when looking up deterministic seed customers', async () => {
    const adapter = new MockCrmAdapter()

    const contact = await adapter.lookupByPhone('+14155550142')

    expect(contact).toMatchObject({
      name: 'Alex Lin',
      city: 'San Francisco',
      recordRef: { module: 'Contacts', id: 'mock-contact-1' }
    })
    expect(adapter.listContacts()).toHaveLength(3)
  })

  it('stores new leads, notes, and events in memory', async () => {
    const adapter = new MockCrmAdapter()
    const lead = await adapter.createLead({
      firstName: 'Test',
      lastName: 'Caller',
      phone: '+1 (202) 555-0123'
    })
    const recordRef = { module: 'Leads' as const, id: lead.id }

    await adapter.addNote(recordRef, 'Follow up tomorrow')
    await adapter.createEvent({
      title: 'Demo',
      startAt: '2026-09-10T10:00:00-05:00',
      endAt: '2026-09-10T10:30:00-05:00',
      timeZone: 'America/Chicago',
      recordRef
    })

    expect(await adapter.lookupByPhone('+12025550123')).toMatchObject({
      name: 'Test Caller',
      recordRef
    })
    expect(adapter.listNotes()).toEqual([{ recordRef, text: 'Follow up tomorrow' }])
    expect(adapter.listEvents()[0]).toMatchObject({ title: 'Demo', recordRef })
  })
})
