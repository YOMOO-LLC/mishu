import { describe, expect, it } from 'vitest'
import type { TextModelPort } from '@mishu/core/ports'

export type TextModelPortFactory = () => TextModelPort | Promise<TextModelPort>

export interface TextModelPortContractOptions {}

/**
 * Behavioural TextModelPort contract: tenantId required, complete returns outputText.
 * max_tokens must never be forwarded to a provider; that check is adapter-specific
 * (see MockTextModel unit tests and the OpenAI fake-fetch tests), not this suite.
 */
export function describeTextModelPortContract(
  makePort: TextModelPortFactory,
  _options: TextModelPortContractOptions = {}
): void {
  describe('TextModelPort contract', () => {
    it('requires tenantId on complete', async () => {
      const port = await makePort()
      await expect(port.complete({
        tenantId: '',
        input: 'hi'
      })).rejects.toThrow()
    })

    it('returns outputText for a well-formed complete call', async () => {
      const port = await makePort()
      const result = await port.complete({
        tenantId: 'local',
        input: 'hi'
      })
      expect(typeof result.outputText).toBe('string')
    })
  })
}
