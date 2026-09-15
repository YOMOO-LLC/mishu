import { describe, expect, it } from 'vitest'
import type { CampaignPolicy } from '../../../shared/policy'
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
    expect(isWithinCallingHours(basePolicy(), new Date(Date.UTC(2026, 8, 13, 3, 0)))).toBe(true)
  })

  it('is within the window on Monday 13:00Z (09:00 local)', () => {
    expect(isWithinCallingHours(monFri, new Date(Date.UTC(2026, 8, 7, 13, 0)))).toBe(true)
  })

  it('is outside the window on Sunday', () => {
    expect(isWithinCallingHours(monFri, new Date(Date.UTC(2026, 8, 13, 13, 0)))).toBe(false)
  })

  it('is outside the window on a weekday before start (Monday 05:00Z = 01:00 local)', () => {
    expect(isWithinCallingHours(monFri, new Date(Date.UTC(2026, 8, 7, 5, 0)))).toBe(false)
  })

  it('handles a cross-midnight window 20:00-02:00 (01:00 local on Tuesday = inside)', () => {
    const overnight = basePolicy({
      callingHours: {
        timeZone: 'America/New_York',
        windows: [{ days: [1, 2, 3, 4, 5], start: '20:00', end: '02:00' }]
      }
    })
    expect(isWithinCallingHours(overnight, new Date(Date.UTC(2026, 8, 8, 5, 0)))).toBe(true)
  })

  it('handles a cross-midnight window 20:00-02:00 (19:00 local on Monday = outside)', () => {
    const overnight = basePolicy({
      callingHours: {
        timeZone: 'America/New_York',
        windows: [{ days: [1, 2, 3, 4, 5], start: '20:00', end: '02:00' }]
      }
    })
    expect(isWithinCallingHours(overnight, new Date(Date.UTC(2026, 8, 7, 23, 0)))).toBe(false)
  })

  it('treats a UTC policy in UTC local time', () => {
    const utc = basePolicy({
      callingHours: {
        timeZone: 'UTC',
        windows: [{ days: [1], start: '09:00', end: '18:00' }]
      }
    })
    expect(isWithinCallingHours(utc, new Date(Date.UTC(2026, 8, 7, 13, 0)))).toBe(true)
  })
})

describe('isDoNotCall', () => {
  it('matches against a normalized peer', () => {
    const policy = basePolicy({ doNotCall: ['+13125550198', '+16465550111'] })
    expect(isDoNotCall(policy, '+1 (312) 555-0198')).toBe(true)
    expect(isDoNotCall(policy, '+13125550198')).toBe(true)
    expect(isDoNotCall(policy, '+14155550199')).toBe(false)
  })
})

describe('matchForbiddenClaims', () => {
  it('matches a forbidden claim inside a sentence (case-insensitive, bilingual)', () => {
    const policy = basePolicy({ forbiddenClaims: ['guaranteed refund', 'one-year free trial', 'Money Back'] })
    expect(matchForbiddenClaims(policy, 'we offer a guaranteed refund, please rest assured')).toEqual(['guaranteed refund'])
    expect(matchForbiddenClaims(policy, 'you can have a one-year free trial now')).toEqual(['one-year free trial'])
    expect(matchForbiddenClaims(policy, 'you get a money back guarantee')).toEqual(['Money Back'])
  })

  it('returns [] for unrelated text', () => {
    const policy = basePolicy({ forbiddenClaims: ['guaranteed refund'] })
    expect(matchForbiddenClaims(policy, 'nice weather today')).toEqual([])
  })

  it('returns multiple matched claims in policy order', () => {
    const policy = basePolicy({ forbiddenClaims: ['guaranteed refund', 'one-year free trial'] })
    expect(matchForbiddenClaims(policy, 'one-year free trial, plus a guaranteed refund')).toEqual([
      'guaranteed refund',
      'one-year free trial'
    ])
  })
})

describe('hasExceededMaxDuration', () => {
  it('is false before the limit is reached', () => {
    const policy = basePolicy({ maxCallDurationSec: 600 })
    expect(hasExceededMaxDuration(policy, 1000, 1000 + 599_000)).toBe(false)
  })

  it('is true once the limit is reached or exceeded', () => {
    const policy = basePolicy({ maxCallDurationSec: 600 })
    expect(hasExceededMaxDuration(policy, 1000, 1000 + 600_000)).toBe(true)
    expect(hasExceededMaxDuration(policy, 1000, 1000 + 700_000)).toBe(true)
  })

  it('is false when there is no answeredAt', () => {
    expect(hasExceededMaxDuration(basePolicy(), 0, 1_000_000)).toBe(false)
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
    expect(evaluateDialGuard(monFri, '+14155550199', new Date(Date.UTC(2026, 8, 7, 13, 0)))).toEqual({
      allowed: true
    })
  })

  it('blocks a DNC peer regardless of time', () => {
    const result = evaluateDialGuard(monFri, '+1 (312) 555-0198', new Date(Date.UTC(2026, 8, 7, 13, 0)))
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toBe('dnc')
      expect(result.message).toMatch(/DNC/)
    }
  })

  it('blocks a peer outside calling hours', () => {
    const result = evaluateDialGuard(monFri, '+14155550199', new Date(Date.UTC(2026, 8, 13, 13, 0)))
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toBe('outside_calling_hours')
      expect(result.message).toMatch(/calling window/)
    }
  })
})

describe('evaluateInboundGuard', () => {
  it('allows a caller that is not blocked', () => {
    expect(evaluateInboundGuard(basePolicy({ blockedCallers: ['+12125550147'] }), '+14155550199'))
      .toEqual({ allowed: true })
  })

  it('blocks a blocked caller', () => {
    const result = evaluateInboundGuard(basePolicy({ blockedCallers: ['+1 (212) 555-0147'] }), '+12125550147')
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toBe('blocked_caller')
      expect(result.message).toMatch(/block list|blocked/i)
    }
  })
})
