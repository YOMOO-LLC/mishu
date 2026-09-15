import { describe, expect, it } from 'vitest'
import { api, apiOk, hangupQuietly } from './helpers/http.js'
import { poll } from './helpers/poll.js'
import { assertNoSecretLeaks } from './helpers/secrets.js'

interface CallRecord {
  id: string
  direction: string
  peer: string
  status: string
  voiceProvider?: string
  voiceSeconds?: number
}

describe('calls list/detail (ADR-0001 I4, I9)', () => {
  it('I9: list and detail share a field shape and mask numbers by default', async () => {
    await hangupQuietly()
    const peer = '+15555550142'
    const simulated = await apiOk<{ status: { call?: { status: string } } }>('/debug/simulate-incoming', {
      method: 'POST',
      body: JSON.stringify({ peer })
    })
    expect(simulated.status).toBe(202)
    expect(simulated.body.status.call?.status).toBe('ringing')

    const ringing = await poll(
      async () => (await apiOk<{ calls: CallRecord[] }>('/calls?limit=5&offset=0')).body.calls[0],
      (call) => Boolean(call?.id),
      { timeoutMs: 10_000, label: 'call list after simulate-incoming' }
    )
    expect(ringing.peer).toContain('*')
    expect(ringing.peer).not.toBe(peer)
    expect(ringing).toMatchObject({
      id: expect.any(String),
      direction: 'inbound',
      status: expect.any(String)
    })

    const detail = await apiOk<CallRecord>(`/calls/${ringing.id}`)
    expect(detail.body.id).toBe(ringing.id)
    expect(detail.body.peer).toContain('*')
    expect(detail.body.peer).not.toBe(peer)
    expect(detail.body.direction).toBe('inbound')
    expect(typeof detail.body.status).toBe('string')

    const revealed = await apiOk<CallRecord>(`/calls/${ringing.id}?reveal=true`)
    expect(revealed.body.peer).toBe(peer)

    const page = await apiOk<{ calls: CallRecord[] }>('/calls?limit=1&offset=0')
    expect(page.body.calls.length).toBeLessThanOrEqual(1)
    assertNoSecretLeaks(page.body, 'call-list')
    assertNoSecretLeaks(detail.body, 'call-detail')

    await api('/calls/current/reject', { method: 'POST', body: '{}' })
    await hangupQuietly()
  })
})
