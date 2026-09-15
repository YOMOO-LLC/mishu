import { describe, expect, it } from 'vitest'
import { policyFromLegacyPrompt } from '../../../shared/policy'
import { buildRealtimeInstructions, MAX_CALL_GOAL_LENGTH, normalizeCallGoal } from './call-brief'
import { compilePolicyInstructions } from './policy-instructions'

describe('call brief', () => {
  it('builds guarded realtime instructions around the operator goal', () => {
    const instructions = buildRealtimeInstructions('Introduce the spring package to interested customers')

    expect(instructions).toContain('Introduce the spring package to interested customers')
    expect(instructions).toContain('speaking with an AI assistant')
    expect(instructions).toContain('Speak like an experienced human advisor')
    expect(instructions).toContain('answer honestly')
    expect(instructions).toContain('stop promoting immediately')
  })

  it('delegates to compilePolicyInstructions for the same output', () => {
    const goal = 'Introduce the spring package to interested customers'
    expect(buildRealtimeInstructions(goal)).toBe(
      compilePolicyInstructions(policyFromLegacyPrompt(goal), 'outbound')
    )
  })

  it('omits an empty goal', () => {
    expect(normalizeCallGoal('   ')).toBeUndefined()
    expect(buildRealtimeInstructions('')).toBeUndefined()
  })

  it('rejects an oversized goal', () => {
    expect(() => normalizeCallGoal('x'.repeat(MAX_CALL_GOAL_LENGTH + 1))).toThrow(
      `cannot exceed ${MAX_CALL_GOAL_LENGTH} characters`
    )
  })
})
