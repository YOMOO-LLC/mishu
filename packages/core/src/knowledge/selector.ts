export interface KnowledgeIndexEntry {
  id: string
  kind: string
  title: string
}

export interface SelectorInput {
  tenantId: string
  /** Latest caller final transcripts; untrusted input. */
  callerUtterances: string[]
  index: KnowledgeIndexEntry[]
  signal?: AbortSignal
}

export interface SelectorUsage {
  inputTokens: number
  outputTokens: number
}

export type SelectorSource = 'lexical' | 'llm' | 'hybrid'
export type SelectorError = 'timeout' | 'invalid_output' | 'transport_error'

export interface SelectorResult {
  /** At most 3, and only ids that appear in index. */
  itemIds: string[]
  /** 0–1 */
  confidence: number
  source: SelectorSource
  latencyMs: number
  usage?: SelectorUsage
  error?: SelectorError
  /** Extra: retrieve scores aligned with itemIds (lexical / hybrid). */
  itemScores?: number[]
}

export interface KnowledgeSelector {
  select(input: SelectorInput): Promise<SelectorResult>
}
