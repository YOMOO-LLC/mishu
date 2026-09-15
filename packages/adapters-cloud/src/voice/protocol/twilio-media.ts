export const TWILIO_MEDIA_ENCODING = 'audio/x-mulaw'
export const TWILIO_MEDIA_SAMPLE_RATE = 8_000
export const TWILIO_MEDIA_CHANNELS = 1

export const CUSTOM_PARAMETER_WHITELIST = [
  'tenantId',
  'callId',
  'voice',
  'ownerEndpoint'
] as const

export type CustomParameterName = (typeof CUSTOM_PARAMETER_WHITELIST)[number]

export interface TwilioMediaFormat {
  encoding: typeof TWILIO_MEDIA_ENCODING
  sampleRate: typeof TWILIO_MEDIA_SAMPLE_RATE
  channels: typeof TWILIO_MEDIA_CHANNELS
}

export interface TwilioStartMessage {
  event: 'start'
  sequenceNumber: number
  streamSid: string
  start: {
    streamSid: string
    accountSid: string
    callSid: string
    tracks: string[]
    customParameters: Record<string, string>
    mediaFormat: TwilioMediaFormat
  }
}

export interface TwilioMediaMessage {
  event: 'media'
  sequenceNumber: number
  streamSid: string
  media: {
    track: 'inbound' | 'outbound'
    chunk?: string
    timestamp?: string
    payload: string
  }
}

export interface TwilioMarkMessage {
  event: 'mark'
  sequenceNumber: number
  streamSid: string
  mark: { name: string }
}

export interface TwilioStopMessage {
  event: 'stop'
  sequenceNumber: number
  streamSid: string
  stop: { accountSid: string; callSid: string }
}

export interface TwilioConnectedMessage {
  event: 'connected'
  protocol: string
  version: string
}

export interface TwilioDtmfMessage {
  event: 'dtmf'
  sequenceNumber: number
  streamSid: string
  dtmf: { track: string; digit: string }
}

export type TwilioInboundMessage =
  | TwilioConnectedMessage
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioMarkMessage
  | TwilioStopMessage
  | TwilioDtmfMessage

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asSequenceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}

export function whitelistCustomParameters(
  raw: unknown
): Record<string, string> {
  if (!isRecord(raw)) return {}
  const out: Record<string, string> = {}
  for (const key of CUSTOM_PARAMETER_WHITELIST) {
    const value = raw[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

export function isValidMediaFormat(value: unknown): value is TwilioMediaFormat {
  if (!isRecord(value)) return false
  return value.encoding === TWILIO_MEDIA_ENCODING
    && (value.sampleRate === TWILIO_MEDIA_SAMPLE_RATE || value.sampleRate === '8000')
    && (value.channels === TWILIO_MEDIA_CHANNELS || value.channels === '1')
}

export function parseTwilioMessage(raw: unknown): ParseResult<TwilioInboundMessage> {
  if (!isRecord(raw)) return { ok: false, error: 'message must be an object' }
  const event = asString(raw.event)
  if (!event) return { ok: false, error: 'missing event' }

  if (event === 'connected') {
    return {
      ok: true,
      value: {
        event: 'connected',
        protocol: asString(raw.protocol) ?? 'Call',
        version: asString(raw.version) ?? '1.0.0'
      }
    }
  }

  const sequenceNumber = asSequenceNumber(raw.sequenceNumber)
  const streamSid = asString(raw.streamSid)

  if (event === 'start') {
    if (!isRecord(raw.start)) return { ok: false, error: 'start payload missing' }
    const callSid = asString(raw.start.callSid)
    const accountSid = asString(raw.start.accountSid)
    const startStreamSid = asString(raw.start.streamSid) ?? streamSid
    if (!callSid || !accountSid || !startStreamSid) {
      return { ok: false, error: 'start missing streamSid, callSid, or accountSid' }
    }
    if (!isValidMediaFormat(raw.start.mediaFormat)) {
      return { ok: false, error: 'mediaFormat must be audio/x-mulaw 8000 mono' }
    }
    const tracks = Array.isArray(raw.start.tracks)
      ? raw.start.tracks.filter((track): track is string => typeof track === 'string')
      : ['inbound']
    return {
      ok: true,
      value: {
        event: 'start',
        sequenceNumber: sequenceNumber ?? 1,
        streamSid: startStreamSid,
        start: {
          streamSid: startStreamSid,
          accountSid,
          callSid,
          tracks,
          customParameters: whitelistCustomParameters(raw.start.customParameters),
          mediaFormat: {
            encoding: TWILIO_MEDIA_ENCODING,
            sampleRate: TWILIO_MEDIA_SAMPLE_RATE,
            channels: TWILIO_MEDIA_CHANNELS
          }
        }
      }
    }
  }

  if (!streamSid) return { ok: false, error: 'missing streamSid' }
  if (sequenceNumber === undefined && event !== 'connected') {
    return { ok: false, error: 'missing sequenceNumber' }
  }

  if (event === 'media') {
    if (!isRecord(raw.media)) return { ok: false, error: 'media payload missing' }
    const payload = asString(raw.media.payload)
    if (!payload) return { ok: false, error: 'media payload missing' }
    try { Buffer.from(payload, 'base64') } catch { return { ok: false, error: 'media payload is not base64' } }
    const track = raw.media.track === 'outbound' ? 'outbound' : 'inbound'
    return {
      ok: true,
      value: {
        event: 'media',
        sequenceNumber: sequenceNumber!,
        streamSid,
        media: {
          track,
          chunk: asString(raw.media.chunk),
          timestamp: asString(raw.media.timestamp) ?? (typeof raw.media.timestamp === 'number' ? String(raw.media.timestamp) : undefined),
          payload
        }
      }
    }
  }

  if (event === 'mark') {
    if (!isRecord(raw.mark) || !asString(raw.mark.name)) return { ok: false, error: 'mark.name missing' }
    return {
      ok: true,
      value: { event: 'mark', sequenceNumber: sequenceNumber!, streamSid, mark: { name: String(raw.mark.name) } }
    }
  }

  if (event === 'stop') {
    if (!isRecord(raw.stop)) return { ok: false, error: 'stop payload missing' }
    const accountSid = asString(raw.stop.accountSid) ?? 'unknown'
    const callSid = asString(raw.stop.callSid) ?? 'unknown'
    return {
      ok: true,
      value: { event: 'stop', sequenceNumber: sequenceNumber!, streamSid, stop: { accountSid, callSid } }
    }
  }

  if (event === 'dtmf') {
    if (!isRecord(raw.dtmf) || !asString(raw.dtmf.digit)) return { ok: false, error: 'dtmf.digit missing' }
    return {
      ok: true,
      value: {
        event: 'dtmf',
        sequenceNumber: sequenceNumber!,
        streamSid,
        dtmf: { track: asString(raw.dtmf.track) ?? 'inbound_track', digit: String(raw.dtmf.digit) }
      }
    }
  }

  return { ok: false, error: `unsupported event ${event}` }
}

export function extractSequenceNumber(raw: unknown): number | undefined {
  if (!isRecord(raw) || raw.event === 'connected') return undefined
  return asSequenceNumber(raw.sequenceNumber)
}

export function sequenceDelta(previous: number | undefined, next: number): {
  lost: number
  reordered: boolean
} {
  if (previous === undefined) return { lost: 0, reordered: false }
  if (next === previous + 1) return { lost: 0, reordered: false }
  if (next <= previous) return { lost: 0, reordered: true }
  return { lost: next - previous - 1, reordered: false }
}

export function outboundMediaMessage(streamSid: string, payloadBase64: string): string {
  return JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: payloadBase64 }
  })
}

export function outboundMarkMessage(streamSid: string, name: string): string {
  return JSON.stringify({
    event: 'mark',
    streamSid,
    mark: { name }
  })
}

export function outboundClearMessage(streamSid: string): string {
  return JSON.stringify({
    event: 'clear',
    streamSid
  })
}

export function connectStreamTwiml(streamUrl: string, parameters: Record<string, string>): string {
  const params = Object.entries(parameters)
    .filter(([key]) => (CUSTOM_PARAMETER_WHITELIST as readonly string[]).includes(key))
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}" />`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXml(streamUrl)}">${params}</Stream></Connect></Response>`
}

export function conferenceTwiml(conferenceName: string, statusCallback?: string): string {
  const attrs = [
    'startConferenceOnEnter="true"',
    // Both legs use endConferenceOnExit so either hangup tears down the room (strategy A).
    // Safe only because the caller is moved into the conference at most once.
    'endConferenceOnExit="true"',
    'beep="false"',
    'waitUrl=""'
  ]
  if (statusCallback) {
    attrs.push(`statusCallback="${escapeXml(statusCallback)}"`)
    attrs.push('statusCallbackEvent="start join leave end"')
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference ${attrs.join(' ')}>${escapeXml(conferenceName)}</Conference></Dial></Response>`
}

export function ownerGatherTwiml(actionUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="10" method="POST" action="${escapeXml(actionUrl)}"><Say>Press 1 to accept this call.</Say></Gather><Hangup/></Response>`
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
