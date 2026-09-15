import type {
  CrmClient,
  CrmContact,
  CrmCreateEventInput,
  CrmCreateLeadInput,
  CrmRecordRef
} from './client.js'
import { normalizeCrmPhone } from './client.js'

export interface MockCrmNote {
  recordRef: CrmRecordRef
  text: string
}

export interface MockCrmEvent extends CrmCreateEventInput {}

const SEED_CONTACTS: CrmContact[] = [
  {
    name: 'Alex Lin',
    phone: '+1 415 555 0142',
    tier: 'Gold customer',
    city: 'San Francisco',
    lastInteractionAt: '2026-08-20T09:30:00-07:00',
    recordRef: { module: 'Contacts', id: 'mock-contact-1' }
  },
  {
    name: 'Maya Chen',
    phone: '+1 773 555 0100',
    tier: 'Prospect',
    city: 'Chicago',
    lastInteractionAt: '2026-08-28T14:00:00-05:00',
    recordRef: { module: 'Leads', id: 'mock-lead-1' }
  },
  {
    name: 'Min Wang',
    phone: '+86 138 0013 8000',
    tier: 'Standard customer',
    city: 'Shanghai',
    lastInteractionAt: '2026-09-01T10:15:00+08:00',
    recordRef: { module: 'Contacts', id: 'mock-contact-2' }
  }
]

export class MockCrmAdapter implements CrmClient {
  private readonly contacts = new Map<string, CrmContact>()
  private readonly notes: MockCrmNote[] = []
  private readonly events: MockCrmEvent[] = []
  private sequence = 0

  constructor(seed: CrmContact[] = SEED_CONTACTS) {
    for (const contact of seed) {
      this.contacts.set(normalizeCrmPhone(contact.phone), structuredClone(contact))
    }
  }

  async lookupByPhone(e164: string): Promise<CrmContact | undefined> {
    const contact = this.contacts.get(normalizeCrmPhone(e164))
    return contact ? structuredClone(contact) : undefined
  }

  async createLead(input: CrmCreateLeadInput): Promise<{ id: string }> {
    const phone = normalizeCrmPhone(input.phone)
    const existing = this.contacts.get(phone)
    if (existing) return { id: existing.recordRef.id }
    const id = `mock-created-lead-${++this.sequence}`
    this.contacts.set(phone, {
      name: [input.firstName, input.lastName].filter(Boolean).join(' '),
      phone,
      tier: 'New lead',
      recordRef: { module: 'Leads', id }
    })
    return { id }
  }

  async addNote(recordRef: CrmRecordRef, text: string): Promise<void> {
    this.requireRecord(recordRef)
    this.notes.push({ recordRef: structuredClone(recordRef), text })
  }

  async createEvent(input: CrmCreateEventInput): Promise<void> {
    this.requireRecord(input.recordRef)
    this.events.push(structuredClone(input))
  }

  async testConnection(): Promise<void> {}

  listContacts(): CrmContact[] {
    return [...this.contacts.values()].map((contact) => structuredClone(contact))
  }

  listNotes(): MockCrmNote[] {
    return structuredClone(this.notes)
  }

  listEvents(): MockCrmEvent[] {
    return structuredClone(this.events)
  }

  private requireRecord(recordRef: CrmRecordRef): void {
    const exists = [...this.contacts.values()].some(
      (contact) => contact.recordRef.module === recordRef.module && contact.recordRef.id === recordRef.id
    )
    if (!exists) throw new Error('Mock CRM record does not exist')
  }
}
