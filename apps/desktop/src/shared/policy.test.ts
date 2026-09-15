import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAMPAIGN_POLICY,
  DEFAULT_COPILOT_POLICY,
  MAX_CALL_DURATION_SEC,
  normalizeCampaignPolicy,
  policyFromLegacyPrompt
} from './policy'

describe('normalizeCampaignPolicy', () => {
  it('fills defaults from an empty object', () => {
    const p = normalizeCampaignPolicy({})
    expect(p.persona).toBe('')
    expect(p.allowedTopics).toEqual([])
    expect(p.forbiddenTopics).toEqual([])
    expect(p.forbiddenClaims).toEqual([])
    expect(p.negativePrompt).toBe('')
    expect(p.recordingDisclosure).toBe(true)
    expect(p.maxCallDurationSec).toBe(600)
    expect(p.callingHours.windows).toEqual([])
    expect(p.doNotCall).toEqual([])
    expect(p.blockedCallers).toEqual([])
    expect(p.copilot).toEqual(DEFAULT_COPILOT_POLICY)
    expect(p).not.toHaveProperty('opening')
    expect(p).not.toHaveProperty('openingInbound')
    expect(p).not.toHaveProperty('openingOutbound')
  })

  it('preserves provided scalar fields and trims persona', () => {
    const p = normalizeCampaignPolicy({
      persona: '  You are a bank support representative  ',
      maxCallDurationSec: 1200,
      recordingDisclosure: false
    })
    expect(p.persona).toBe('You are a bank support representative')
    expect(p.maxCallDurationSec).toBe(1200)
    expect(p.recordingDisclosure).toBe(false)
  })

  it('truncates a persona over 8000 characters and warns for only that field', () => {
    const warnings: string[] = []
    const p = normalizeCampaignPolicy(
      { persona: 'x'.repeat(8001), forbiddenTopics: ['keep'] },
      { onWarning: (warning) => warnings.push(warning) }
    )
    expect(p.persona).toHaveLength(8000)
    expect(p.forbiddenTopics).toEqual(['keep'])
    expect(warnings).toEqual([expect.stringContaining('persona')])
  })

  it('truncates an oversized topic and an oversized claims array', () => {
    const warnings: string[] = []
    const p = normalizeCampaignPolicy({
      forbiddenClaims: ['x'.repeat(201)],
      allowedTopics: Array.from({ length: 101 }, () => 't')
    }, { onWarning: (warning) => warnings.push(warning) })
    expect(p.forbiddenClaims[0]).toHaveLength(200)
    expect(p.allowedTopics).toHaveLength(100)
    expect(warnings.some((warning) => warning.includes('forbiddenClaims[0]'))).toBe(true)
    expect(warnings.some((warning) => warning.includes('allowedTopics'))).toBe(true)
  })

  it('truncates a negativePrompt over 4000 characters', () => {
    const warnings: string[] = []
    const p = normalizeCampaignPolicy(
      { negativePrompt: 'x'.repeat(4001) },
      { onWarning: (warning) => warnings.push(warning) }
    )
    expect(p.negativePrompt).toHaveLength(4000)
    expect(warnings).toEqual([expect.stringContaining('negativePrompt')])
  })

  it('normalizes, dedupes, and validates doNotCall numbers', () => {
    const p = normalizeCampaignPolicy({
      doNotCall: ['+1 (312) 555-0198', '+13125550198', '+1 646-555-0111', 'not-a-number']
    })
    expect(p.doNotCall).toEqual(['+13125550198', '+16465550111'])
  })

  it('normalizes, dedupes, and validates blockedCallers numbers', () => {
    const p = normalizeCampaignPolicy({
      blockedCallers: ['+1 (212) 555-0147', '+12125550147', 'garbage']
    })
    expect(p.blockedCallers).toEqual(['+12125550147'])
  })

  it('accepts a valid timezone and normalizes a valid window', () => {
    const p = normalizeCampaignPolicy({
      callingHours: {
        timeZone: 'America/New_York',
        windows: [{ days: [1, 2], start: '09:00', end: '18:00' }]
      }
    })
    expect(p.callingHours.timeZone).toBe('America/New_York')
    expect(p.callingHours.windows[0]).toEqual({ days: [1, 2], start: '09:00', end: '18:00' })
  })

  it('uses UTC and warns for an invalid timezone', () => {
    const warnings: string[] = []
    const p = normalizeCampaignPolicy(
      { callingHours: { timeZone: 'Not/AZone', windows: [] } },
      { onWarning: (warning) => warnings.push(warning) }
    )
    expect(p.callingHours).toEqual({ timeZone: 'UTC', windows: [] })
    expect(warnings).toEqual([expect.stringContaining('callingHours.timeZone')])
  })

  it('drops malformed windows and identifies their invalid fields', () => {
    const warnings: string[] = []
    const p = normalizeCampaignPolicy({
      callingHours: {
        timeZone: 'UTC',
        windows: [
          { days: [1], start: '25:00', end: '18:00' },
          { days: [8], start: '09:00', end: '18:00' }
        ]
      }
    }, { onWarning: (warning) => warnings.push(warning) })
    expect(p.callingHours.windows).toEqual([])
    expect(warnings[0]).toContain('callingHours.windows[0].start')
    expect(warnings[1]).toContain('callingHours.windows[1].days')
  })

  it('rejects a non-object input', () => {
    expect(() => normalizeCampaignPolicy(null)).toThrow(/invalid/)
    expect(() => normalizeCampaignPolicy('x')).toThrow(/invalid/)
  })

  it('normalizes copilot configuration while keeping external writes approval-only', () => {
    const p = normalizeCampaignPolicy({
      copilot: {
        enabled: true,
        mode: 'delegation',
        prompt: '  Look up the caller and return brief facts  ',
        allowedToolIds: [' crm.lookup ', '', 'crm.note'],
        autoExecuteRisks: ['read', 'external-write', 'draft-write', 'unknown'],
        maxToolCallsPerTurn: 5
      }
    })

    expect(p.copilot).toEqual({
      enabled: true,
      mode: 'delegation',
      prompt: 'Look up the caller and return brief facts',
      allowedToolIds: ['crm.lookup', 'crm.note'],
      autoExecuteRisks: ['read', 'draft-write'],
      maxToolCallsPerTurn: 5,
      mayEndCall: true
    })
  })

  it('allows campaign policy to disable end_call while defaulting it to enabled', () => {
    expect(normalizeCampaignPolicy({}).copilot?.mayEndCall).toBe(true)
    expect(normalizeCampaignPolicy({ copilot: { mayEndCall: false } }).copilot?.mayEndCall).toBe(false)
  })

  it('accepts an old policy without copilot and clamps an invalid tool limit without dropping other fields', () => {
    const oldPolicy = { ...DEFAULT_CAMPAIGN_POLICY }
    delete oldPolicy.copilot
    expect(normalizeCampaignPolicy(oldPolicy).copilot).toEqual(DEFAULT_COPILOT_POLICY)
    const malformedWarnings: string[] = []
    expect(normalizeCampaignPolicy(
      { copilot: 'on' },
      { onWarning: (warning) => malformedWarnings.push(warning) }
    ).copilot).toEqual(DEFAULT_COPILOT_POLICY)
    expect(malformedWarnings).toEqual([expect.stringContaining('copilot')])
    expect(normalizeCampaignPolicy({ copilot: { maxToolCallsPerTurn: 1 } }).copilot?.maxToolCallsPerTurn).toBe(1)
    expect(normalizeCampaignPolicy({ copilot: { maxToolCallsPerTurn: 10 } }).copilot?.maxToolCallsPerTurn).toBe(10)
    const warnings: string[] = []
    const normalized = normalizeCampaignPolicy({
      forbiddenTopics: ['protected topic'],
      maxCallDurationSec: 300,
      copilot: { enabled: true, maxToolCallsPerTurn: 51 }
    }, { onWarning: (warning) => warnings.push(warning) })
    expect(normalized.forbiddenTopics).toEqual(['protected topic'])
    expect(normalized.maxCallDurationSec).toBe(300)
    expect(normalized.copilot).toMatchObject({ enabled: true, maxToolCallsPerTurn: 10 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('copilot.maxToolCallsPerTurn')
    expect(normalizeCampaignPolicy({ copilot: { enabled: true } }).copilot?.mode).toBe('transcript')
    const modeWarnings: string[] = []
    expect(normalizeCampaignPolicy(
      { copilot: { mode: 'rules' } },
      { onWarning: (warning) => modeWarnings.push(warning) }
    ).copilot?.mode).toBe('transcript')
    expect(modeWarnings).toEqual([expect.stringContaining('copilot.mode')])
  })

  it('uses the default for a non-numeric tool limit and ignores unknown fields', () => {
    const warnings: string[] = []
    const p = normalizeCampaignPolicy({
      persona: 'Kept persona',
      futurePolicyField: { enabled: true },
      copilot: { maxToolCallsPerTurn: 'many', futureCopilotField: true }
    }, { onWarning: (warning) => warnings.push(warning) })

    expect(p.persona).toBe('Kept persona')
    expect(p.copilot?.maxToolCallsPerTurn).toBe(DEFAULT_COPILOT_POLICY.maxToolCallsPerTurn)
    expect(warnings).toEqual([
      expect.stringContaining('copilot.maxToolCallsPerTurn')
    ])
  })

  it('fills every missing field without warning', () => {
    const warnings: string[] = []
    expect(normalizeCampaignPolicy({}, { onWarning: (warning) => warnings.push(warning) }))
      .toEqual(DEFAULT_CAMPAIGN_POLICY)
    expect(warnings).toEqual([])
  })
})

describe('policyFromLegacyPrompt', () => {
  it('round-trips a single-field prompt into the persona', () => {
    const prompt = 'You are a real-estate advisor answering inbound questions.'
    const p = policyFromLegacyPrompt(prompt)
    expect(p.persona).toBe(prompt)
    expect(normalizeCampaignPolicy(p).persona).toBe(prompt)
    expect(p.recordingDisclosure).toBe(true)
  })

  it('keeps the default persona when the prompt is empty', () => {
    const p = policyFromLegacyPrompt('')
    expect(p.persona).toBe(DEFAULT_CAMPAIGN_POLICY.persona)
  })
})

describe('MAX_CALL_DURATION_SEC', () => {
  it('is 600', () => {
    expect(MAX_CALL_DURATION_SEC).toBe(600)
  })
})
