import type { IncomingMessage } from 'node:http'
import twilio from 'twilio'

export function publicRequestUrl(publicBaseUrl: string, requestUrl: string): string {
  const base = publicBaseUrl.replace(/\/$/, '')
  const path = requestUrl.startsWith('/') ? requestUrl : `/${requestUrl}`
  return `${base}${path}`
}

export function validateTwilioSignature(input: {
  authToken: string | undefined
  signature: string | string[] | undefined
  url: string
  params?: Record<string, string>
}): boolean {
  if (!input.authToken) return false
  if (typeof input.signature !== 'string' || input.signature.length === 0) return false
  const params = input.params ?? {}
  const candidates = [input.url]
  if (input.url.endsWith('/')) candidates.push(input.url.slice(0, -1))
  else candidates.push(`${input.url}/`)
  return candidates.some((url) => twilio.validateRequest(input.authToken!, input.signature as string, url, params))
}

export type UpgradeRejectReason = 'signature_missing' | 'signature_invalid'

export type UpgradeSignatureResult =
  | { ok: true }
  | { ok: false; reason: UpgradeRejectReason }

/** https → wss, http → ws. Already-websocket URLs are unchanged. */
export function websocketRequestUrl(publicBaseUrl: string, requestUrl: string): string {
  return publicRequestUrl(publicBaseUrl, requestUrl)
    .replace(/^https:/i, 'wss:')
    .replace(/^http:/i, 'ws:')
}

export function validateUpgradeSignature(
  request: IncomingMessage,
  options: { authToken: string | undefined; publicBaseUrl: string }
): UpgradeSignatureResult {
  const signature = request.headers['x-twilio-signature']
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, reason: 'signature_missing' }
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const pathAndSearch = `${url.pathname}${url.search}`
  const httpUrl = publicRequestUrl(options.publicBaseUrl, pathAndSearch)
  const wsUrl = websocketRequestUrl(options.publicBaseUrl, pathAndSearch)
  const accepted = [wsUrl, httpUrl].some((candidate) => validateTwilioSignature({
    authToken: options.authToken,
    signature,
    url: candidate,
    params: {}
  }))
  return accepted ? { ok: true } : { ok: false, reason: 'signature_invalid' }
}

export function expectedTwilioSignature(authToken: string, url: string, params: Record<string, string> = {}): string {
  return twilio.getExpectedTwilioSignature(authToken, url, params)
}
