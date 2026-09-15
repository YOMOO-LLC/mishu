import { describe, expect, it } from 'vitest'
import { ADAPTERS_CLOUD_STUB_VERSION } from '@mishu/adapters-cloud'
import { ADAPTERS_CLOUD_MODEL_TASK } from '@mishu/adapters-cloud/model'
import { ADAPTERS_CLOUD_TELEPHONY_TASK } from '@mishu/adapters-cloud/telephony'
import { ADAPTERS_CLOUD_VOICE_TASK } from '@mishu/adapters-cloud/voice'

describe('@mishu/adapters-cloud stub', () => {
  it('exports predeclared Wave 4 subpaths', () => {
    expect(ADAPTERS_CLOUD_STUB_VERSION).toBe('mishu-adapters-cloud-0.0.0-stub')
    expect(ADAPTERS_CLOUD_VOICE_TASK).toBe('T12.15')
    expect(ADAPTERS_CLOUD_TELEPHONY_TASK).toBe('T12.16')
    expect(ADAPTERS_CLOUD_MODEL_TASK).toBe('T12.17')
  })
})
