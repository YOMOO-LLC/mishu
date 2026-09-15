import { describe, expect, it } from 'vitest'
import type { CampaignPolicy } from './campaign-policy'
import {
  evaluateDialGuard,
  evaluateInboundGuard,
  hasExceededMaxDuration,
  isDoNotCall,
  isWithinCallingHours,
  matchForbiddenClaims
} from './guardrails'

const basePolicy = (overrides: Partial<CampaignPolicy> = {}): CampaignPolicy => ({
  persona: '',
  allowedTopics: [],
  forbiddenTopics: [],
  forbiddenClaims: [],
  negativePrompt: '',
  recordingDisclosure: true,
  maxCallDurationSec: 600,
  callingHours: { timeZone: 'America/New_York', windows: [] },
  doNotCall: [],
  blockedCallers: [],
  ...overrides
})

describe('isWithinCallingHours', () => {
  const monFri = basePolicy({
    callingHours: {
      timeZone: 'America/New_York',
      windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }]
    }
  })

  it('treats empty windows as always allowed', () => {
    expect(isWithinCallingHours(basePolicy(), Date.UTC(2026, 8, 13, 3, 0))).toBe(true)
  })

  it('is within the window on Monday 13:00Z (09:00 local)', () => {
    expect(isWithinCallingHours(monFri, Date.UTC(2026, 8, 7, 13, 0))).toBe(true)
  })

  it('is outside the window on Sunday', () => {
    expect(isWithinCallingHours(monFri, Date.UTC(2026, 8, 13, 13, 0))).toBe(false)
  })
})

describe('evaluateDialGuard', () => {
  const monFri = basePolicy({
    doNotCall: ['+13125550198'],
    callingHours: {
      timeZone: 'America/New_York',
      windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }]
    }
  })

  it('allows a non-DNC peer within calling hours', () => {
    expect(evaluateDialGuard(monFri, '+14155550199', Date.UTC(2026, 8, 7, 13, 0))).toEqual({
      allowed: true
    })
  })

  it('blocks a DNC peer regardless of time', () => {
    const result = evaluateDialGuard(monFri, '+1 (312) 555-0198', Date.UTC(2026, 8, 7, 13, 0))
    expect(result).toEqual({
      allowed: false,
      reason: 'dnc',
      message: 'Number +1 (312) 555-0198 is on the DNC list; outbound call refused'
    })
  })

  it('blocks a peer outside calling hours', () => {
    expect(evaluateDialGuard(monFri, '+14155550199', Date.UTC(2026, 8, 13, 13, 0))).toEqual({
      allowed: false,
      reason: 'outside_calling_hours',
      message: 'Outside the allowed calling window; outbound call refused'
    })
  })
})

describe('evaluateInboundGuard', () => {
  it('blocks a blocked caller', () => {
    expect(evaluateInboundGuard(basePolicy({ blockedCallers: ['+1 (212) 555-0147'] }), '+12125550147')).toEqual({
      allowed: false,
      reason: 'blocked_caller',
      message: 'Caller +12125550147 is on the block list; inbound call refused'
    })
  })
})

describe('hasExceededMaxDuration', () => {
  it('is true once the limit is reached', () => {
    const policy = basePolicy({ maxCallDurationSec: 600 })
    expect(hasExceededMaxDuration(policy, 1000, 1000 + 599_000)).toBe(false)
    expect(hasExceededMaxDuration(policy, 1000, 1000 + 600_000)).toBe(true)
    expect(hasExceededMaxDuration(basePolicy(), 0, 1_000_000)).toBe(false)
  })
})

describe('isDoNotCall and matchForbiddenClaims', () => {
  it('matches a normalized peer and case-insensitive claims', () => {
    const policy = basePolicy({
      doNotCall: ['+13125550198'],
      forbiddenClaims: ['guaranteed refund', 'Money Back']
    })
    expect(isDoNotCall(policy, '+1 (312) 555-0198')).toBe(true)
    expect(matchForbiddenClaims(policy, 'you get a money back guarantee')).toEqual(['Money Back'])
  })
})
