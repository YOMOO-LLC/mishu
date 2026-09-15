/**
 * Host-agnostic voice session. Audio bytes stay in the adapter.
 * Format is a start parameter: webrtc-sdp (optional SDP answer), pcmu-8k, or pcm24k.
 * Barge-in is discardPlayback(); adapters drop queued playback locally and never
 * send a provider "stop speaking" instruction.
 */

export type VoiceAudioFormat = 'webrtc-sdp' | 'pcmu-8k' | 'pcm24k'

export interface VoiceSessionCapabilities {
  /** Adapter may return an SDP answer from start() when format is webrtc-sdp. */
  sdp: boolean
  /** Adapter transports framed audio (pcmu-8k or pcm24k). */
  websocketFrames: boolean
  /** Local app-server sessions; cloud hosts must not select this adapter. */
  localOnly: boolean
  /** Adapter can speak a system note after owner-handoff fallback. */
  fallbackVoicemail: boolean
  /** Adapter can drop queued playback without a provider stop-speaking instruction. */
  discardPlayback: boolean
}

/** Spoken system note used by appendFallbackVoicemail adapters. */
export const FALLBACK_VOICEMAIL_NOTE =
  'The owner cannot take this call. Take a short message from the caller and say you will pass it on. Do not promise a specific callback time.'

export type VoiceSessionEvent =
  | { tenantId: string; callId: string; type: 'started'; sessionId: string }
  | {
    tenantId: string
    callId: string
    type: 'transcript'
    role: 'caller' | 'assistant'
    delta?: string
    text?: string
    final: boolean
  }
  | { tenantId: string; callId: string; type: 'turnIdle'; at: number }
  | { tenantId: string; callId: string; type: 'usage'; observedSeconds: number }
  | { tenantId: string; callId: string; type: 'closed'; reason: string }
  | { tenantId: string; callId: string; type: 'error'; message: string }

export interface VoiceSessionTarget {
  tenantId: string
  callId: string
}

export interface VoiceSessionStartInput extends VoiceSessionTarget {
  format: VoiceAudioFormat
  instructions: string
  voice: string
  sdp?: string
  openingLine?: string
}

export interface VoiceSessionStartResult {
  sessionId: string
  sdp?: string
}

export interface VoiceSessionPort {
  readonly capabilities: VoiceSessionCapabilities
  start(input: VoiceSessionStartInput): Promise<VoiceSessionStartResult>
  discardPlayback(input: VoiceSessionTarget): void
  appendFallbackVoicemail(input: VoiceSessionTarget): void
  close(input: VoiceSessionTarget & { reason: string }): Promise<void>
  subscribe(listener: (event: VoiceSessionEvent) => void): () => void
}
