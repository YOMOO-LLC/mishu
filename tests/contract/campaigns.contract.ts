import { describe, expect, it } from 'vitest'
import { api, apiOk, uniqueKey } from './helpers/http.js'
import { assertNoSecretLeaks } from './helpers/secrets.js'

interface Campaign {
  id: string
  name: string
  direction: string
  systemPrompt: string
  voice: string
  policy: Record<string, unknown>
  inboundNumber?: string
  outboundCallerId?: string
  ephemeral: boolean
  createdAt: number
  updatedAt: number
}

interface Workspace {
  selectedCampaignId: string
  campaigns: Campaign[]
}

describe('campaigns CRUD (ADR-0001 I9)', () => {
  it('I9: create, read, update, list, and delete a campaign', async () => {
    const inbound = '+15555550911'
    const name = `Contract ${uniqueKey('c').slice(0, 12)}`
    const created = await apiOk<Workspace>('/campaigns?reveal=true', {
      method: 'POST',
      idempotencyKey: uniqueKey('campaign-create'),
      body: JSON.stringify({
        name,
        direction: 'outbound',
        voice: 'sol',
        systemPrompt: 'Follow the contract-test script and disclose you are an AI.',
        inboundNumber: inbound
      })
    })
    expect(created.status).toBe(201)
    const campaign = created.body.campaigns.find((item) => item.name === name)
    expect(campaign).toMatchObject({
      name,
      direction: 'outbound',
      voice: 'sol',
      ephemeral: false
    })
    expect(campaign?.inboundNumber).toBe(inbound)
    expect(typeof campaign?.id).toBe('string')
    expect(typeof campaign?.createdAt).toBe('number')

    const got = await apiOk<Campaign>(`/campaigns/${campaign?.id}?reveal=true`)
    expect(got.body.id).toBe(campaign?.id)
    expect(got.body.systemPrompt).toContain('disclose you are an AI')

    const masked = await apiOk<Campaign>(`/campaigns/${campaign?.id}`)
    expect(masked.body.inboundNumber).toContain('*')
    expect(masked.body.inboundNumber).not.toBe(inbound)

    const renamed = `${name}-updated`
    const updated = await apiOk<Workspace>(`/campaigns/${campaign?.id}?reveal=true`, {
      method: 'PUT',
      body: JSON.stringify({ name: renamed, voice: 'maple' })
    })
    expect(updated.body.campaigns.find((item) => item.id === campaign?.id)).toMatchObject({
      name: renamed,
      voice: 'maple'
    })

    const listed = await apiOk<Workspace>('/campaigns')
    expect(listed.body.campaigns.some((item) => item.id === campaign?.id)).toBe(true)
    expect(typeof listed.body.selectedCampaignId).toBe('string')
    // v1 campaign list is a workspace snapshot; contacts/calls carry limit/offset pagination.
    assertNoSecretLeaks(
      { ...listed.body, campaigns: listed.body.campaigns.map(({ systemPrompt: _prompt, ...rest }) => rest) },
      'campaign-list'
    )

    const deleted = await apiOk<Workspace>(`/campaigns/${campaign?.id}`, { method: 'DELETE' })
    expect(deleted.body.campaigns.some((item) => item.id === campaign?.id)).toBe(false)
    const missing = await api(`/campaigns/${campaign?.id}`)
    expect(missing.status).toBe(404)
  })
})
