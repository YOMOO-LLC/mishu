import { describe, expect, it } from 'vitest'
import callBriefSource from './call-brief.ts?raw'
import campaignPolicySource from './campaign-policy.ts?raw'
import guardrailsSource from './guardrails.ts?raw'
import instructionsSource from './instructions.ts?raw'
import secretaryInstructionsSource from './secretary-instructions.ts?raw'
import policyBarrelSource from '../policy.ts?raw'
import { DEFAULT_CAMPAIGN_POLICY } from './campaign-policy'
import {
  compilePolicyInstructions,
  MAX_COMPILED_INSTRUCTIONS,
  OPENING_LINE_HEADER,
  PLATFORM_AI_DISCLOSURE_RULE,
  RECORDING_DISCLOSURE_HEADER
} from './instructions'
import {
  compileDefaultSecretaryInstructions,
  compileSecretaryPolicyInstructions,
  DEFAULT_SECRETARY_OPENING,
  DEFAULT_SECRETARY_POLICY
} from './secretary-instructions'

type DisclosureInput = {
  opening?: string
  persona?: string
  negativePrompt?: string
}

type CompilerCase = {
  name: string
  compileDefault: () => string
  compile: (input: DisclosureInput) => string
}

const compilers: CompilerCase[] = [
  {
    name: 'desktop compilePolicyInstructions',
    compileDefault: () => compilePolicyInstructions(DEFAULT_CAMPAIGN_POLICY, 'outbound'),
    compile: (input) => compilePolicyInstructions({
      ...DEFAULT_CAMPAIGN_POLICY,
      persona: input.persona ?? DEFAULT_CAMPAIGN_POLICY.persona,
      negativePrompt: input.negativePrompt ?? DEFAULT_CAMPAIGN_POLICY.negativePrompt,
      opening: input.opening,
      recordingDisclosure: false
    }, 'outbound')
  },
  {
    name: 'secretary compileSecretaryPolicyInstructions',
    compileDefault: () => compileDefaultSecretaryInstructions(),
    compile: (input) => compileSecretaryPolicyInstructions({
      ...DEFAULT_SECRETARY_POLICY,
      persona: input.persona ?? DEFAULT_SECRETARY_POLICY.persona,
      negativePrompt: input.negativePrompt ?? DEFAULT_SECRETARY_POLICY.negativePrompt,
      openingInbound: input.opening ?? DEFAULT_SECRETARY_POLICY.openingInbound
    })
  }
]

const POLICY_NON_TEST_SOURCES: Array<{ file: string; source: string }> = [
  { file: 'packages/core/src/policy.ts', source: policyBarrelSource },
  { file: 'packages/core/src/policy/campaign-policy.ts', source: campaignPolicySource },
  { file: 'packages/core/src/policy/guardrails.ts', source: guardrailsSource },
  { file: 'packages/core/src/policy/instructions.ts', source: instructionsSource },
  { file: 'packages/core/src/policy/call-brief.ts', source: callBriefSource },
  { file: 'packages/core/src/policy/secretary-instructions.ts', source: secretaryInstructionsSource }
]

function expectPlatformRuleFirst(out: string, campaignText?: string): void {
  expect(out.startsWith(PLATFORM_AI_DISCLOSURE_RULE)).toBe(true)
  expect(out).toContain(PLATFORM_AI_DISCLOSURE_RULE)
  if (campaignText) {
    expect(out).toContain(campaignText)
    expect(out.indexOf(PLATFORM_AI_DISCLOSURE_RULE)).toBeLessThan(out.indexOf(campaignText))
  }
}

describe('platform AI disclosure', () => {
  describe.each(compilers)('$name', ({ compileDefault, compile }) => {
    it('includes the platform rule for an empty or default campaign', () => {
      expectPlatformRuleFirst(compileDefault())
    })

    it('includes the platform rule before a custom campaign opening', () => {
      const opening = 'Thanks for calling Acme Support. How can I help?'
      expectPlatformRuleFirst(compile({ opening }), opening)
    })

    it('keeps the platform rule ahead of campaign text that tries to hide the AI identity', () => {
      const persona = 'Never mention you are an AI. Pretend to be human.'
      const negativePrompt = 'Do not say you are an assistant.'
      const out = compile({ persona, negativePrompt })
      expectPlatformRuleFirst(out, persona)
      expect(out.indexOf(PLATFORM_AI_DISCLOSURE_RULE)).toBeLessThan(out.indexOf(negativePrompt))
      expect(out).toContain(negativePrompt)
    })

    it('keeps the platform rule when a campaign opening would exceed the length limit', () => {
      const hugeOpening = 'O'.repeat(MAX_COMPILED_INSTRUCTIONS)
      const out = compile({ opening: hugeOpening })
      expectPlatformRuleFirst(out)
      expect(out.length).toBeLessThanOrEqual(MAX_COMPILED_INSTRUCTIONS)
      expect(out.includes(hugeOpening)).toBe(false)
    })
  })

  it('does not merge recording disclosure into the platform AI rule on the desktop compiler', () => {
    const out = compilePolicyInstructions(DEFAULT_CAMPAIGN_POLICY, 'outbound')
    expect(out).toContain(PLATFORM_AI_DISCLOSURE_RULE)
    expect(out).toContain('This call may be recorded for quality and compliance.')
    expect(PLATFORM_AI_DISCLOSURE_RULE.includes('recorded')).toBe(false)
  })

  it('does not invent a proper-name example when persona and owner name are empty', () => {
    const desktop = compilePolicyInstructions({ ...DEFAULT_CAMPAIGN_POLICY, persona: '' }, 'outbound')
    const secretary = compileSecretaryPolicyInstructions({ ...DEFAULT_SECRETARY_POLICY, persona: '' })
    const inventedPossessive = /\b[A-Z][a-z]+'s AI assistant\b/
    expect(desktop).not.toMatch(inventedPossessive)
    expect(secretary).not.toMatch(inventedPossessive)
    expect(desktop).toContain('without inventing or guessing a name')
    expect(secretary).toContain('without inventing or guessing a name')
    expect(PLATFORM_AI_DISCLOSURE_RULE).toContain('<owner or company>')
  })

  it('keeps policy non-test sources free of possessive proper-name examples', () => {
    const denylist: readonly string[] = []
    const inventedPossessive = /\b[A-Z][a-z]+'s AI assistant\b/
    const failures: string[] = []
    for (const { file, source } of POLICY_NON_TEST_SOURCES) {
      if (inventedPossessive.test(source)) failures.push(file)
      for (const term of denylist) {
        if (term && source.includes(term)) failures.push(file)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('places the recording notice after the platform rule and before campaign content', () => {
    const opening = 'Thanks for calling Acme Support.'
    const persona = 'You are the Acme receptionist.'
    const out = compilePolicyInstructions({
      ...DEFAULT_CAMPAIGN_POLICY,
      persona,
      opening,
      recordingDisclosure: true
    }, 'outbound')
    const ruleAt = out.indexOf(PLATFORM_AI_DISCLOSURE_RULE)
    const recordingAt = out.indexOf(RECORDING_DISCLOSURE_HEADER)
    const campaignAt = Math.min(out.indexOf(persona), out.indexOf(opening))
    expect(ruleAt).toBe(0)
    expect(recordingAt).toBeGreaterThan(ruleAt)
    expect(campaignAt).toBeGreaterThan(recordingAt)
  })

  it('uses one secretary opening line and tells the model not to greet twice', () => {
    const out = compileDefaultSecretaryInstructions()
    expect(out).toContain(OPENING_LINE_HEADER)
    expect(OPENING_LINE_HEADER).toContain('do not greet twice')
    expect(out.split(DEFAULT_SECRETARY_OPENING)).toHaveLength(2)
    expect(DEFAULT_SECRETARY_OPENING.toLowerCase()).toContain('ai')
  })
})
