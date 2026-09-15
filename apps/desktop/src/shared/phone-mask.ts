export function maskPhoneNumber(peer: string): string {
  const normalized = peer.replace(/[\s()-]/g, '')
  const plus = normalized.startsWith('+') ? '+' : ''
  const digits = normalized.replace(/\D/g, '')
  if (digits.length <= 5) return `${plus}${digits}`
  const first = digits[0]
  const lastFour = digits.slice(-4)
  const middle = '*'.repeat(digits.length - 5)
  return `${plus}${first}${middle}${lastFour}`
}