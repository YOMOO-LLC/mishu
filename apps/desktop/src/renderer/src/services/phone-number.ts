const E164_PATTERN = /^\+[1-9]\d{6,14}$/

export function normalizePhoneNumber(value: string): string {
  const normalized = value.trim().replace(/[\s().-]/g, '')
  if (!E164_PATTERN.test(normalized)) {
    throw new Error('Enter a valid international phone number, for example +13125550198')
  }
  return normalized
}
