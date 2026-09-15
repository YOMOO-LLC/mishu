const SID_RE = /\b([A-Z]{2})[0-9a-fA-F]{32}\b/g
const E164_RE = /\+[1-9]\d{6,14}/g
const BASE64_AUDIO_RE = /[A-Za-z0-9+/]{80,}={0,2}/g

export function redactSid(sid: string): string {
  if (sid.length < 8) return '…'
  return `${sid.slice(0, 2)}…${sid.slice(-4)}`
}

export function redactPhone(value: string): string {
  if (!value.startsWith('+') || value.length < 8) return '…'
  return `${value.slice(0, 5)}…${value.slice(-2)}`
}

export function redactText(value: string): string {
  return value
    .replace(SID_RE, (_, prefix: string, offset: number, source: string) => {
      const sid = source.slice(offset, offset + 34)
      return `${prefix}…${sid.slice(-4)}`
    })
    .replace(E164_RE, (phone) => redactPhone(phone))
}

export function containsSensitivePayload(value: string): boolean {
  return SID_RE.test(value) || E164_RE.test(value) || BASE64_AUDIO_RE.test(value)
}

export function assertNoSensitiveTelemetry(value: unknown): void {
  const json = JSON.stringify(value)
  SID_RE.lastIndex = 0
  E164_RE.lastIndex = 0
  BASE64_AUDIO_RE.lastIndex = 0
  if (SID_RE.test(json) || E164_RE.test(json) || BASE64_AUDIO_RE.test(json)) {
    throw new Error('telemetry contained unredacted SID, phone, or audio payload')
  }
}
