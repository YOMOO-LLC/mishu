import { describe, expect, it } from 'vitest'
import {
  compileDefaultSecretaryInstructions,
  compileSecretaryPolicyInstructions,
  DEFAULT_SECRETARY_OPENING,
  DEFAULT_SECRETARY_POLICY,
  MAX_COMPILED_INSTRUCTIONS
} from '@mishu/core/policy'

describe('compileSecretaryPolicyInstructions', () => {
  it('compiles an English inbound persona without Be concise or real identities', () => {
    const text = compileDefaultSecretaryInstructions()
    expect(text).toContain('Opening line (combine the platform AI disclosure and this line into one natural first turn; do not greet twice, and do not repeat the disclosure if this line already contains it):')
    expect(text).toContain(DEFAULT_SECRETARY_OPENING)
    expect(text).toContain('private telephone secretary')
    expect(text).not.toMatch(/Be concise/i)
    expect(DEFAULT_SECRETARY_OPENING).not.toMatch(/\b[A-Z][a-z]+'s AI assistant\b/)
    expect(DEFAULT_SECRETARY_POLICY.persona).not.toMatch(/\b[A-Z][a-z]+'s AI assistant\b/)
    expect(text).not.toMatch(/\+1\d{10}/)
    expect(compileSecretaryPolicyInstructions(DEFAULT_SECRETARY_POLICY)).toBe(text)
  })

  it('throws the length error when output is too long', () => {
    expect(() => compileSecretaryPolicyInstructions({
      ...DEFAULT_SECRETARY_POLICY,
      persona: 'x'.repeat(MAX_COMPILED_INSTRUCTIONS)
    })).toThrow(`Compiled call instructions cannot exceed ${MAX_COMPILED_INSTRUCTIONS} characters`)
  })
})
