import { createHmac, timingSafeEqual } from 'node:crypto'

export function signPayload(secret: string, body: string, timestampMs: number): string {
  return createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex')
}

export function buildSignatureHeader(secret: string, body: string, timestampMs: number): string {
  return `t=${timestampMs},v1=${signPayload(secret, body, timestampMs)}`
}

export function parseSignatureHeader(header: string | undefined): { t: number; v1: string } | null {
  if (typeof header !== 'string') return null
  const tMatch = /(?:^|,\s*)t=(\d+)/.exec(header)
  const v1Match = /(?:^|,\s*)v1=([0-9a-f]{64})/i.exec(header)
  if (!tMatch || !v1Match) return null
  return { t: Number(tMatch[1]), v1: v1Match[1].toLowerCase() }
}

export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  toleranceMs: number
): boolean {
  const parsed = parseSignatureHeader(header)
  if (!parsed) return false
  if (Math.abs(Date.now() - parsed.t) > toleranceMs) return false
  const expected = Buffer.from(signPayload(secret, body, parsed.t), 'utf8')
  const provided = Buffer.from(parsed.v1, 'utf8')
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}