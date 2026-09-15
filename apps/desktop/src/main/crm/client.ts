export type CrmRecordModule = 'Contacts' | 'Leads'

export interface CrmRecordRef {
  module: CrmRecordModule
  id: string
}

export interface CrmContact {
  name: string
  phone: string
  tier?: string
  city?: string
  lastInteractionAt?: string
  recordRef: CrmRecordRef
}

export interface CrmCreateLeadInput {
  lastName: string
  firstName?: string
  company?: string
  phone: string
  email?: string
  description?: string
}

export interface CrmCreateEventInput {
  title: string
  startAt: string
  endAt: string
  timeZone: string
  recordRef: CrmRecordRef
}

export interface CrmClient {
  lookupByPhone(e164: string): Promise<CrmContact | undefined>
  createLead(input: CrmCreateLeadInput): Promise<{ id: string }>
  addNote(recordRef: CrmRecordRef, text: string): Promise<void>
  createEvent(input: CrmCreateEventInput): Promise<void>
  testConnection(): Promise<void>
}

export function normalizeCrmPhone(value: string): string {
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) throw new Error('Phone number cannot be empty')
  return `+${digits}`
}
