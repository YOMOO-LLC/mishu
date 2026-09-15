import { describe, expect, it, vi } from 'vitest'
import { ZohoCrmClient } from './client'

const secrets = {
  clientId: 'client',
  clientSecret: 'secret',
  refreshToken: 'refresh',
  dataCenter: 'com' as const
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({
    access_token: 'access',
    expires_in: 3600,
    api_domain: 'https://www.zohoapis.com'
  }), { status: 200 })
}

describe('ZohoCrmClient', () => {
  it('searches Contacts by phone and parses an app-owned customer shape', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{
        id: 'contact-1',
        Full_Name: 'Maya Chen',
        Phone: '+1 415 555 0142',
        Rating: 'Gold',
        Mailing_City: 'San Francisco',
        Modified_Time: '2026-09-01T12:00:00-07:00',
        Email: 'private@example.com'
      }] }), { status: 200 }))
    const client = new ZohoCrmClient(secrets, { fetch })

    const contact = await client.lookupByPhone('+14155550142')

    expect(String(fetch.mock.calls[1]?.[0])).toContain('/crm/v8/Contacts/search?phone=%2B14155550142')
    expect(contact).toEqual({
      name: 'Maya Chen',
      phone: '+14155550142',
      tier: 'Gold',
      city: 'San Francisco',
      lastInteractionAt: '2026-09-01T12:00:00-07:00',
      recordRef: { module: 'Contacts', id: 'contact-1' }
    })
    expect(JSON.stringify(contact)).not.toContain('private@example.com')
  })

  it('retries HTTP 429 with exponential backoff up to success', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ org: [{}] }), { status: 200 }))
    const sleep = vi.fn(async () => undefined)
    const client = new ZohoCrmClient(secrets, { fetch, sleep })

    await client.testConnection()

    expect(sleep.mock.calls).toEqual([[250], [500]])
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('sends the documented Lead upsert request shape', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ status: 'success', details: { id: 'lead-1' } }]
      }), { status: 200 }))
    const client = new ZohoCrmClient(secrets, { fetch })

    await expect(client.createLead({
      firstName: 'Maya',
      lastName: 'Chen',
      company: 'Example Co',
      phone: '+1 415 555 0142',
      email: 'maya@example.com',
      description: 'Requested a demo'
    })).resolves.toEqual({ id: 'lead-1' })

    expect(fetch.mock.calls[1]?.[0]).toBe('https://www.zohoapis.com/crm/v8/Leads/upsert')
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      data: [{
        Last_Name: 'Chen',
        First_Name: 'Maya',
        Company: 'Example Co',
        Phone: '+14155550142',
        Email: 'maya@example.com',
        Description: 'Requested a demo',
        Lead_Source: 'Cold Call'
      }],
      duplicate_check_fields: ['Email']
    })
  })

  it('uses related Notes and Events v8 request shapes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 201 }))
    const client = new ZohoCrmClient(secrets, { fetch })
    const recordRef = { module: 'Contacts' as const, id: 'contact-1' }

    await client.addNote(recordRef, 'Call summary')
    await client.createEvent({
      title: 'Product demo',
      startAt: '2026-09-10T10:00:00-05:00',
      endAt: '2026-09-10T10:30:00-05:00',
      timeZone: 'America/Chicago',
      recordRef
    })

    expect(fetch.mock.calls[1]?.[0]).toBe('https://www.zohoapis.com/crm/v8/Contacts/contact-1/Notes')
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      data: [{ Note_Title: 'Call record', Note_Content: 'Call summary' }]
    })
    expect(fetch.mock.calls[2]?.[0]).toBe('https://www.zohoapis.com/crm/v8/Events')
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      data: [{
        Event_Title: 'Product demo',
        Start_DateTime: '2026-09-10T10:00:00-05:00',
        End_DateTime: '2026-09-10T10:30:00-05:00',
        Who_Id: { id: 'contact-1' },
        $se_module: 'Contacts',
        Remind_At: [{ unit: 15, period: 'minutes' }]
      }]
    })
  })
})
