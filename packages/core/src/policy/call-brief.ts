import { policyFromLegacyPrompt } from './campaign-policy'
import { compilePolicyInstructions } from './instructions'

export const MAX_CALL_GOAL_LENGTH = 8_000

export function normalizeCallGoal(value: string): string | undefined {
  const goal = value.trim()
  if (!goal) return undefined
  if (goal.length > MAX_CALL_GOAL_LENGTH) {
    throw new Error(`Call goal cannot exceed ${MAX_CALL_GOAL_LENGTH} characters`)
  }
  return goal
}

export function buildRealtimeInstructions(value: string): string | undefined {
  const goal = normalizeCallGoal(value)
  if (!goal) return undefined
  return compilePolicyInstructions(policyFromLegacyPrompt(goal), 'outbound')
}
