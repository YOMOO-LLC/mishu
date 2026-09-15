/** Spike FakeClock stays outside this package; pump() only needs advance(). */
export interface AdvancingClock {
  advance(ms: number): void
}

export function twilioConnected(): Record<string, unknown> {
  return { event: 'connected', protocol: 'Call', version: '1.0.0' }
}

export function twilioStart(options: {
  streamSid: string
  callSid: string
  accountSid?: string
  customParameters?: Record<string, string>
  encoding?: string
  sampleRate?: number
  channels?: number
  sequenceNumber?: number
}): Record<string, unknown> {
  return {
    event: 'start',
    sequenceNumber: String(options.sequenceNumber ?? 1),
    streamSid: options.streamSid,
    start: {
      accountSid: options.accountSid ?? 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      streamSid: options.streamSid,
      callSid: options.callSid,
      tracks: ['inbound'],
      mediaFormat: {
        encoding: options.encoding ?? 'audio/x-mulaw',
        sampleRate: options.sampleRate ?? 8000,
        channels: options.channels ?? 1
      },
      customParameters: options.customParameters ?? {}
    }
  }
}

export function twilioMedia(options: {
  streamSid: string
  payload: string
  sequenceNumber: number
  track?: 'inbound' | 'outbound'
}): Record<string, unknown> {
  return {
    event: 'media',
    sequenceNumber: String(options.sequenceNumber),
    streamSid: options.streamSid,
    media: {
      track: options.track ?? 'inbound',
      chunk: String(options.sequenceNumber),
      timestamp: String(options.sequenceNumber * 20),
      payload: options.payload
    }
  }
}

export function twilioStop(options: { streamSid: string; callSid: string; sequenceNumber: number }): Record<string, unknown> {
  return {
    event: 'stop',
    sequenceNumber: String(options.sequenceNumber),
    streamSid: options.streamSid,
    stop: { accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', callSid: options.callSid }
  }
}

export function twilioMark(options: { streamSid: string; name: string; sequenceNumber: number }): Record<string, unknown> {
  return {
    event: 'mark',
    sequenceNumber: String(options.sequenceNumber),
    streamSid: options.streamSid,
    mark: { name: options.name }
  }
}

export class FakeTwilioMediaClient {
  sequence = 1
  constructor(
    private readonly clock: AdvancingClock,
    private readonly dispatch: (message: Record<string, unknown>) => void
  ) {}

  start(options: Parameters<typeof twilioStart>[0]): void {
    this.dispatch(twilioConnected())
    this.dispatch(twilioStart({ ...options, sequenceNumber: this.sequence++ }))
  }

  media(streamSid: string, payload: string, track: 'inbound' | 'outbound' = 'inbound'): void {
    this.dispatch(twilioMedia({ streamSid, payload, sequenceNumber: this.sequence++, track }))
  }

  pump(streamSid: string, frames: string[], intervalMs = 20): void {
    for (const frame of frames) {
      this.media(streamSid, frame)
      this.clock.advance(intervalMs)
    }
  }

  dropNextSequence(): void {
    this.sequence += 1
  }

  stop(streamSid: string, callSid: string): void {
    this.dispatch(twilioStop({ streamSid, callSid, sequenceNumber: this.sequence++ }))
  }
}
