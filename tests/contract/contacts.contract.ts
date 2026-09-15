import { describe, expect, it } from 'vitest'
import { api, apiOk, fakeE164, uniqueKey } from './helpers/http.js'
import { assertNoSecretLeaks } from './helpers/secrets.js'

interface Contact {
  phone: string
  displayName?: string
  company?: string
  source: string
  facts: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

describe('contacts CRUD (ADR-0001 I4, I9)', () => {
  it('I9: create, read, update, list with pagination, and delete contacts', async () => {
    const phones = [fakeE164(), fakeE164(), fakeE164()]
    const created = await apiOk<Contact>(`/contacts/${encodeURIComponent(phones[0] as string)}`, {
      method: 'PUT',
      idempotencyKey: uniqueKey('contact-put'),
      body: JSON.stringify({ displayName: 'Ada', company: 'Analytical Engines', facts: { segment: 'pilot' } })
    })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ displayName: 'Ada', company: 'Analytical Engines' })
    expect(typeof created.body.createdAt).toBe('number')

    const batch = await apiOk<{ contacts: Contact[] }>('/contacts:batch', {
      method: 'POST',
      body: JSON.stringify(phones.slice(1).map((phone, index) => ({
        phone,
        displayName: `Contact ${index + 2}`
      })))
    })
    expect(batch.body.contacts).toHaveLength(2)

    const got = await apiOk<Contact>(`/contacts/${encodeURIComponent(phones[0] as string)}`)
    expect(got.body.displayName).toBe('Ada')

    const updated = await apiOk<Contact>(`/contacts/${encodeURIComponent(phones[0] as string)}`, {
      method: 'PUT',
      body: JSON.stringify({ displayName: 'Ada Lovelace', company: 'Analytical Engines' })
    })
    expect(updated.body.displayName).toBe('Ada Lovelace')

    const page1 = await apiOk<{ contacts: Contact[] }>('/contacts?limit=1&offset=0')
    expect(page1.body.contacts).toHaveLength(1)
    expect(page1.body.contacts[0]?.phone).toContain('*')
    expect(page1.body.contacts[0]?.phone).not.toMatch(/^\+[1-9]\d{7,14}$/)

    const page2 = await apiOk<{ contacts: Contact[] }>('/contacts?limit=1&offset=1')
    expect(page2.body.contacts).toHaveLength(1)
    expect(page2.body.contacts[0]?.phone).not.toBe(page1.body.contacts[0]?.phone)

    assertNoSecretLeaks(page1.body, 'contact-list')

    const deleted = await apiOk<{ deleted: true; phone: string }>(
      `/contacts/${encodeURIComponent(phones[0] as string)}`,
      { method: 'DELETE' }
    )
    expect(deleted.body.deleted).toBe(true)
    const missing = await api(`/contacts/${encodeURIComponent(phones[0] as string)}`)
    expect(missing.status).toBe(404)
  })
})
