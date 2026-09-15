/// <reference types="node" />
import { createHash } from 'node:crypto'

import { classifyVisibility } from './disclose.js'
import { INSTRUCTIONS_TOKEN_BUDGET, estimateTokens } from './tokens.js'
import type { HighFrequencyFact, KnowledgeItem } from './types.js'
import { neutralizeInjection } from './wrap-reference.js'

export interface CompiledInstructions {
  text: string
  tokens: number
  hash: string
  factIds: string[]
  sourceVersions: Array<{ itemId: string; version: number }>
}

export function compileHighFrequencyInstructions(facts: readonly HighFrequencyFact[], itemsById: ReadonlyMap<string, KnowledgeItem>): CompiledInstructions {
  const lines: string[] = [
    'Resident public facts (with version; not a secret store):'
  ]
  const factIds: string[] = []
  const sourceVersions: Array<{ itemId: string; version: number }> = []
  for (const fact of facts) {
    const item = itemsById.get(fact.sourceItemId)
    if (item && classifyVisibility(item.visibility) === 'never_disclose') {
      throw new Error(`never_disclose fact ${fact.id} cannot enter resident instructions`)
    }
    const text = neutralizeInjection(fact.text).replace(/\s+/g, ' ').trim()
    lines.push(`- [${fact.id} v${fact.version} src=${fact.sourceItemId}] ${text}`)
    factIds.push(fact.id)
    sourceVersions.push({ itemId: fact.sourceItemId, version: fact.version })
  }
  const text = lines.join('\n')
  const tokens = estimateTokens(text)
  if (tokens > INSTRUCTIONS_TOKEN_BUDGET) {
    throw new Error(`resident instructions estimated at ${tokens} tokens; budget is ${INSTRUCTIONS_TOKEN_BUDGET}`)
  }
  const hash = createHash('sha256').update(text).digest('hex')
  return { text, tokens, hash, factIds, sourceVersions }
}
