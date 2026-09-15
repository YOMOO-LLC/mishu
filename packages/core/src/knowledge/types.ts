/** Trust levels from ADR-0002. `number_match` never upgrades itself to verified. */
export type TrustLevel = 'unverified' | 'number_match' | 'verified_contact' | 'verified_vip'

export type Visibility = 'public' | 'known_contact' | 'vip_only' | 'never_disclose'

export type SensitiveCategory = 'financial' | 'health' | 'location' | 'credential'

export type KnowledgeKind =
  | 'identity'
  | 'hours'
  | 'preference'
  | 'schedule'
  | 'account'
  | 'health'
  | 'secret'
  | 'policy'
  | 'location'
  | 'personal'
  | 'contact'

export type DisclosureDecision =
  | 'allow'
  | 'verification_required'
  | 'transfer_to_owner'
  | 'deny'
  | 'no_match'

export interface KnowledgeField {
  name: string
  value: string
  aliases: string[]
}

export interface KnowledgeItem {
  id: string
  tenantId: string
  version: number
  kind: KnowledgeKind
  /** Missing or unknown values are treated as `never_disclose`. */
  visibility: Visibility | string
  sensitiveCategory?: SensitiveCategory
  aliases: string[]
  content: string
  provenance: string
  /** Epoch ms. Past values are stale and must not be spoken as current fact. */
  expiresAt?: number
  fields?: KnowledgeField[]
  conflictsWith?: string[]
}

export interface RetrievedHit {
  itemId: string
  version: number
  visibility: string
  provenance: string
  content: string
  score: number
}

export interface AllowedPacket {
  itemId: string
  version: number
  visibility: Visibility
  provenance: string
  content: string
}

export interface WithheldRef {
  itemId: string
  reasonCode: string
}

export interface DisclosureResult {
  decision: DisclosureDecision
  reasonCode: string
  allowed: AllowedPacket[]
  withheld: WithheldRef[]
}

export interface CallerContext {
  tenantId: string
  trustLevel: TrustLevel
  nowMs: number
  query: string
}

export interface TrustFixture {
  id: string
  label: string
  trustLevel: TrustLevel
  phone: string
  displayName: string
  tier?: 'vip' | 'known' | 'unknown'
}

export type QuestionCategory =
  | 'direct'
  | 'paraphrase'
  | 'conflict'
  | 'expired'
  | 'unknown'
  | 'social_engineering'
  | 'spoofed_number'
  | 'multi_fact'
  | 'injection'
  | 'cancel'
  | 'timeout'

export type ExpectedOutcome =
  | 'allow'
  | 'verification_required'
  | 'no_match'
  | 'transfer_to_owner'
  | 'deny'
  | 'cancel'
  | 'timeout'

export interface ScriptedQuestion {
  id: string
  text: string
  category: QuestionCategory
  callerTrustId: string
  expectedOutcome: ExpectedOutcome
  expectedItemIds: string[]
  forbiddenItemIds: string[]
  highFrequency: boolean
  notes?: string
}

export interface HighFrequencyFact {
  id: string
  sourceItemId: string
  version: number
  text: string
}

export type QueryInferFn = (finals: readonly string[], partial: string) => string

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const TENANT_ID = 'tenant_synthetic_local'

export const DECISION_STRICTNESS: Record<DisclosureDecision, number> = {
  deny: 4,
  transfer_to_owner: 3,
  verification_required: 2,
  allow: 1,
  no_match: 0
}
