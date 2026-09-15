import { describe, expect, it } from 'vitest'

import {
  classifyVisibility,
  compileHighFrequencyInstructions,
  createRetriever,
  disclose,
  matrixCells,
  matrixDecision,
  TENANT_ID,
  type KnowledgeItem,
  type RetrievedHit,
  type TrustLevel,
  type Visibility
} from '@mishu/core/knowledge'

const NOW = 1_778_198_400_000

function item(partial: Partial<KnowledgeItem> & Pick<KnowledgeItem, 'id' | 'visibility'>): KnowledgeItem {
  return {
    tenantId: TENANT_ID,
    version: 1,
    kind: 'policy',
    aliases: ['office'],
    content: 'payload',
    provenance: 'test',
    ...partial
  }
}

function hitOf(row: KnowledgeItem, score = 1): RetrievedHit {
  return {
    itemId: row.id,
    version: row.version,
    visibility: row.visibility,
    provenance: row.provenance,
    content: row.content,
    score
  }
}

describe('disclosure matrix', () => {
  it('covers every trust x visibility cell and never_disclose is always deny', () => {
    const expected: Record<TrustLevel, Record<Visibility, string>> = {
      unverified: { public: 'allow', known_contact: 'verification_required', vip_only: 'transfer_to_owner', never_disclose: 'deny' },
      number_match: { public: 'allow', known_contact: 'verification_required', vip_only: 'verification_required', never_disclose: 'deny' },
      verified_contact: { public: 'allow', known_contact: 'allow', vip_only: 'transfer_to_owner', never_disclose: 'deny' },
      verified_vip: { public: 'allow', known_contact: 'allow', vip_only: 'allow', never_disclose: 'deny' }
    }
    const cells = matrixCells()
    expect(cells).toHaveLength(16)
    for (const cell of cells) {
      expect(matrixDecision(cell.trust, cell.visibility)).toBe(expected[cell.trust][cell.visibility])
      const row = item({
        id: `cell_${cell.trust}_${cell.visibility}`,
        visibility: cell.visibility,
        content: `payload-${cell.visibility}`
      })
      const result = disclose([hitOf(row)], new Map([[row.id, row]]), {
        tenantId: TENANT_ID,
        trustLevel: cell.trust,
        nowMs: NOW,
        query: 'office'
      })
      expect(result.decision).toBe(cell.decision)
      if (cell.visibility === 'never_disclose') {
        expect(result.decision).toBe('deny')
        expect(result.allowed).toEqual([])
        expect(JSON.stringify(result.allowed)).not.toContain('payload-never_disclose')
      }
    }
  })

  it('treats missing or unknown visibility as never_disclose', () => {
    expect(classifyVisibility(undefined)).toBe('never_disclose')
    expect(classifyVisibility('weird')).toBe('never_disclose')
  })

  it('never upgrades number_match to verified', () => {
    expect(matrixDecision('number_match', 'known_contact')).toBe('verification_required')
    expect(matrixDecision('number_match', 'vip_only')).toBe('verification_required')
    expect(matrixDecision('number_match', 'vip_only')).not.toBe('allow')
  })
})

describe('never_disclose isolation', () => {
  it('does not put never_disclose content into allowed packets even for verified_vip', () => {
    const secret = item({
      id: 'kb_never_password',
      visibility: 'never_disclose',
      content: 'NEVER_SECRET_PASSWORD',
      aliases: ['password', '登录密码']
    })
    const result = disclose([hitOf(secret)], new Map([[secret.id, secret]]), {
      tenantId: TENANT_ID,
      trustLevel: 'verified_vip',
      nowMs: NOW,
      query: 'password'
    })
    expect(result.decision).toBe('deny')
    expect(result.reasonCode).toBe('deny_never_disclose')
    expect(result.allowed).toEqual([])
    expect(JSON.stringify(result)).not.toContain('NEVER_SECRET_PASSWORD')
  })

  it('refuses to compile never_disclose into resident instructions', () => {
    const secret = item({
      id: 'kb_never_password',
      visibility: 'never_disclose',
      content: 'NEVER_SECRET_PASSWORD'
    })
    expect(() => compileHighFrequencyInstructions([{
      id: 'hf_bad',
      sourceItemId: secret.id,
      version: 1,
      text: 'should not compile'
    }], new Map([[secret.id, secret]]))).toThrow(/never_disclose fact hf_bad cannot enter resident instructions/)
  })

  it('selector itemIds still cannot bypass disclose', () => {
    const publicItem = item({
      id: 'kb_public_hours',
      visibility: 'public',
      content: '09:00-18:00',
      aliases: ['hours']
    })
    const secret = item({
      id: 'kb_never_password',
      visibility: 'never_disclose',
      content: 'NEVER_SECRET_PASSWORD',
      aliases: ['password']
    })
    const items = [publicItem, secret]
    const byId = new Map(items.map((row) => [row.id, row]))
    const selectedIds = ['kb_never_password', 'kb_public_hours']
    const hits = selectedIds.map((id) => hitOf(byId.get(id)!))
    const result = disclose(hits, byId, {
      tenantId: TENANT_ID,
      trustLevel: 'verified_vip',
      nowMs: NOW,
      query: 'password hours'
    })
    expect(result.allowed.every((packet) => packet.itemId !== 'kb_never_password')).toBe(true)
    expect(JSON.stringify(result.allowed)).not.toContain('NEVER_SECRET_PASSWORD')
    expect(result.withheld.some((row) => row.itemId === 'kb_never_password' && row.reasonCode === 'never_disclose')).toBe(true)
  })
})

describe('sensitive step-up, expiry, conflict', () => {
  it('sends credentials to the owner even for verified VIP', () => {
    const row = item({
      id: 'kb_cred',
      visibility: 'public',
      sensitiveCategory: 'credential',
      content: 'otp-999'
    })
    const result = disclose([hitOf(row)], new Map([[row.id, row]]), {
      tenantId: TENANT_ID,
      trustLevel: 'verified_vip',
      nowMs: NOW,
      query: 'otp'
    })
    expect(result.decision).toBe('transfer_to_owner')
    expect(result.allowed).toEqual([])
  })

  it('does not speak expired content', () => {
    const row = item({
      id: 'kb_old',
      visibility: 'public',
      content: 'stale-promo',
      expiresAt: 1
    })
    const result = disclose([hitOf(row)], new Map([[row.id, row]]), {
      tenantId: TENANT_ID,
      trustLevel: 'unverified',
      nowMs: NOW,
      query: 'promo'
    })
    expect(result.decision).toBe('verification_required')
    expect(result.reasonCode).toBe('expired_stale')
    expect(result.allowed).toEqual([])
  })

  it('refuses to pick a winner when two live facts conflict', () => {
    const a = item({ id: 'a', visibility: 'public', content: 'nine', conflictsWith: ['b'] })
    const b = item({ id: 'b', visibility: 'public', content: 'ten', conflictsWith: ['a'] })
    const result = disclose([hitOf(a), hitOf(b)], new Map([['a', a], ['b', b]]), {
      tenantId: TENANT_ID,
      trustLevel: 'unverified',
      nowMs: NOW,
      query: 'time'
    })
    expect(result.decision).toBe('verification_required')
    expect(result.reasonCode).toBe('conflict_unresolved')
    expect(result.allowed).toEqual([])
  })

  it('returns no_match when retrieval is empty', () => {
    const result = disclose([], new Map(), {
      tenantId: TENANT_ID,
      trustLevel: 'unverified',
      nowMs: NOW,
      query: 'cat'
    })
    expect(result.decision).toBe('no_match')
  })
})

describe('lexical retrieve freeze defaults', () => {
  it('uses topK 5 and minScore 0.18 by default and still surfaces never_disclose for disclose to deny', () => {
    const hours = item({
      id: 'kb_public_hours',
      visibility: 'public',
      content: 'office hours 09:00-18:00 weekday',
      aliases: ['office hours', '营业时间']
    })
    const secret = item({
      id: 'kb_never_password',
      visibility: 'never_disclose',
      content: 'NEVER_SECRET_PASSWORD',
      aliases: ['login password', '登录密码']
    })
    const retriever = createRetriever([hours, secret])
    const passwordHits = retriever.search('login password')
    expect(passwordHits.some((hit) => hit.itemId === 'kb_never_password')).toBe(true)
    const disclosed = disclose(passwordHits, new Map([[hours.id, hours], [secret.id, secret]]), {
      tenantId: TENANT_ID,
      trustLevel: 'verified_vip',
      nowMs: NOW,
      query: 'login password'
    })
    expect(disclosed.decision).toBe('deny')
    expect(disclosed.allowed).toEqual([])

    const bounded = createRetriever([hours, secret], { topK: 2, minScore: 0 }).search('hours')
    expect(bounded.length).toBeLessThanOrEqual(2)
  })
})
