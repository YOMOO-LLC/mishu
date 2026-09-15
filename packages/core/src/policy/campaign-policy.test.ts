import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAMPAIGN_POLICY,
  DEFAULT_COPILOT_POLICY,
  MAX_CALL_DURATION_SEC,
  normalizeCampaignPolicy,
  policyFromLegacyPrompt
} from './campaign-policy'

describe('normalizeCampaignPolicy', () => {
  it('fills defaults from an empty object', () => {
    const p = normalizeCampaignPolicy({})
    expect(p).toEqual(DEFAULT_CAMPAIGN_POLICY)
    expect(p.maxCallDurationSec).toBe(MAX_CALL_DURATION_SEC)
  })

  it('truncates oversized fields and reports warnings', () => {
    const warnings: string[] = []
    const p = normalizeCampaignPolicy(
      {
        persona: 'x'.repeat(8001),
        forbiddenClaims: ['x'.repeat(201)],
        allowedTopics: Array.from({ length: 101 }, () => 't')
      },
      { onWarning: (warning) => warnings.push(warning) }
    )
    expect(p.persona).toHaveLength(8000)
    expect(p.forbiddenClaims[0]).toHaveLength(200)
    expect(p.allowedTopics).toHaveLength(100)
    expect(warnings.some((warning) => warning.includes('persona'))).toBe(true)
    expect(warnings.some((warning) => warning.includes('forbiddenClaims[0]'))).toBe(true)
    expect(warnings.some((warning) => warning.includes('allowedTopics'))).toBe(true)
  })

  it('normalizes and dedupes E.164 doNotCall numbers', () => {
    const p = normalizeCampaignPolicy({
      doNotCall: ['+1 (312) 555-0198', '+13125550198', 'not-a-number']
    })
    expect(p.doNotCall).toEqual(['+13125550198'])
  })

  it('falls back to UTC for an invalid timezone', () => {
    const warnings: string[] = []
    const p = normalizeCampaignPolicy(
      { callingHours: { timeZone: 'Not/AZone', windows: [] } },
      { onWarning: (warning) => warnings.push(warning) }
    )
    expect(p.callingHours).toEqual({ timeZone: 'UTC', windows: [] })
    expect(warnings).toEqual([expect.stringContaining('callingHours.timeZone')])
  })

  it('rejects a non-object input', () => {
    expect(() => normalizeCampaignPolicy(null)).toThrow('Campaign policy config is invalid')
  })

  it('normalizes copilot while ignoring external-write auto-execute', () => {
    const p = normalizeCampaignPolicy({
      copilot: {
        enabled: true,
        mode: 'delegation',
        allowedToolIds: ['crm.lookup'],
        autoExecuteRisks: ['read', 'external-write', 'draft-write'],
        maxToolCallsPerTurn: 51
      }
    })
    expect(p.copilot).toMatchObject({
      enabled: true,
      mode: 'delegation',
      allowedToolIds: ['crm.lookup'],
      autoExecuteRisks: ['read', 'draft-write'],
      maxToolCallsPerTurn: 10
    })
  })
})

describe('policyFromLegacyPrompt', () => {
  it('round-trips a prompt into persona and default policy', () => {
    const prompt = 'You are a real-estate advisor answering inbound questions.'
    const p = policyFromLegacyPrompt(prompt)
    expect(p.persona).toBe(prompt)
    expect(p.copilot).toEqual(DEFAULT_COPILOT_POLICY)
    expect(policyFromLegacyPrompt('').persona).toBe(DEFAULT_CAMPAIGN_POLICY.persona)
  })
})
