import { describe, expect, it } from 'vitest'
import { systemIdGen } from '@mishu/core/clock'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('core IdGen', () => {
  it('systemIdGen.id returns a random UUID', () => {
    const first = systemIdGen.id()
    const second = systemIdGen.id()
    expect(first).toMatch(UUID_V4)
    expect(second).toMatch(UUID_V4)
    expect(first).not.toBe(second)
  })
})
