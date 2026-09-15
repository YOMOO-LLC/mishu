import { normalizeText } from './normalize.js'
import type {
  AllowedPacket,
  CallerContext,
  DisclosureDecision,
  DisclosureResult,
  KnowledgeItem,
  RetrievedHit,
  SensitiveCategory,
  TrustLevel,
  Visibility,
  WithheldRef
} from './types.js'
import { DECISION_STRICTNESS } from './types.js'

const VISIBILITIES = new Set<Visibility>(['public', 'known_contact', 'vip_only', 'never_disclose'])

const MATRIX: Record<TrustLevel, Record<Visibility, DisclosureDecision>> = {
  unverified: {
    public: 'allow',
    known_contact: 'verification_required',
    vip_only: 'transfer_to_owner',
    never_disclose: 'deny'
  },
  number_match: {
    public: 'allow',
    known_contact: 'verification_required',
    vip_only: 'verification_required',
    never_disclose: 'deny'
  },
  verified_contact: {
    public: 'allow',
    known_contact: 'allow',
    vip_only: 'transfer_to_owner',
    never_disclose: 'deny'
  },
  verified_vip: {
    public: 'allow',
    known_contact: 'allow',
    vip_only: 'allow',
    never_disclose: 'deny'
  }
}

export function classifyVisibility(value: string | undefined): Visibility {
  if (value && VISIBILITIES.has(value as Visibility)) return value as Visibility
  return 'never_disclose'
}

export function matrixDecision(trust: TrustLevel, visibility: Visibility): DisclosureDecision {
  return MATRIX[trust][visibility]
}

function applySensitiveStepUp(
  decision: DisclosureDecision,
  category: SensitiveCategory | undefined,
  trust: TrustLevel
): { decision: DisclosureDecision; reasonCode?: string } {
  if (!category || decision !== 'allow') return { decision }
  if (category === 'credential') {
    return { decision: 'transfer_to_owner', reasonCode: 'sensitive_credential' }
  }
  if (trust === 'verified_vip') return { decision }
  if (trust === 'verified_contact') {
    return { decision: 'verification_required', reasonCode: `sensitive_${category}_step_up` }
  }
  return { decision: 'transfer_to_owner', reasonCode: `sensitive_${category}_unverified` }
}

function clipFields(item: KnowledgeItem, query: string): string {
  if (!item.fields || item.fields.length === 0) return item.content
  const q = normalizeText(query)
  const matched = item.fields.filter((field) => {
    if (q.includes(normalizeText(field.name)) || q.includes(normalizeText(field.value))) return true
    return field.aliases.some((alias) => {
      const n = normalizeText(alias)
      return n.length > 0 && q.includes(n)
    })
  })
  if (matched.length === 0) {
    const summary = item.fields.find((field) => field.name === 'summary')
    return summary ? summary.value : item.content
  }
  return matched.map((field) => `${field.name}: ${field.value}`).join('; ')
}

function stricter(a: DisclosureDecision, b: DisclosureDecision): DisclosureDecision {
  return DECISION_STRICTNESS[a] >= DECISION_STRICTNESS[b] ? a : b
}

export function disclose(
  hits: readonly RetrievedHit[],
  itemsById: ReadonlyMap<string, KnowledgeItem>,
  ctx: CallerContext
): DisclosureResult {
  if (hits.length === 0) {
    return { decision: 'no_match', reasonCode: 'no_match', allowed: [], withheld: [] }
  }

  const tenantHits: RetrievedHit[] = []
  const withheld: WithheldRef[] = []
  const neverHits: RetrievedHit[] = []
  const rest: { hit: RetrievedHit; item: KnowledgeItem }[] = []

  for (const hit of hits) {
    const item = itemsById.get(hit.itemId)
    if (!item) continue
    if (item.tenantId !== ctx.tenantId) {
      withheld.push({ itemId: item.id, reasonCode: 'tenant_mismatch' })
      continue
    }
    const visibility = classifyVisibility(item.visibility)
    if (visibility === 'never_disclose') {
      neverHits.push(hit)
      withheld.push({ itemId: item.id, reasonCode: 'never_disclose' })
      continue
    }
    rest.push({ hit, item })
  }

  if (rest.length === 0) {
    if (neverHits.length > 0) {
      return { decision: 'deny', reasonCode: 'deny_never_disclose', allowed: [], withheld }
    }
    if (withheld.some((row) => row.reasonCode === 'tenant_mismatch') && hits.length > 0) {
      return { decision: 'no_match', reasonCode: 'no_match_cross_tenant', allowed: [], withheld }
    }
    return { decision: 'no_match', reasonCode: 'no_match', allowed: [], withheld }
  }

  let live: { hit: RetrievedHit; item: KnowledgeItem }[] = []
  for (const row of rest) {
    if (typeof row.item.expiresAt === 'number' && row.item.expiresAt <= ctx.nowMs) {
      withheld.push({ itemId: row.item.id, reasonCode: 'expired_stale' })
      continue
    }
    live.push(row)
  }

  if (live.length === 0) {
    return { decision: 'verification_required', reasonCode: 'expired_stale', allowed: [], withheld }
  }

  const ids = new Set(live.map((row) => row.item.id))
  const conflictIds = new Set<string>()
  for (const row of live) {
    for (const other of row.item.conflictsWith ?? []) {
      if (ids.has(other)) {
        conflictIds.add(row.item.id)
        conflictIds.add(other)
      }
    }
  }
  if (conflictIds.size > 0) {
    for (const id of conflictIds) withheld.push({ itemId: id, reasonCode: 'conflict_unresolved' })
    const remaining = live.filter((row) => !conflictIds.has(row.item.id))
    if (remaining.length === 0) {
      return { decision: 'verification_required', reasonCode: 'conflict_unresolved', allowed: [], withheld }
    }
    live = remaining
  }

  const allowed: AllowedPacket[] = []
  let combined: DisclosureDecision = 'no_match'
  let reasonCode = 'no_match'

  for (const row of live) {
    const visibility = classifyVisibility(row.item.visibility)
    let decision = matrixDecision(ctx.trustLevel, visibility)
    let itemReason = `matrix_${ctx.trustLevel}_${visibility}`
    const stepped = applySensitiveStepUp(decision, row.item.sensitiveCategory, ctx.trustLevel)
    if (stepped.reasonCode) {
      decision = stepped.decision
      itemReason = stepped.reasonCode
    }
    combined = stricter(combined, decision)
    if (decision === 'allow') {
      allowed.push({
        itemId: row.item.id,
        version: row.item.version,
        visibility,
        provenance: row.item.provenance,
        content: clipFields(row.item, ctx.query)
      })
      if (reasonCode === 'no_match' || combined === 'allow') reasonCode = itemReason
    } else {
      withheld.push({ itemId: row.item.id, reasonCode: itemReason })
      if (DECISION_STRICTNESS[decision] >= DECISION_STRICTNESS[combined]) reasonCode = itemReason
    }
  }

  if (combined === 'allow' && allowed.length === 0) {
    return { decision: 'no_match', reasonCode: 'no_match', allowed: [], withheld }
  }
  if (combined === 'no_match') {
    return { decision: 'no_match', reasonCode: 'no_match', allowed: [], withheld }
  }
  return { decision: combined, reasonCode, allowed, withheld }
}

export function matrixCells(): Array<{ trust: TrustLevel; visibility: Visibility; decision: DisclosureDecision }> {
  const trusts: TrustLevel[] = ['unverified', 'number_match', 'verified_contact', 'verified_vip']
  const vis: Visibility[] = ['public', 'known_contact', 'vip_only', 'never_disclose']
  const cells = []
  for (const trust of trusts) {
    for (const visibility of vis) cells.push({ trust, visibility, decision: MATRIX[trust][visibility] })
  }
  return cells
}
