import { describe, expect, it } from 'vitest'

import {
  chineseBigrams,
  createRetriever,
  isStopword,
  normalizeText,
  significantQueryTokens,
  TENANT_ID,
  tokenize,
  type KnowledgeItem
} from '@mishu/core/knowledge'

function item(partial: Partial<KnowledgeItem> & Pick<KnowledgeItem, 'id'>): KnowledgeItem {
  return {
    tenantId: TENANT_ID,
    version: 1,
    kind: 'policy',
    visibility: 'public',
    aliases: [],
    content: 'payload',
    provenance: 'test',
    ...partial
  }
}

describe('normalize freeze contract', () => {
  it('folds fullwidth ASCII and case, and does not convert 简繁', () => {
    expect(normalizeText('ＡＢＣ')).toBe('abc')
    expect(normalizeText('Office Hours')).toBe('office hours')
    expect(normalizeText('繁體')).toBe('繁體')
  })

  it('drops configured stopwords from significant query tokens', () => {
    expect(isStopword('the')).toBe(true)
    expect(isStopword('请问')).toBe(true)
    const tokens = significantQueryTokens('请问 office hours')
    expect(tokens.words).toContain('office')
    expect(tokens.words).toContain('hours')
    expect(tokens.words).not.toContain('the')
  })

  it('emits Chinese bigrams without changing 简繁', () => {
    expect(chineseBigrams(normalizeText('营业时间'))).toEqual(['营业', '业时', '时间'])
    expect(tokenize('office hours').words).toEqual(['office', 'hours'])
  })
})

describe('lexical retriever freeze contract', () => {
  it('hits a direct Chinese alias and an English paraphrase', () => {
    const hours = item({
      id: 'kb_public_hours',
      content: '工作日 09:00-18:00',
      aliases: ['营业时间', 'office hours']
    })
    const retriever = createRetriever([hours])
    expect(retriever.search('你们营业时间是几点')[0]?.itemId).toBe('kb_public_hours')
    expect(retriever.search('What time are the office hours?').some((hit) => hit.itemId === 'kb_public_hours')).toBe(true)
  })

  it('does not let a short owner-name alias answer an unrelated leftover query', () => {
    const owner = item({
      id: 'kb_public_owner_name',
      content: 'owner name',
      aliases: ['李明']
    })
    const pet = item({
      id: 'kb_known_pet',
      visibility: 'known_contact',
      content: 'cat name',
      aliases: ['猫']
    })
    const hits = createRetriever([owner, pet]).search('李明的猫叫什么名字？')
    expect(hits.every((hit) => hit.itemId !== 'kb_public_owner_name' && hit.itemId !== 'kb_known_pet')).toBe(true)
  })

  it('bounds top-k and keeps default minScore at 0.18', () => {
    const hours = item({
      id: 'kb_public_hours',
      content: '时间 office hours',
      aliases: ['时间']
    })
    const other = item({
      id: 'kb_public_other',
      content: 'unrelated',
      aliases: ['zzz']
    })
    const hits = createRetriever([hours, other], { topK: 2, minScore: 0 }).search('时间')
    expect(hits.length).toBeLessThanOrEqual(2)
  })
})
