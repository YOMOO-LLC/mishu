export {
  DEFAULT_CAMPAIGN_POLICY,
  DEFAULT_COPILOT_POLICY,
  MAX_CALL_DURATION_BOUND_SEC,
  MAX_CALL_DURATION_SEC,
  MIN_CALL_DURATION_SEC,
  normalizeCampaignPolicy,
  policyFromLegacyPrompt
} from './policy/campaign-policy'
export type {
  CallingHours,
  CallingWindow,
  CampaignCopilotPolicy,
  CampaignPolicy,
  CampaignPolicyNormalizationOptions,
  CopilotToolRisk,
  PolicyDirection
} from './policy/campaign-policy'

export {
  evaluateDialGuard,
  evaluateInboundGuard,
  hasExceededMaxDuration,
  isDoNotCall,
  isWithinCallingHours,
  matchForbiddenClaims
} from './policy/guardrails'
export type { DialGuardResult, InboundGuardResult } from './policy/guardrails'

export {
  appendTaskGoal,
  compilePolicyInstructions,
  COPILOT_DELEGATION_RULE,
  COPILOT_END_CALL_RULE,
  COPILOT_TRANSCRIPT_RULE,
  LEGACY_PREAMBLE,
  LEGACY_RULES,
  MAX_COMPILED_INSTRUCTIONS,
  OPENING_LINE_HEADER,
  PLATFORM_AI_DISCLOSURE_RULE,
  RECORDING_DISCLOSURE_HEADER
} from './policy/instructions'

export {
  buildRealtimeInstructions,
  MAX_CALL_GOAL_LENGTH,
  normalizeCallGoal
} from './policy/call-brief'

export {
  compileDefaultSecretaryInstructions,
  compileSecretaryPolicyInstructions,
  DEFAULT_SECRETARY_OPENING,
  DEFAULT_SECRETARY_PERSONA,
  DEFAULT_SECRETARY_POLICY
} from './policy/secretary-instructions'
export type { SpikeSecretaryPolicy } from './policy/secretary-instructions'
