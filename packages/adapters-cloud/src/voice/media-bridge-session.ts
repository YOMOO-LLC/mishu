import { systemClock, type Clock } from '@mishu/core/clock'
import {
  type VoiceSessionEvent,
  type VoiceSessionPort
} from '@mishu/core/ports'
import { normalizeTenantId } from '@mishu/core/tenant'
import { FakeGptLiveSession } from '../testing/fake-gpt-live.js'
import { FakeTwilioMediaClient } from '../testing/fake-twilio-media.js'
import { MediaBridge } from './media-bridge.js'
import { parseGptLiveServerEvent, type GptLiveClientEvent } from './protocol/gpt-live.js'
import type { LiveAudioFormatName } from './protocol/audio-transcode.js'
import { synthesizeToneMulaw } from './protocol/mulaw.js'

const STREAM = 'MZaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CALL_SID = 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function toLiveAudioFormat(format: 'pcmu-8k' | 'pcm24k'): LiveAudioFormatName {
  return format === 'pcm24k' ? 'pcm24k' : 'pcmu'
}

/**
 * VoiceSessionPort over MediaBridge. Framed audio, Twilio clear, and GPT-Live
 * events stay inside the adapter; core never sees bytes or vendor frames.
 */
export class MediaBridgeVoiceSessionAdapter implements VoiceSessionPort {
  readonly capabilities = {
    sdp: false,
    websocketFrames: true,
    localOnly: false,
    fallbackVoicemail: true,
    discardPlayback: true
  } as const

  readonly gpt = new FakeGptLiveSession()
  readonly toTwilio: string[] = []
  readonly toGpt: GptLiveClientEvent[] = []

  private readonly listeners = new Set<(event: VoiceSessionEvent) => void>()
  private readonly clock: Clock
  private tenantId?: string
  private callId?: string
  private sessionId?: string
  private callerText = ''
  private assistantText = ''
  private bridge?: MediaBridge
  private pendingCloseReason?: string

  constructor(clock: Clock = systemClock) {
    this.clock = clock
  }

  async start(input: Parameters<VoiceSessionPort['start']>[0]): Promise<{ sessionId: string; sdp?: string }> {
    normalizeTenantId(input.tenantId)
    if (input.format === 'webrtc-sdp') {
      throw new Error('MediaBridge voice sessions do not support webrtc-sdp')
    }
    this.tenantId = input.tenantId
    this.callId = input.callId
    this.sessionId = undefined
    this.callerText = ''
    this.assistantText = ''
    this.pendingCloseReason = undefined
    this.gpt.attach(
      (raw) => {
        this.publishTranscript(raw)
        this.bridge?.handleGptLiveRaw(raw)
      },
      () => { this.bridge?.onGptLiveDisconnect() },
      () => { this.bridge?.onGptLiveTimeout() }
    )
    const bridge = new MediaBridge({
      identity: { tenantId: input.tenantId, callId: input.callId },
      instructions: input.instructions,
      voice: input.voice,
      clock: this.clock,
      openingLine: input.openingLine ?? '',
      audioFormat: toLiveAudioFormat(input.format),
      log: () => undefined,
      sendToTwilio: (json) => { this.toTwilio.push(json) },
      sendToGptLive: (event) => {
        this.toGpt.push(event)
        this.gpt.send(event)
      },
      observe: (event) => this.forwardObservation(event)
    })
    this.bridge = bridge
    const twilio = new FakeTwilioMediaClient(
      { advance: (ms) => {
        const clock = this.clock as Clock & { advance?: (ms: number) => void }
        clock.advance?.(ms)
      } },
      (message) => bridge.handleTwilioRaw(message)
    )
    twilio.start({
      streamSid: STREAM,
      callSid: CALL_SID,
      customParameters: { tenantId: input.tenantId, callId: input.callId }
    })
    if (!this.sessionId) throw new Error('MediaBridge session did not start')
    return { sessionId: this.sessionId }
  }

  discardPlayback(input: { tenantId: string; callId: string }): void {
    if (!this.matches(this.requireTarget(input))) return
    this.bridge?.handleGptLiveRaw({ type: 'session.input_audio.speech_started' })
  }

  appendFallbackVoicemail(input: { tenantId: string; callId: string }): void {
    if (!this.matches(this.requireTarget(input))) return
    this.bridge?.appendFallbackVoicemail()
  }

  async close(input: { tenantId: string; callId: string; reason: string }): Promise<void> {
    if (!this.matches(this.requireTarget(input))) return
    this.pendingCloseReason = input.reason
    this.flushTranscript('caller')
    this.flushTranscript('assistant')
    this.bridge?.close(input.reason)
  }

  subscribe(listener: (event: VoiceSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  injectAssistantAudio(): void {
    const payload = synthesizeToneMulaw({ frequencyHz: 440, durationMs: 20 }).toString('base64')
    this.gpt.emit({ type: 'session.output_audio.delta', delta: payload })
  }

  private requireTarget(input: { tenantId: string; callId: string }): { tenantId: string; callId: string } {
    return { tenantId: normalizeTenantId(input.tenantId), callId: input.callId }
  }

  private matches(input: { tenantId: string; callId: string }): boolean {
    return this.tenantId === input.tenantId && this.callId === input.callId
  }

  private publish(event: VoiceSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private ids(): { tenantId: string; callId: string } | undefined {
    if (!this.tenantId || !this.callId) return undefined
    return { tenantId: this.tenantId, callId: this.callId }
  }

  private publishTranscript(raw: unknown): void {
    const parsed = parseGptLiveServerEvent(raw)
    if (!parsed.ok) return
    const ids = this.ids()
    if (!ids) return
    if (parsed.value.type === 'session.input_transcript.delta') {
      this.flushTranscript('assistant')
      this.callerText += parsed.value.delta
      this.publish({ ...ids, type: 'transcript', role: 'caller', delta: parsed.value.delta, final: false })
      return
    }
    if (parsed.value.type === 'session.output_transcript.delta') {
      this.flushTranscript('caller')
      this.assistantText += parsed.value.delta
      this.publish({ ...ids, type: 'transcript', role: 'assistant', delta: parsed.value.delta, final: false })
    }
  }

  private flushTranscript(role: 'caller' | 'assistant'): void {
    const ids = this.ids()
    const text = (role === 'caller' ? this.callerText : this.assistantText).trim()
    if (!ids || !text) {
      if (role === 'caller') this.callerText = ''
      else this.assistantText = ''
      return
    }
    this.publish({ ...ids, type: 'transcript', role, text, final: true })
    if (role === 'assistant') this.publish({ ...ids, type: 'turnIdle', at: this.clock.now() })
    if (role === 'caller') this.callerText = ''
    else this.assistantText = ''
  }

  private forwardObservation(event: {
    tenantId: string
    callId: string
    type: string
    sessionId?: string
    seconds?: number
    reason?: string
    usageSeconds?: number
  }): void {
    const ids = { tenantId: event.tenantId, callId: event.callId }
    if (event.type === 'started' && event.sessionId) {
      this.sessionId = event.sessionId
      this.publish({ ...ids, type: 'started', sessionId: event.sessionId })
      return
    }
    if (event.type === 'usage' && typeof event.seconds === 'number') {
      this.publish({ ...ids, type: 'usage', observedSeconds: event.seconds })
      return
    }
    if (event.type === 'closed') {
      this.flushTranscript('caller')
      this.flushTranscript('assistant')
      if (typeof event.usageSeconds === 'number') {
        this.publish({ ...ids, type: 'usage', observedSeconds: event.usageSeconds })
      }
      const reason = this.pendingCloseReason ?? event.reason ?? 'closed'
      this.pendingCloseReason = undefined
      this.publish({ ...ids, type: 'closed', reason })
      return
    }
    if (event.type === 'error') {
      this.publish({ ...ids, type: 'error', message: event.reason ?? 'error' })
    }
  }
}
