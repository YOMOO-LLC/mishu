import { systemClock, type Clock } from '@mishu/core/clock'
import {
  FALLBACK_VOICEMAIL_NOTE,
  type VoiceSessionCapabilities,
  type VoiceSessionEvent,
  type VoiceSessionPort,
  type VoiceSessionStartInput,
  type VoiceSessionStartResult,
  type VoiceSessionTarget
} from '@mishu/core/ports'
import { normalizeTenantId } from '@mishu/core/tenant'
import { REALTIME_VOICES, type RealtimeVoice, type StartRealtimeRequest } from '../../shared/contracts.js'
import { ServiceError } from '../services/service-error.js'
import type { VoiceEvent, VoiceProvider } from './provider.js'

export const DESKTOP_GPT_LIVE_VOICE_CAPABILITIES: VoiceSessionCapabilities = {
  sdp: true,
  websocketFrames: false,
  localOnly: false,
  fallbackVoicemail: true,
  discardPlayback: false
}

export const DESKTOP_CODEX_VOICE_CAPABILITIES: VoiceSessionCapabilities = {
  sdp: true,
  websocketFrames: false,
  localOnly: true,
  fallbackVoicemail: true,
  discardPlayback: false
}

export function createDesktopVoiceSessionAdapter(
  provider: VoiceProvider,
  kind: 'codex' | 'gpt-live-api',
  clock: Clock = systemClock
): DesktopVoiceSessionAdapter {
  return new DesktopVoiceSessionAdapter(
    provider,
    kind === 'codex' ? DESKTOP_CODEX_VOICE_CAPABILITIES : DESKTOP_GPT_LIVE_VOICE_CAPABILITIES,
    clock
  )
}

/**
 * Thin VoiceSessionPort over the existing VoiceProvider. Callers keep using VoiceProvider.
 * discardPlayback is a no-op here: desktop barge-in lives on the renderer audio router,
 * and this adapter must not call silence() (that path sends a stop-speaking instruction).
 * appendFallbackVoicemail uses the existing appendSpeech commentary path.
 */
export class DesktopVoiceSessionAdapter implements VoiceSessionPort {
  private readonly listeners = new Set<(event: VoiceSessionEvent) => void>()
  private tenantId?: string
  private callId?: string
  private stopped = false

  constructor(
    private readonly provider: VoiceProvider,
    readonly capabilities: VoiceSessionCapabilities,
    private readonly clock: Clock = systemClock
  ) {
    this.provider.subscribe((event) => this.forward(event))
  }

  async start(input: VoiceSessionStartInput): Promise<VoiceSessionStartResult> {
    this.tenantId = normalizeTenantId(input.tenantId)
    this.callId = input.callId
    this.stopped = false
    if (input.format !== 'webrtc-sdp') {
      throw new ServiceError('INVALID_ARGUMENT', 'Desktop voice sessions only support webrtc-sdp')
    }
    if (typeof input.sdp !== 'string' || !input.sdp) {
      throw new ServiceError('INVALID_ARGUMENT', 'A WebRTC SDP offer is required')
    }
    const request: StartRealtimeRequest = {
      sdp: input.sdp,
      callId: input.callId,
      instructions: input.instructions,
      ...(isRealtimeVoice(input.voice) ? { voice: input.voice } : {})
    }
    const response = await this.provider.start(request)
    const sessionId = response.sessionId ?? response.threadId
    if (input.openingLine?.trim()) {
      void this.provider.appendSpeech(input.openingLine.trim()).catch(() => undefined)
    }
    return {
      sessionId,
      ...(response.sdp ? { sdp: response.sdp } : {})
    }
  }

  discardPlayback(input: VoiceSessionTarget): void {
    if (!this.matches(this.requireTarget(input))) return
    // Renderer audio router drops playback. Do not call provider.silence().
  }

  appendFallbackVoicemail(input: VoiceSessionTarget): void {
    if (!this.matches(this.requireTarget(input)) || !this.capabilities.fallbackVoicemail) return
    void this.provider.appendSpeech(FALLBACK_VOICEMAIL_NOTE).catch(() => undefined)
  }

  async close(input: VoiceSessionTarget & { reason: string }): Promise<void> {
    if (!this.matches(this.requireTarget(input))) return
    if (this.stopped) return
    this.stopped = true
    await this.provider.stop()
  }

  subscribe(listener: (event: VoiceSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private requireTarget(input: VoiceSessionTarget): VoiceSessionTarget {
    return { tenantId: normalizeTenantId(input.tenantId), callId: input.callId }
  }

  private matches(input: VoiceSessionTarget): boolean {
    return this.tenantId === input.tenantId && this.callId === input.callId
  }

  private forward(event: VoiceEvent): void {
    const tenantId = this.tenantId
    const callId = this.callId
    if (!tenantId || !callId) return
    const mapped = mapVoiceEvent(event, tenantId, callId, this.clock.now())
    if (!mapped) return
    for (const listener of this.listeners) listener(mapped)
  }
}

function mapVoiceEvent(
  event: VoiceEvent,
  tenantId: string,
  callId: string,
  at: number
): VoiceSessionEvent | undefined {
  if (event.type === 'started') {
    return { tenantId, callId, type: 'started', sessionId: event.sessionId ?? event.threadId ?? '' }
  }
  if (event.type === 'transcript') {
    return {
      tenantId,
      callId,
      type: 'transcript',
      role: event.role,
      final: event.final,
      ...(event.delta !== undefined ? { delta: event.delta } : {}),
      ...(event.text !== undefined ? { text: event.text } : {})
    }
  }
  if (event.type === 'turnDone') return { tenantId, callId, type: 'turnIdle', at }
  if (event.type === 'usage') return { tenantId, callId, type: 'usage', observedSeconds: event.seconds }
  if (event.type === 'closed') return { tenantId, callId, type: 'closed', reason: event.reason }
  if (event.type === 'error') return { tenantId, callId, type: 'error', message: event.message }
  return undefined
}

function isRealtimeVoice(value: string): value is RealtimeVoice {
  return (REALTIME_VOICES as readonly string[]).includes(value)
}
