const E164 = /^\+[1-9]\d{7,14}$/
const HEX_TOKEN = /^[a-f0-9]{64}$/i
const OPENAI_KEY = /\bsk-[a-zA-Z0-9_-]{10,}\b/
const BEARER = /Bearer\s+[A-Za-z0-9._\-+=/]{16,}/i
const SECRET_KEY = /^(apiKey|api_key|accessToken|access_token|refreshToken|clientSecret|authorization|password|secret|token)$/i
const ALLOWED_SECRET_KEYS = new Set([
  'hassecret',
  'tokenfingerprint',
  'idempotencykey',
  'schemaversion'
])

function pathKey(path: string): string {
  const parts = path.split('.')
  return parts[parts.length - 1] ?? ''
}

export function collectSecretLeaks(value: unknown, path = 'root'): string[] {
  const leaks: string[] = []
  visit(value, path, leaks)
  return leaks
}

function visit(value: unknown, path: string, leaks: string[]): void {
  if (typeof value === 'string') {
    if (E164.test(value)) leaks.push(`${path}: unmasked E.164 ${value}`)
    if (HEX_TOKEN.test(value) && SECRET_KEY.test(pathKey(path))) {
      leaks.push(`${path}: 64-hex secret`)
    }
    if (OPENAI_KEY.test(value)) leaks.push(`${path}: api key material`)
    if (BEARER.test(value)) leaks.push(`${path}: bearer token`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, leaks))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const next = `${path}.${key}`
      if (ALLOWED_SECRET_KEYS.has(key.toLowerCase())) continue
      if (SECRET_KEY.test(key) && typeof item === 'string' && item.length >= 16) {
        leaks.push(`${next}: secret-looking field`)
        continue
      }
      visit(item, next, leaks)
    }
  }
}

export function assertNoSecretLeaks(value: unknown, label: string): void {
  const leaks = collectSecretLeaks(value)
  if (leaks.length > 0) {
    throw new Error(`${label} leaked secrets:\n${leaks.join('\n')}`)
  }
}
