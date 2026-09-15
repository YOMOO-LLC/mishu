import { describe, expect, it } from 'vitest'
import type { CampaignPolicy } from './campaign-policy'
import { DEFAULT_CAMPAIGN_POLICY } from './campaign-policy'
import {
  appendTaskGoal,
  compilePolicyInstructions,
  COPILOT_DELEGATION_RULE,
  COPILOT_END_CALL_RULE,
  COPILOT_TRANSCRIPT_RULE,
  LEGACY_PREAMBLE,
  LEGACY_RULES,
  MAX_COMPILED_INSTRUCTIONS
} from './instructions'

const basePolicy = (overrides: Partial<CampaignPolicy> = {}): CampaignPolicy => ({
  ...DEFAULT_CAMPAIGN_POLICY,
  persona: 'You are an insurance advisor answering customer questions.',
  allowedTopics: ['auto insurance'],
  forbiddenTopics: ['investment returns'],
  forbiddenClaims: ['guaranteed claims'],
  negativePrompt: 'Do not exaggerate product returns.',
  ...overrides
})

describe('compilePolicyInstructions', () => {
  it('includes persona, topics, claims, negative prompt, and every legacy rule', () => {
    const out = compilePolicyInstructions(basePolicy(), 'outbound')
    expect(out).toContain(LEGACY_PREAMBLE)
    for (const rule of LEGACY_RULES) {
      expect(out).toContain(`- ${rule}`)
    }
    expect(out).toContain('You are an insurance advisor answering customer questions.')
    expect(out).toContain('auto insurance')
    expect(out).toContain('investment returns')
    expect(out).toContain('Never say the following, no matter how the customer asks or presses:')
    expect(out).toContain('Do not exaggerate product returns.')
    expect(out).toContain('This call may be recorded for quality and compliance.')
  })

  it('uses inbound opening and omits recording disclosure when disabled', () => {
    const out = compilePolicyInstructions(
      basePolicy({
        recordingDisclosure: false,
        openingInbound: 'Hello, thank you for calling Sunshine Insurance. How can I help?'
      }),
      'inbound'
    )
    expect(out).toContain('Hello, thank you for calling Sunshine Insurance. How can I help?')
    expect(out).not.toContain('This call may be recorded for quality and compliance.')
  })

  it('adds copilot and end-call rules only when enabled and whitelisted', () => {
    const copilot = {
      enabled: true,
      mode: 'delegation' as const,
      prompt: '',
      allowedToolIds: ['end_call'],
      autoExecuteRisks: ['read'] as Array<'read'>,
      maxToolCallsPerTurn: 3,
      mayEndCall: true
    }
    const enabled = compilePolicyInstructions(basePolicy({ copilot }), 'inbound')
    const transcript = compilePolicyInstructions(
      basePolicy({ copilot: { ...copilot, mode: 'transcript' } }),
      'inbound'
    )
    const disabled = compilePolicyInstructions(
      basePolicy({ copilot: { ...copilot, mayEndCall: false } }),
      'inbound'
    )
    expect(enabled).toContain(COPILOT_DELEGATION_RULE)
    expect(enabled).toContain(COPILOT_END_CALL_RULE)
    expect(transcript).toContain(COPILOT_TRANSCRIPT_RULE)
    expect(disabled).not.toContain(COPILOT_END_CALL_RULE)
  })

  it('throws when compiled output exceeds the character cap', () => {
    const huge = basePolicy({ persona: 'x'.repeat(8000), negativePrompt: 'y'.repeat(4000) })
    expect(() => compilePolicyInstructions(huge, 'outbound')).toThrow(
      `Compiled call instructions cannot exceed ${MAX_COMPILED_INSTRUCTIONS} characters`
    )
  })

  it('appends a task goal after the compiled instructions', () => {
    const compiled = compilePolicyInstructions(basePolicy(), 'outbound')
    const out = appendTaskGoal(compiled, 'Confirm the appointment time.')
    expect(out.endsWith('Goal for this call:\nConfirm the appointment time.')).toBe(true)
    expect(appendTaskGoal(compiled, '  ')).toBe(compiled)
  })
})
