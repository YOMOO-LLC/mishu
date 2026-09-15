import { describe, expect, it } from 'vitest'
import { shouldHydrateConfig } from './useWebhookSettings'

const emptyConfig = {
  enabled: false,
  url: '',
  events: [],
  hasSecret: false
}

describe('shouldHydrateConfig', () => {
  it('hydrates the form from the first delivered config', () => {
    expect(shouldHydrateConfig(emptyConfig, false, false)).toBe(true)
  })

  it('does not hydrate before config arrives', () => {
    expect(shouldHydrateConfig(undefined, false, false)).toBe(false)
  })

  it('never re-hydrates after the form is already hydrated', () => {
    expect(shouldHydrateConfig(emptyConfig, true, false)).toBe(false)
  })

  it('never overwrites user edits when the config resolves late', () => {
    // The user typed into the form before the async getWebhookConfig() resolved.
    expect(shouldHydrateConfig(emptyConfig, false, true)).toBe(false)
  })

  it('keeps user edits after hydration across refreshes', () => {
    // User edited fields, then a refresh delivered an old/empty config.
    expect(shouldHydrateConfig(emptyConfig, true, true)).toBe(false)
  })
})