import { normalizeText, significantQueryTokens, tokenize } from './normalize.js'
import type { KnowledgeItem, RetrievedHit } from './types.js'

export interface RetrieverOptions {
  topK?: number
  minScore?: number
}

interface IndexedItem {
  item: KnowledgeItem
  bigrams: Set<string>
  words: Set<string>
  aliasNormalized: string[]
}

export interface KnowledgeRetriever {
  search(query: string): RetrievedHit[]
}

export function createRetriever(
  items: readonly KnowledgeItem[],
  options: RetrieverOptions = {}
): KnowledgeRetriever {
  const topK = options.topK ?? 5
  const minScore = options.minScore ?? 0.18
  const index: IndexedItem[] = items.map((item) => {
    const aliasNormalized = [
      ...item.aliases,
      ...(item.fields ?? []).flatMap((field) => field.aliases)
    ].map((alias) => normalizeText(alias)).filter(Boolean)
    const blob = tokenize([
      item.content,
      item.kind,
      ...(item.fields ?? []).map((field) => `${field.value} ${field.aliases.join(' ')}`)
    ].join(' '))
    const extra = aliasNormalized.flatMap((alias) => {
      const tokens = tokenize(alias)
      return { bigrams: tokens.bigrams, words: tokens.words }
    })
    const bigrams = new Set(blob.bigrams)
    const words = new Set(blob.words)
    for (const part of extra) {
      for (const gram of part.bigrams) bigrams.add(gram)
      for (const word of part.words) words.add(word)
    }
    return { item, bigrams, words, aliasNormalized }
  })

  return {
    search(query: string): RetrievedHit[] {
      const q = significantQueryTokens(query)
      if (q.bigrams.length === 0 && q.words.length === 0 && q.raw.length < 2) return []
      const scored: RetrievedHit[] = []
      for (const entry of index) {
        const score = scoreItem(entry, q)
        if (score < minScore) continue
        const item = entry.item
        scored.push({
          itemId: item.id,
          version: item.version,
          visibility: item.visibility,
          provenance: item.provenance,
          content: item.content,
          score
        })
      }
      scored.sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId))
      return scored.slice(0, topK)
    }
  }
}

function scoreItem(entry: IndexedItem, q: { bigrams: string[]; words: string[]; raw: string }): number {
  let aliasHits = 0
  let longestAlias = 0
  for (const alias of entry.aliasNormalized) {
    if (!alias) continue
    const contained = q.raw.includes(alias) || (alias.includes(q.raw) && alias.length <= q.raw.length + 4)
    if (!contained) continue
    aliasHits += 1
    if (alias.length > longestAlias) longestAlias = alias.length
  }
  const sharedBigrams = q.bigrams.filter((gram) => entry.bigrams.has(gram)).length
  const sharedWords = q.words.filter((word) => entry.words.has(word)).length
  const unmatchedBigrams = q.bigrams.filter((gram) => !entry.bigrams.has(gram)).length
  const unmatchedWords = q.words.filter((word) => !entry.words.has(word)).length
  const bigramDenom = Math.max(q.bigrams.length, 1)
  const wordDenom = Math.max(q.words.length, 1)
  const bigramRecall = q.bigrams.length === 0 ? 0 : sharedBigrams / bigramDenom
  const wordRecall = q.words.length === 0 ? 0 : sharedWords / wordDenom
  const hasSignal = aliasHits > 0 || sharedBigrams > 0 || sharedWords > 0
  if (!hasSignal) return 0
  let score = aliasHits * 0.45 + bigramRecall * 0.4 + wordRecall * 0.35
  // A short alias (e.g. a two-character personal name) must not answer a query whose leftover tokens are the actual ask.
  const leftover = unmatchedBigrams + unmatchedWords
  const coverage = q.bigrams.length + q.words.length === 0
    ? 1
    : (sharedBigrams + sharedWords) / Math.max(q.bigrams.length + q.words.length, 1)
  if (aliasHits > 0 && longestAlias < 3 && coverage < 0.34 && leftover >= 2) score *= 0.2
  return score
}

export function toHitMap(items: readonly KnowledgeItem[]): Map<string, KnowledgeItem> {
  return new Map(items.map((item) => [item.id, item]))
}
