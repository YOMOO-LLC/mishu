export {
  DEFAULT_CAMPAIGN_POLICY,
  DEFAULT_COPILOT_POLICY,
  MAX_CALL_DURATION_BOUND_SEC,
  MAX_CALL_DURATION_SEC,
  MIN_CALL_DURATION_SEC,
  normalizeCampaignPolicy,
  policyFromLegacyPrompt
} from '@mishu/core/policy'
export type {
  CallingHours,
  CallingWindow,
  CampaignCopilotPolicy,
  CampaignPolicy,
  CampaignPolicyNormalizationOptions,
  CopilotToolRisk,
  PolicyDirection
} from '@mishu/core/policy'
