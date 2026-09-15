import type {
  CrmClient,
  CrmContact,
  CrmCreateEventInput,
  CrmCreateLeadInput,
  CrmRecordModule,
  CrmRecordRef
} from '../client.js'
import { normalizeCrmPhone } from '../client.js'
import { ZohoSelfClientAuth } from './auth.js'
import { eventBody, leadBody, noteBody, parseContact, type ZohoRecord } from './models.js'
import type { ZohoSecrets } from './secrets.js'

const MAX_ATTEMPTS = 3

interface ZohoDataResponse {
  data?: unknown
}

export interface ZohoCrmClientOptions {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export class ZohoCrmClient implements CrmClient {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly auth: ZohoSelfClientAuth

  constructor(secrets: ZohoSecrets, options: ZohoCrmClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.auth = new ZohoSelfClientAuth(secrets, { fetch: this.fetchImpl, now: options.now })
  }

  async lookupByPhone(e164: string): Promise<CrmContact | undefined> {
    const phone = normalizeCrmPhone(e164)
    for (const module of ['Contacts', 'Leads'] as const) {
      const response = await this.request(
        `/crm/v8/${module}/search?phone=${encodeURIComponent(phone)}`,
        { method: 'GET' },
        true
      )
      if (response.status === 204) continue
      const payload = await response.json() as ZohoDataResponse
      const records = Array.isArray(payload.data) ? payload.data as ZohoRecord[] : []
      const exact = records
        .map((record) => parseContact(record, module))
        .find((contact) => contact && normalizeCrmPhone(contact.phone) === phone)
      if (exact) return exact
    }
    return undefined
  }

  async createLead(input: CrmCreateLeadInput): Promise<{ id: string }> {
    const response = await this.request('/crm/v8/Leads/upsert', {
      method: 'POST',
      body: JSON.stringify(leadBody(input))
    })
    return { id: await responseId(response, 'Lead') }
  }

  async addNote(recordRef: CrmRecordRef, text: string): Promise<void> {
    await this.request(`/crm/v8/${recordPath(recordRef)}/Notes`, {
      method: 'POST',
      body: JSON.stringify(noteBody(text))
    })
  }

  async createEvent(input: CrmCreateEventInput): Promise<void> {
    await this.request('/crm/v8/Events', {
      method: 'POST',
      body: JSON.stringify(eventBody(input))
    })
  }

  async testConnection(): Promise<void> {
    await this.request('/crm/v8/org', { method: 'GET' })
  }

  private async request(path: string, init: RequestInit, allowNoContent = false): Promise<Response> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const token = await this.auth.accessToken()
      const response = await this.fetchImpl(`${token.apiDomain}${path}`, {
        ...init,
        headers: {
          authorization: `Zoho-oauthtoken ${token.value}`,
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...headersToObject(init.headers)
        }
      })
      if (response.ok || (allowNoContent && response.status === 204)) return response
      if ((response.status === 429 || response.status >= 500) && attempt + 1 < MAX_ATTEMPTS) {
        await this.sleep(250 * (2 ** attempt))
        continue
      }
      throw new Error(`Zoho CRM request failed (HTTP ${response.status})`)
    }
    throw new Error('Zoho CRM request retries exhausted')
  }
}

function recordPath(recordRef: CrmRecordRef): string {
  if (!(['Contacts', 'Leads'] as CrmRecordModule[]).includes(recordRef.module)) {
    throw new Error('CRM record module is invalid')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(recordRef.id)) throw new Error('CRM record ID is invalid')
  return `${recordRef.module}/${encodeURIComponent(recordRef.id)}`
}

async function responseId(response: Response, label: string): Promise<string> {
  const payload = await response.json() as {
    data?: Array<{ details?: { id?: unknown }; status?: unknown; message?: unknown }>
  }
  const first = payload.data?.[0]
  const id = first?.details?.id
  if (typeof id !== 'string' || !id) {
    throw new Error(`Zoho did not return ${label} ID`)
  }
  return id
}

function headersToObject(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(new Headers(headers).entries())
}
