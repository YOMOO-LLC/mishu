import { describe, expect, it } from 'vitest'
import { ADAPTERS_MOCK_STUB_VERSION } from '@mishu/adapters-mock'
import { ADAPTERS_MOCK_CLOCK_TASK } from '@mishu/adapters-mock/clock'
import { ADAPTERS_MOCK_MODEL_TASK } from '@mishu/adapters-mock/model'
import { ADAPTERS_MOCK_TELEPHONY_TASK } from '@mishu/adapters-mock/telephony'
import { ADAPTERS_MOCK_VOICE_TASK } from '@mishu/adapters-mock/voice'

describe('@mishu/adapters-mock stub', () => {
  it('exports predeclared Wave 4 subpaths', () => {
    expect(ADAPTERS_MOCK_STUB_VERSION).toBe('mishu-adapters-mock-0.0.0-stub')
    expect(ADAPTERS_MOCK_CLOCK_TASK).toBe('T12.18')
    expect(ADAPTERS_MOCK_TELEPHONY_TASK).toBe('T12.18')
    expect(ADAPTERS_MOCK_VOICE_TASK).toBe('T12.18')
    expect(ADAPTERS_MOCK_MODEL_TASK).toBe('T12.18')
  })
})
