import type {
  CrmContact,
  CrmCreateEventInput,
  CrmCreateLeadInput,
  CrmRecordModule
} from '../client.js'
import { normalizeCrmPhone } from '../client.js'

export interface ZohoRecord {
  id?: unknown
  Full_Name?: unknown
  First_Name?: unknown
  Last_Name?: unknown
  Phone?: unknown
  Mobile?: unknown
  Rating?: unknown
  Lead_Status?: unknown
  Mailing_City?: unknown
  City?: unknown
  Modified_Time?: unknown
}

export function parseContact(record: ZohoRecord, module: CrmRecordModule): CrmContact | undefined {
  if (typeof record.id !== 'string' || !record.id) return undefined
  const phone = stringValue(record.Phone) ?? stringValue(record.Mobile)
  if (!phone) return undefined
  const name = stringValue(record.Full_Name)
    ?? ([stringValue(record.First_Name), stringValue(record.Last_Name)].filter(Boolean).join(' ')
      || 'Unnamed customer')
  const tier = stringValue(record.Rating) ?? stringValue(record.Lead_Status)
  const city = stringValue(record.Mailing_City) ?? stringValue(record.City)
  const lastInteractionAt = stringValue(record.Modified_Time)
  return {
    name,
    phone: normalizeCrmPhone(phone),
    ...(tier ? { tier } : {}),
    ...(city ? { city } : {}),
    ...(lastInteractionAt ? { lastInteractionAt } : {}),
    recordRef: { module, id: record.id }
  }
}

export function leadBody(input: CrmCreateLeadInput): Record<string, unknown> {
  return {
    data: [{
      Last_Name: required(input.lastName, 'last name'),
      ...(optional(input.firstName) ? { First_Name: optional(input.firstName) } : {}),
      ...(optional(input.company) ? { Company: optional(input.company) } : {}),
      Phone: normalizeCrmPhone(input.phone),
      ...(optional(input.email) ? { Email: optional(input.email) } : {}),
      ...(optional(input.description) ? { Description: optional(input.description) } : {}),
      Lead_Source: 'Cold Call'
    }],
    duplicate_check_fields: ['Email']
  }
}

export function noteBody(text: string): Record<string, unknown> {
  return { data: [{ Note_Title: 'Call record', Note_Content: required(text, 'note text') }] }
}

export function eventBody(input: CrmCreateEventInput): Record<string, unknown> {
  validateIsoDateTime(input.startAt, 'start time')
  validateIsoDateTime(input.endAt, 'end time')
  if (!input.timeZone.trim()) throw new Error('Time zone cannot be empty')
  return {
    data: [{
      Event_Title: required(input.title, 'event title'),
      Start_DateTime: input.startAt,
      End_DateTime: input.endAt,
      Who_Id: { id: input.recordRef.id },
      $se_module: input.recordRef.module,
      Remind_At: [{ unit: 15, period: 'minutes' }]
    }]
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} cannot be empty`)
  return normalized
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function validateIsoDateTime(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label} must be an ISO 8601 datetime with a timezone`)
  }
}
