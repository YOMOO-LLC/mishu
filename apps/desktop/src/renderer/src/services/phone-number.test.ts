import { describe, expect, it } from 'vitest'
import { normalizePhoneNumber } from './phone-number'

describe('normalizePhoneNumber', () => {
  it('converts common visual formatting to E.164', () => {
    expect(normalizePhoneNumber('+1 (312) 555-0198')).toBe('+13125550198')
  })

  it('preserves a compact E.164 number', () => {
    expect(normalizePhoneNumber('+8613800138000')).toBe('+8613800138000')
  })

  it.each(['3125550198', '+01234567', '+1 hello', '+1 23'])('rejects invalid number %s', (value) => {
    expect(() => normalizePhoneNumber(value)).toThrow('Enter a valid international phone number')
  })
})
