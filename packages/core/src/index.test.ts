import { describe, expect, it } from 'vitest'
import { CORE_STUB_VERSION } from '@mishu/core'

describe('@mishu/core stub', () => {
  it('exports a version constant for main-process bundle probes', () => {
    expect(CORE_STUB_VERSION).toBe('mishu-core-0.0.0-stub')
  })
})
