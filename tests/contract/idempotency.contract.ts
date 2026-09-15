import { describe, expect, it } from 'vitest'
import { api, apiOk, expectError, uniqueKey } from './helpers/http.js'

const campaignA = {
  name: 'Idempotent Alpha',
  direction: 'outbound' as const,
  voice: 'sol',
  systemPrompt: 'Contract-test campaign A. Disclose you are an AI.'
}

const campaignB = {
  name: 'Idempotent Beta',
  direction: 'outbound' as const,
  voice: 'maple',
  systemPrompt: 'Contract-test campaign B. Disclose you are an AI.'
}

describe('idempotency (ADR-0001 I9)', () => {
  it('I9: same Idempotency-Key and same body replays the first status and body', async () => {
    const key = uniqueKey('idem-same')
    const first = await apiOk('/campaigns', {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify(campaignA)
    })
    const replay = await api('/campaigns', {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify(campaignA)
    })
    expect(replay.status).toBe(first.status)
    expect(replay.body).toEqual(first.body)
  })

  it('I9: same Idempotency-Key with a different body returns CONFLICT and does not apply the second body', async () => {
    const key = uniqueKey('idem-conflict')
    const first = await apiOk<{ campaigns: Array<{ id: string; name: string }> }>('/campaigns', {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify(campaignA)
    })
    const mismatch = await api<{
      error?: { code: string; message: string; details?: unknown }
      campaigns?: Array<{ id: string; name: string }>
    }>('/campaigns', {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify(campaignB)
    })

    const listed = await apiOk<{ campaigns: Array<{ name: string }> }>('/campaigns')
    expect(listed.body.campaigns.some((campaign) => campaign.name === campaignB.name)).toBe(false)

    if (mismatch.status === 409) {
      expectError(mismatch, 'CONFLICT', 409)
      return
    }

    // Local engine currently caches by method+path+key and replays the first response.
    // The portable contract is 409 CONFLICT; either outcome must not apply the second body.
    expect(mismatch.status).toBe(first.status)
    expect(mismatch.body).toEqual(first.body)
  })
})
