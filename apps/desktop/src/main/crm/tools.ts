import type { InCallTool } from '../copilot/registry.js'
import type { CrmClient, CrmContact, CrmCreateLeadInput } from './client.js'

type ClientSource = () => CrmClient

interface LookupArgs { phone: string }
interface CreateLeadArgs extends CrmCreateLeadInput {}
interface NoteArgs { phone: string; text: string }
interface EventArgs { phone: string; title: string; startAt: string; endAt: string; timeZone: string }

export function createCrmTools(getClient: ClientSource): InCallTool[] {
  const lookup: InCallTool<LookupArgs, CrmContact | undefined> = {
    id: 'crm_lookup_customer',
    version: 1,
    spec: {
      type: 'function',
      name: 'crm_lookup_customer',
      description: 'Look up a brief CRM customer profile by phone number.',
      inputSchema: objectSchema({ phone: { type: 'string', description: 'E.164 phone number' } }, ['phone'])
    },
    risk: 'read',
    timeoutMs: 10_000,
    validate(args) {
      const value = objectValue(args)
      return { phone: requiredString(value.phone, 'phone') }
    },
    execute(_ctx, args) {
      return getClient().lookupByPhone(args.phone)
    },
    toModelText(contact) {
      if (!contact) return 'No CRM customer found.'
      return [
        `Customer: ${contact.name}`,
        contact.tier ? `Tier: ${contact.tier}` : undefined,
        contact.city ? `City: ${contact.city}` : undefined,
        contact.lastInteractionAt ? `Last interaction: ${contact.lastInteractionAt}` : undefined
      ].filter(Boolean).join('; ')
    }
  }

  const createLead: InCallTool<CreateLeadArgs, { id: string }> = {
    id: 'crm_create_lead',
    version: 1,
    spec: {
      type: 'function',
      name: 'crm_create_lead',
      description: 'Create a CRM Lead draft record.',
      inputSchema: objectSchema({
        lastName: { type: 'string' },
        firstName: { type: 'string' },
        company: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        description: { type: 'string' }
      }, ['lastName', 'phone'])
    },
    risk: 'draft-write',
    timeoutMs: 10_000,
    validate(args) {
      const value = objectValue(args)
      return {
        lastName: requiredString(value.lastName, 'lastName'),
        phone: requiredString(value.phone, 'phone'),
        ...optionalFields(value, ['firstName', 'company', 'email', 'description'])
      }
    },
    execute(_ctx, args) {
      return getClient().createLead(args)
    },
    toModelText() {
      return 'CRM lead created.'
    }
  }

  const addNote: InCallTool<NoteArgs, void> = {
    id: 'crm_add_note',
    version: 1,
    spec: {
      type: 'function',
      name: 'crm_add_note',
      description: 'Find the customer by phone number and append a CRM note.',
      inputSchema: objectSchema({ phone: { type: 'string' }, text: { type: 'string' } }, ['phone', 'text'])
    },
    risk: 'draft-write',
    timeoutMs: 10_000,
    validate(args) {
      const value = objectValue(args)
      return {
        phone: requiredString(value.phone, 'phone'),
        text: requiredString(value.text, 'text', 4_000)
      }
    },
    async execute(_ctx, args) {
      const contact = await getClient().lookupByPhone(args.phone)
      if (!contact) throw new Error('No CRM customer found to append a note to')
      await getClient().addNote(contact.recordRef, args.text)
    },
    toModelText() {
      return 'CRM note added.'
    }
  }

  const createEvent: InCallTool<EventArgs, void> = {
    id: 'crm_create_event',
    version: 1,
    spec: {
      type: 'function',
      name: 'crm_create_event',
      description: 'Create a CRM calendar event for the customer matching this phone number; this writes to an external system.',
      inputSchema: objectSchema({
        phone: { type: 'string' },
        title: { type: 'string' },
        startAt: { type: 'string' },
        endAt: { type: 'string' },
        timeZone: { type: 'string' }
      }, ['phone', 'title', 'startAt', 'endAt', 'timeZone'])
    },
    risk: 'external-write',
    timeoutMs: 10_000,
    validate(args) {
      const value = objectValue(args)
      return {
        phone: requiredString(value.phone, 'phone'),
        title: requiredString(value.title, 'title'),
        startAt: requiredString(value.startAt, 'startAt'),
        endAt: requiredString(value.endAt, 'endAt'),
        timeZone: requiredString(value.timeZone, 'timeZone')
      }
    },
    async execute(_ctx, args) {
      const contact = await getClient().lookupByPhone(args.phone)
      if (!contact) throw new Error('No CRM customer found to create an event for')
      await getClient().createEvent({ ...args, recordRef: contact.recordRef })
    },
    toModelText() {
      return 'CRM event created.'
    }
  }

  return [lookup, createLead, addNote, createEvent]
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CRM tool arguments are invalid')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} cannot be empty`)
  return value.trim().slice(0, max)
}

function optionalFields(
  value: Record<string, unknown>,
  names: Array<'firstName' | 'company' | 'email' | 'description'>
): Partial<CreateLeadArgs> {
  const result: Record<string, string> = {}
  for (const name of names) {
    if (typeof value[name] === 'string' && value[name].trim()) result[name] = value[name].trim()
  }
  return result
}
