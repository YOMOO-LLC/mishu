import type { CallDirection, ContactCard, ContactCardSummary } from '../../shared/contracts.js'
import type { CallStore } from '../call-store.js'
import type { CrmContact } from '../crm/client.js'
import type { InCallTool, ToolRegistry } from '../copilot/registry.js'
import type { ContactService } from '../services/contact-service.js'

type ContactLookupResult =
  | { source: 'local'; contact: ContactCard }
  | { source: 'crm'; contact: CrmContact }
  | { source: 'none' }

export function createContactLookupTool(
  contacts: ContactService,
  calls: CallStore,
  registry: ToolRegistry
): InCallTool<Record<string, never>, ContactLookupResult> {
  return {
    id: 'contact_lookup',
    version: 1,
    spec: {
      type: 'function',
      name: 'contact_lookup',
      description: 'Look up the local contact card for the current call number; fall back to the configured CRM if none exists locally.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    risk: 'read',
    timeoutMs: 10_000,
    validate(value) {
      if (value === undefined) return {}
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).length > 0) {
        throw new Error('contact_lookup does not accept arguments')
      }
      return {}
    },
    async execute(ctx) {
      const call = calls.getCall(ctx.callSessionId)
      if (!call) throw new Error('Call session not found')
      const local = contacts.find(call.peer)
      if (local) return { source: 'local', contact: local }
      const fallback = registry.resolve('crm_lookup_customer')
      if (!fallback) return { source: 'none' }
      const contact = await fallback.execute(ctx, fallback.validate({ phone: call.peer })) as CrmContact | undefined
      return contact ? { source: 'crm', contact } : { source: 'none' }
    },
    toModelText(result) {
      if (result.source === 'none') return 'No background.'
      if (result.source === 'crm') return crmContactText(result.contact)
      return contactCardText(result.contact)
    }
  }
}

export function contactCardText(card: ContactCard | ContactCardSummary): string {
  return [
    card.displayName ? `Name: ${card.displayName}` : undefined,
    card.company ? `Company: ${card.company}` : undefined,
    card.tier ? `Tier: ${card.tier}` : undefined,
    card.language ? `Language: ${card.language}` : undefined,
    card.notes ? `Latest notes: ${summarizeNotes(card.notes)}` : undefined
  ].filter(Boolean).join('; ') || 'No background.'
}

export function openingContactText(direction: CallDirection, card: ContactCard | ContactCardSummary): string {
  return `${direction === 'inbound' ? 'Caller' : 'Callee'} background: ${contactCardText(card)}`
}

function crmContactText(contact: CrmContact): string {
  return [
    contact.name ? `Name: ${contact.name}` : undefined,
    contact.tier ? `Tier: ${contact.tier}` : undefined
  ].filter(Boolean).join('; ') || 'No background.'
}

function summarizeNotes(notes: string): string {
  const normalized = notes.replace(/\s+/g, ' ').trim()
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized
}
