import type {
  ContactCard,
  ContactCardInput,
  ContactCardSummary,
  ListContactCardsRequest
} from '../../shared/contracts.js'
import { maskPhoneNumber } from '../../shared/phone-mask.js'
import type { CallStore } from '../call-store.js'
import { ServiceError } from './service-error.js'

const E164 = /^\+[1-9]\d{7,14}$/
const MAX_FACTS_JSON = 4_000

export class ContactService {
  constructor(
    private readonly store: CallStore,
    private readonly now: () => number = Date.now
  ) {}

  upsert(input: ContactCardInput): ContactCard {
    return this.store.putContactCard(this.normalize(input))
  }

  upsertMany(inputs: ContactCardInput[]): ContactCard[] {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 100) {
      throw new ServiceError('INVALID_ARGUMENT', 'contacts must contain from 1 to 100 cards')
    }
    const normalized = inputs.map((input) => this.normalize(input))
    return normalized.map((card) => this.store.putContactCard(card))
  }

  find(phone: unknown): ContactCard | undefined {
    const normalized = normalizePhone(phone)
    const card = this.store.getContactCard(normalized)
    if (!card || (card.expiresAt !== undefined && card.expiresAt <= this.now())) return undefined
    return card
  }

  get(phone: unknown): ContactCard {
    const card = this.find(phone)
    if (!card) throw new ServiceError('NOT_FOUND', 'Contact card not found')
    return card
  }

  list(request: ListContactCardsRequest = {}): ContactCard[] {
    return this.store.listContactCards(request, this.now()).map((card) => ({
      ...card,
      phone: maskPhoneNumber(card.phone)
    }))
  }

  delete(phone: unknown): { deleted: true; phone: string } {
    const normalized = normalizePhone(phone)
    if (!this.store.deleteContactCard(normalized)) throw new ServiceError('NOT_FOUND', 'Contact card not found')
    return { deleted: true, phone: normalized }
  }

  snapshotForCall(callId: string, phone: unknown): ContactCardSummary | undefined {
    const card = this.find(phone)
    if (!card) return undefined
    const summary = contactCardSummary(card)
    this.store.attachContactCard(callId, summary)
    return summary
  }

  private normalize(input: ContactCardInput): ContactCard {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ServiceError('INVALID_ARGUMENT', 'Contact card input is required')
    }
    const phone = normalizePhone(input.phone)
    const existing = this.store.getContactCard(phone)
    const facts = input.facts === undefined ? existing?.facts ?? {} : normalizeFacts(input.facts)
    const factsJson = JSON.stringify(facts)
    if (factsJson.length > MAX_FACTS_JSON) {
      throw new ServiceError('UNPROCESSABLE_ENTITY', 'facts JSON must be at most 4000 characters')
    }
    const expiresAt = input.expiresAt === undefined
      ? existing?.expiresAt
      : normalizeExpiresAt(input.expiresAt)
    const now = this.now()
    return {
      phone,
      ...mergedString('displayName', input.displayName, existing?.displayName, 200),
      ...mergedString('company', input.company, existing?.company, 200),
      ...mergedString('tier', input.tier, existing?.tier, 100),
      ...mergedString('language', input.language, existing?.language, 80),
      ...mergedTimeZone(input.timeZone, existing?.timeZone),
      ...mergedString('notes', input.notes, existing?.notes, 2_000),
      facts,
      source: normalizeRequiredString(input.source ?? existing?.source ?? 'agent', 'source', 120),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
  }
}

export function normalizePhone(value: unknown): string {
  if (typeof value !== 'string') throw new ServiceError('INVALID_NUMBER', 'phone must be an E.164 phone number')
  const normalized = value.replace(/[\s().-]/g, '')
  if (!E164.test(normalized)) throw new ServiceError('INVALID_NUMBER', 'phone must be an E.164 phone number')
  return normalized
}

export function contactCardSummary(card: ContactCard): ContactCardSummary {
  return {
    ...(card.displayName ? { displayName: card.displayName } : {}),
    ...(card.company ? { company: card.company } : {}),
    ...(card.tier ? { tier: card.tier } : {}),
    ...(card.language ? { language: card.language } : {}),
    ...(card.notes ? { notes: card.notes } : {})
  }
}

function normalizeFacts(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('INVALID_ARGUMENT', 'facts must be an object')
  }
  try {
    JSON.stringify(value)
  } catch {
    throw new ServiceError('INVALID_ARGUMENT', 'facts must be JSON serializable')
  }
  return value as Record<string, unknown>
}

function normalizeExpiresAt(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ServiceError('INVALID_ARGUMENT', 'expiresAt must be a timestamp or ISO date-time')
  }
  return Math.floor(parsed)
}

function mergedString<Key extends 'displayName' | 'company' | 'tier' | 'language' | 'notes'>(
  key: Key,
  value: unknown,
  fallback: string | undefined,
  max: number
): Partial<Record<Key, string>> {
  if (value === undefined) return fallback ? { [key]: fallback } as Partial<Record<Key, string>> : {}
  if (typeof value !== 'string') throw new ServiceError('INVALID_ARGUMENT', `${key} must be a string`)
  const normalized = value.trim()
  if (normalized.length > max) throw new ServiceError('UNPROCESSABLE_ENTITY', `${key} must be at most ${max} characters`)
  return normalized ? { [key]: normalized } as Partial<Record<Key, string>> : {}
}

function mergedTimeZone(value: unknown, fallback: string | undefined): { timeZone?: string } {
  if (value !== undefined && typeof value !== 'string') {
    throw new ServiceError('INVALID_ARGUMENT', 'timeZone must be a string')
  }
  const result = typeof value === 'string' ? value.trim() : fallback
  if (result && result.length > 100) {
    throw new ServiceError('UNPROCESSABLE_ENTITY', 'timeZone must be at most 100 characters')
  }
  if (!result) return {}
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: result }).format()
  } catch {
    throw new ServiceError('INVALID_ARGUMENT', 'timeZone must be a valid IANA time zone')
  }
  return { timeZone: result }
}

function normalizeRequiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ServiceError('INVALID_ARGUMENT', `${field} is required`)
  const normalized = value.trim()
  if (normalized.length > max) throw new ServiceError('UNPROCESSABLE_ENTITY', `${field} must be at most ${max} characters`)
  return normalized
}
