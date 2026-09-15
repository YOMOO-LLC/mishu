import type { CampaignPolicy } from '../../../shared/policy'
import {
  evaluateDialGuard as evaluateDialGuardAt,
  evaluateInboundGuard as evaluateInboundGuardCore,
  hasExceededMaxDuration as hasExceededMaxDurationCore,
  isDoNotCall,
  isWithinCallingHours as isWithinCallingHoursAt,
  matchForbiddenClaims
} from '@mishu/core/policy'
import type { DialGuardResult, InboundGuardResult } from '@mishu/core/policy'

export { isDoNotCall, matchForbiddenClaims }
export type { DialGuardResult, InboundGuardResult }

export function isWithinCallingHours(policy: CampaignPolicy, at: Date): boolean {
  return isWithinCallingHoursAt(policy, at.getTime())
}

export function hasExceededMaxDuration(
  policy: CampaignPolicy,
  answeredAt: number,
  now: number
): boolean {
  return hasExceededMaxDurationCore(policy, answeredAt, now)
}

export function evaluateDialGuard(
  policy: CampaignPolicy,
  peer: string,
  at: Date
): DialGuardResult {
  return evaluateDialGuardAt(policy, peer, at.getTime())
}

export function evaluateInboundGuard(
  policy: CampaignPolicy,
  peer: string
): InboundGuardResult {
  return evaluateInboundGuardCore(policy, peer)
}
