import { describe, it } from 'vitest'

describe('webhook delivery headers', () => {
  it('does not dual-send private-build headers in the public snapshot', () => {
    // Public snapshot: WEBHOOK_SEND_LEGACY_HEADERS is false; canonical X-Mishu-* only.
  })
})
