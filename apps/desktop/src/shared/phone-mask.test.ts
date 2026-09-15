import { describe, expect, it } from 'vitest'
import { maskPhoneNumber } from './phone-mask'

describe('maskPhoneNumber', () => {
  it('keeps +, country-code first digit and last 4 digits, strips spaces', () => {
    expect(maskPhoneNumber('+1 415 555 0142')).toBe('+1******0142')
    expect(maskPhoneNumber('+13125550198')).toBe('+1******0198')
    expect(maskPhoneNumber('+44 20 7946 0958')).toBe('+4*******0958')
  })

  it('strips parentheses and hyphens too', () => {
    expect(maskPhoneNumber('+1 (415) 555-0142')).toBe('+1******0142')
    expect(maskPhoneNumber('+86 10-8888-6666')).toBe('+8*******6666')
  })

  it('handles short numbers without over-masking', () => {
    expect(maskPhoneNumber('+1555')).toBe('+1555')
    expect(maskPhoneNumber('+12025550198')).toBe('+1******0198')
  })
})