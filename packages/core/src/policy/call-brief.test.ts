import { describe, expect, it } from 'vitest'
import { policyFromLegacyPrompt } from './campaign-policy'
import { compilePolicyInstructions } from './instructions'
import { buildRealtimeInstructions, MAX_CALL_GOAL_LENGTH, normalizeCallGoal } from './call-brief'

describe('call brief', () => {
  it('builds outbound realtime instructions from a goal', () => {
    const goal = 'Introduce the spring package to interested customers'
    expect(buildRealtimeInstructions(goal)).toBe(
      compilePolicyInstructions(policyFromLegacyPrompt(goal), 'outbound')
    )
    expect(buildRealtimeInstructions(goal)).toContain(goal)
  })

  it('rejects an empty or oversized goal', () => {
    expect(normalizeCallGoal('   ')).toBeUndefined()
    expect(buildRealtimeInstructions('')).toBeUndefined()
    expect(() => normalizeCallGoal('x'.repeat(MAX_CALL_GOAL_LENGTH + 1))).toThrow(
      `Call goal cannot exceed ${MAX_CALL_GOAL_LENGTH} characters`
    )
  })
})
