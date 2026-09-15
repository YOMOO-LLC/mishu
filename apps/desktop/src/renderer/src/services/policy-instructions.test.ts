import { describe, expect, it } from 'vitest'
import type { CampaignPolicy } from '../../../shared/policy'
import { buildRealtimeInstructions } from './call-brief'
import {
  appendTaskGoal,
  compilePolicyInstructions,
  COPILOT_DELEGATION_RULE,
  COPILOT_END_CALL_RULE,
  COPILOT_TRANSCRIPT_RULE,
  MAX_COMPILED_INSTRUCTIONS
} from './policy-instructions'

const basePolicy = (overrides: Partial<CampaignPolicy> = {}): CampaignPolicy => ({
  persona: 'You are an insurance advisor answering customer questions.',
  allowedTopics: ['auto insurance', 'health insurance'],
  forbiddenTopics: ['investment returns', 'stock picks'],
  forbiddenClaims: ['guaranteed claims', '8% annual return'],
  negativePrompt: 'Do not exaggerate product returns or promise a specific claim amount.',
  recordingDisclosure: true,
  maxCallDurationSec: 600,
  callingHours: { timeZone: 'America/New_York', windows: [] },
  doNotCall: [],
  blockedCallers: [],
  ...overrides
})

const legacyRules = buildRealtimeInstructions('Introduce the auto insurance package')

function legacyRuleLines(): string[] {
  if (!legacyRules) throw new Error('expected buildRealtimeInstructions to return text')
  return legacyRules
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
}

describe('compilePolicyInstructions', () => {
  it('retains every legacy safety rule verbatim (outbound)', () => {
    const out = compilePolicyInstructions(basePolicy(), 'outbound')
    for (const rule of legacyRuleLines()) {
      expect(out).toContain(rule)
    }
  })

  it('retains every legacy safety rule verbatim (inbound)', () => {
    const out = compilePolicyInstructions(basePolicy(), 'inbound')
    for (const rule of legacyRuleLines()) {
      expect(out).toContain(rule)
    }
  })

  it('includes the persona, allowed, forbidden, and negative-prompt sections', () => {
    const out = compilePolicyInstructions(basePolicy(), 'outbound')
    expect(out).toContain('You are an insurance advisor answering customer questions.')
    expect(out).toContain('auto insurance')
    expect(out).toContain('health insurance')
    expect(out).toContain('investment returns')
    expect(out).toContain('Do not exaggerate product returns')
  })

  it('keeps the full script separate from persona and appends a task goal last', () => {
    const compiled = compilePolicyInstructions(
      basePolicy({ persona: 'You are the appointment coordinator.' }),
      'outbound',
      'Follow the complete appointment reminder script.'
    )
    const out = appendTaskGoal(compiled, 'Confirm the appointment time.')

    expect(out.indexOf('Follow the complete appointment reminder script.')).toBeLessThan(
      out.indexOf('You are the appointment coordinator.')
    )
    expect(out.indexOf('You are the appointment coordinator.')).toBeLessThan(
      out.indexOf('Confirm the appointment time.')
    )
  })

  it('does not duplicate a legacy prompt that is also the persona', () => {
    const legacyPrompt = 'Politely confirm the appointment.'
    const out = compilePolicyInstructions(
      basePolicy({ persona: legacyPrompt }),
      'outbound',
      legacyPrompt
    )

    expect(out.split(legacyPrompt)).toHaveLength(2)
    expect(out).toContain('the full script above also serves as the compatible persona')
  })

  it('forbids invented identity when persona is absent', () => {
    const out = compilePolicyInstructions(basePolicy({ persona: '' }), 'outbound')

    expect(out).toContain('do not invent an organization, name, or identity')
    expect(out).toContain('if asked, say you are an automated voice assistant')
  })

  it('limits identity to the configured persona when present', () => {
    const out = compilePolicyInstructions(basePolicy({ persona: 'You are booking assistant Xiao Lin.' }), 'outbound')

    expect(out).toContain('You are booking assistant Xiao Lin.')
    expect(out).toContain('Identity may only come from the persona above')
    expect(out).not.toContain('if asked, say you are an automated voice assistant')
  })

  it('explicitly instructs never to say the forbidden claims', () => {
    const out = compilePolicyInstructions(basePolicy(), 'outbound')
    expect(out).toMatch(/Never say the following/)
    expect(out).toContain('guaranteed claims')
    expect(out).toContain('8% annual return')
  })

  it('includes the recording disclosure and outbound opening when present', () => {
    const out = compilePolicyInstructions(
      basePolicy({ openingOutbound: 'Hello, this is Sunshine Insurance support.' }),
      'outbound'
    )
    expect(out).toMatch(/This call may be recorded/)
    expect(out).toContain('Hello, this is Sunshine Insurance support.')
  })

  it('does not inject an opening section when no opening is configured', () => {
    const out = compilePolicyInstructions(basePolicy({
      opening: undefined,
      openingInbound: undefined,
      openingOutbound: undefined
    }), 'outbound')

    expect(out).not.toContain('Opening line (combine the platform AI disclosure and this line into one natural first turn; do not greet twice, and do not repeat the disclosure if this line already contains it):')
    expect(out).toContain('Recording disclosure')
  })

  it('omits the recording disclosure when disabled', () => {
    const out = compilePolicyInstructions(basePolicy({ recordingDisclosure: false }), 'outbound')
    expect(out).not.toMatch(/This call may be recorded/)
  })

  it('uses the inbound opening for the inbound direction', () => {
    const out = compilePolicyInstructions(
      basePolicy({ openingInbound: 'Hello, thank you for calling Sunshine Insurance. How can I help?' }),
      'inbound'
    )
    expect(out).toContain('Hello, thank you for calling Sunshine Insurance. How can I help?')
    expect(out).not.toContain('outbound-only')
  })

  it('falls back to the shared opening when direction-specific is absent', () => {
    const out = compilePolicyInstructions(basePolicy({ opening: 'Generic opening' }), 'inbound')
    expect(out).toContain('Generic opening')
  })

  it('tells the realtime model to consume system hints in transcript copilot mode', () => {
    const out = compilePolicyInstructions(basePolicy({
      copilot: {
        enabled: true,
        mode: 'transcript',
        prompt: '',
        allowedToolIds: ['lookup_customer'],
        autoExecuteRisks: ['read'],
        maxToolCallsPerTurn: 3,
        mayEndCall: true
      }
    }), 'inbound')

    expect(out).toContain(COPILOT_TRANSCRIPT_RULE)
    expect(out).not.toContain(COPILOT_DELEGATION_RULE)
  })

  it('keeps backend delegation instructions in delegation copilot mode', () => {
    const out = compilePolicyInstructions(basePolicy({
      copilot: {
        enabled: true,
        mode: 'delegation',
        prompt: '',
        allowedToolIds: ['lookup_customer'],
        autoExecuteRisks: ['read'],
        maxToolCallsPerTurn: 3,
        mayEndCall: true
      }
    }), 'inbound')

    expect(out).toContain(COPILOT_DELEGATION_RULE)
    expect(out).not.toContain(COPILOT_TRANSCRIPT_RULE)
  })

  it('omits both copilot instruction variants when copilot is disabled', () => {
    const out = compilePolicyInstructions(basePolicy({
      copilot: {
        enabled: false,
        mode: 'delegation',
        prompt: '',
        allowedToolIds: [],
        autoExecuteRisks: ['read'],
        maxToolCallsPerTurn: 3,
        mayEndCall: true
      }
    }), 'inbound')

    expect(out).not.toContain(COPILOT_DELEGATION_RULE)
    expect(out).not.toContain(COPILOT_TRANSCRIPT_RULE)
  })

  it('includes the end-call instruction only when policy and whitelist both allow it', () => {
    const copilot = {
      enabled: true,
      mode: 'delegation' as const,
      prompt: '',
      allowedToolIds: ['end_call'],
      autoExecuteRisks: ['read'] as const,
      maxToolCallsPerTurn: 3,
      mayEndCall: true
    }
    const enabled = compilePolicyInstructions(basePolicy({
      copilot: { ...copilot, autoExecuteRisks: [...copilot.autoExecuteRisks] }
    }), 'inbound')
    const disabled = compilePolicyInstructions(basePolicy({
      copilot: { ...copilot, mayEndCall: false, autoExecuteRisks: [...copilot.autoExecuteRisks] }
    }), 'inbound')
    const missingWhitelist = compilePolicyInstructions(basePolicy({
      copilot: { ...copilot, allowedToolIds: [], autoExecuteRisks: [...copilot.autoExecuteRisks] }
    }), 'inbound')

    expect(enabled).toContain(COPILOT_END_CALL_RULE)
    expect(disabled).not.toContain(COPILOT_END_CALL_RULE)
    expect(missingWhitelist).not.toContain(COPILOT_END_CALL_RULE)
  })

  it('requires speaking the caller language and defaulting to English', () => {
    const out = compilePolicyInstructions(basePolicy(), 'outbound')
    expect(out).toContain("Speak the caller's language; if it is not yet clear, use English.")
  })

  it('throws when the compiled output is too long', () => {
    const huge = basePolicy({ persona: 'x'.repeat(8000), negativePrompt: 'y'.repeat(4000) })
    expect(() => compilePolicyInstructions(huge, 'outbound')).toThrow(
      `cannot exceed ${MAX_COMPILED_INSTRUCTIONS} characters`
    )
  })
})
