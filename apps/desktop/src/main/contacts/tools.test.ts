import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CallStore } from '../call-store.js'
import type { InCallTool } from '../copilot/registry.js'
import { ToolRegistry } from '../copilot/registry.js'
import { ContactService } from '../services/contact-service.js'
import { createContactLookupTool } from './tools.js'

function setup() {
  const store = new CallStore(join(mkdtempSync(join(tmpdir(), 'contact-tools-')), 'calls.sqlite3'))
  store.report({
    call: { id: 'call-1', direction: 'inbound', peer: '+13125550198', status: 'active' },
    runtimeMode: 'mock'
  })
  const contacts = new ContactService(store)
  const registry = new ToolRegistry()
  return { store, contacts, registry }
}

const ctx = { campaignId: 'campaign-1', callSessionId: 'call-1', actor: 'copilot' }

describe('contact_lookup', () => {
  it('uses the local card before the CRM fallback and limits model text fields', async () => {
    const { store, contacts, registry } = setup()
    contacts.upsert({
      phone: '+13125550198', displayName: 'Ada', company: 'Analytical Engines', tier: 'Gold',
      language: 'en', notes: 'Interested in a pilot', facts: { secretCustomField: 'not for model' }
    })
    const crmExecute = vi.fn()
    registry.register(crmTool(crmExecute))
    const tool = createContactLookupTool(contacts, store, registry)
    const result = await tool.execute(ctx, tool.validate({}))
    const text = tool.toModelText(result)
    expect(crmExecute).not.toHaveBeenCalled()
    expect(text).toContain('Name: Ada')
    expect(text).toContain('Company: Analytical Engines')
    expect(text).toContain('Latest notes: Interested in a pilot')
    expect(text).not.toContain('secretCustomField')
  })

  it('falls back to crm_lookup_customer when the local card is missing', async () => {
    const { store, contacts, registry } = setup()
    const crmExecute = vi.fn(async () => ({
      name: 'Grace', phone: '+13125550198', tier: 'Silver', city: 'Chicago',
      recordRef: { module: 'Contacts' as const, id: 'crm-1' }
    }))
    registry.register(crmTool(crmExecute))
    const tool = createContactLookupTool(contacts, store, registry)
    const result = await tool.execute(ctx, tool.validate({}))
    expect(crmExecute).toHaveBeenCalledOnce()
    expect(tool.toModelText(result)).toBe('Name: Grace; Tier: Silver')
  })

  it('returns no background when neither local cards nor CRM are available', async () => {
    const { store, contacts, registry } = setup()
    const tool = createContactLookupTool(contacts, store, registry)
    const result = await tool.execute(ctx, tool.validate({}))
    expect(tool.toModelText(result)).toBe('No background.')
  })
})

function crmTool(execute: (args: { phone: string }) => Promise<unknown>): InCallTool<{ phone: string }, unknown> {
  return {
    id: 'crm_lookup_customer', version: 1, risk: 'read', timeoutMs: 100,
    spec: { type: 'function', name: 'crm_lookup_customer', description: 'crm', inputSchema: { type: 'object' } },
    validate(value) { return { phone: (value as { phone: string }).phone } },
    execute: (_ctx, args) => execute(args),
    toModelText: () => 'unused'
  }
}
