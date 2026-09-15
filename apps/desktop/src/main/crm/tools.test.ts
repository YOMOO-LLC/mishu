import { describe, expect, it } from 'vitest'
import { MockCrmAdapter } from './mock-adapter'
import { createCrmTools } from './tools'

describe('CRM copilot tools', () => {
  it('registers the required risk levels', () => {
    const tools = createCrmTools(() => new MockCrmAdapter())
    expect(Object.fromEntries(tools.map((tool) => [tool.id, tool.risk]))).toEqual({
      crm_lookup_customer: 'read',
      crm_create_lead: 'draft-write',
      crm_add_note: 'draft-write',
      crm_create_event: 'external-write'
    })
  })

  it('keeps lookup model text short and omits phone, email, and internal id', async () => {
    const tools = createCrmTools(() => new MockCrmAdapter())
    const lookup = tools.find((tool) => tool.id === 'crm_lookup_customer')
    if (!lookup) throw new Error('lookup tool missing')
    const result = await lookup.execute(
      { campaignId: 'campaign', callSessionId: 'call', actor: 'copilot' },
      lookup.validate({ phone: '+14155550142' }) as never
    )
    const text = lookup.toModelText(result)

    expect(text).toContain('Alex Lin')
    expect(text).toContain('Gold customer')
    expect(text).not.toContain('mock-contact-1')
    expect(text).not.toContain('4155550142')
    expect(text).not.toContain('@')
  })
})
