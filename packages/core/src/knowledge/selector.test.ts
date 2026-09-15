import { describe, expect, it } from 'vitest'

import {
  classifyVisibility,
  disclose,
  TENANT_ID,
  type KnowledgeItem,
  type KnowledgeSelector,
  type SelectorResult
} from '@mishu/core/knowledge'

const NOW = 1_778_198_400_000

function item(partial: Partial<KnowledgeItem> & Pick<KnowledgeItem, 'id' | 'visibility'>): KnowledgeItem {
  return {
    tenantId: TENANT_ID,
    version: 1,
    kind: 'secret',
    aliases: ['password'],
    content: 'NEVER_SECRET_PASSWORD',
    provenance: 'test',
    ...partial
  }
}

describe('KnowledgeSelector contract', () => {
  it('cannot place never_disclose content into allowed packets even when select returns the id', async () => {
    const secret = item({ id: 'kb_never_password', visibility: 'never_disclose' })
    const selector: KnowledgeSelector = {
      async select() {
        const result: SelectorResult = {
          itemIds: [secret.id],
          confidence: 1,
          source: 'llm',
          latencyMs: 0
        }
        return result
      }
    }
    const selected = await selector.select({
      tenantId: TENANT_ID,
      callerUtterances: ['login password'],
      index: [{ id: secret.id, kind: secret.kind, title: 'password' }]
    })
    expect(selected.itemIds).toEqual([secret.id])
    const result = disclose([{
      itemId: secret.id,
      version: secret.version,
      visibility: secret.visibility,
      provenance: secret.provenance,
      content: secret.content,
      score: 1
    }], new Map([[secret.id, secret]]), {
      tenantId: TENANT_ID,
      trustLevel: 'verified_vip',
      nowMs: NOW,
      query: 'login password'
    })
    expect(classifyVisibility(secret.visibility)).toBe('never_disclose')
    expect(result.decision).toBe('deny')
    expect(result.allowed).toEqual([])
    expect(JSON.stringify(result.allowed)).not.toContain('NEVER_SECRET_PASSWORD')
  })
})
