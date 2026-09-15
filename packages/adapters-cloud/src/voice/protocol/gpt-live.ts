/**
 * GPT-Live primary WebSocket event mapping.
 * Field names verified against OpenAI Voice WebSockets docs (accessed 2026-09-13)
 * and src/main/voice/gpt-live-api-provider.ts. Unverified names are marked.
 */

import { gptLiveAudioFormat, type LiveAudioFormatName } from './audio-transcode.js'

export const GPT_LIVE_MODEL = 'gpt-live-1'
export const GPT_LIVE_AUDIO_FORMAT = { type: 'audio/pcmu', rate: 8_000 } as const
export const GPT_LIVE_PCM24K_FORMAT = { type: 'audio/pcm', rate: 24_000 } as const
export const GPT_LIVE_WS_URL = 'wss://api.openai.com/v1/live/sessions'

export type GptLiveAudioFormat = {
  type: 'audio/pcmu' | 'audio/pcm'
  rate: number
}

export type GptLiveClientEvent =
  | {
    type: 'session.start'
    event_id: string
    session: {
      model: typeof GPT_LIVE_MODEL
      instructions?: string
      audio: {
        format: GptLiveAudioFormat
        output: { voice: string }
      }
      delegation: { type: 'client' }
    }
  }
  | { type: 'session.input_audio.append'; audio: string }
  | {
    type: 'session.instructions.append'
    event_id: string
    delegation_id: null
    content: string
  }
  | {
    type: 'session.commentary.append'
    event_id: string
    delegation_id: null
    content: string
  }
  | { type: 'session.close' }

export type GptLiveClosedReason =
  | 'close_requested'
  | 'expired'
  | 'content'
  | 'remote_hangup'
  | 'connection_lost'
  | 'closed'

export type GptLiveServerEvent =
  | { type: 'session.started'; session: { id: string } }
  | { type: 'session.output_audio.delta'; delta: string; start_ms?: number; end_ms?: number }
  | { type: 'session.input_transcript.delta'; delta: string; start_ms?: number; end_ms?: number }
  | { type: 'session.output_transcript.delta'; delta: string; start_ms?: number; end_ms?: number }
  | { type: 'session.usage.updated'; usage: { seconds: number } }
  | { type: 'session.closed'; usage?: { seconds: number }; reason?: GptLiveClosedReason }
  | { type: 'session.instructions.appended'; client_event_id?: string }
  | { type: 'session.commentary.appended'; client_event_id?: string }
  | { type: 'error'; message?: string; client_event_id?: string }
  /** Unverified: GPT-Live docs do not list a dedicated speech-started event. Accepted if present. */
  | { type: 'session.input_audio.speech_started' }

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function buildSessionStart(options: {
  eventId: string
  instructions: string
  voice: string
  audioFormat?: LiveAudioFormatName
}): GptLiveClientEvent {
  return {
    type: 'session.start',
    event_id: options.eventId,
    session: {
      model: GPT_LIVE_MODEL,
      instructions: options.instructions,
      audio: {
        format: gptLiveAudioFormat(options.audioFormat ?? 'pcmu'),
        output: { voice: options.voice }
      },
      delegation: { type: 'client' }
    }
  }
}

export function buildInputAudioAppend(audioBase64: string): GptLiveClientEvent {
  return { type: 'session.input_audio.append', audio: audioBase64 }
}

/** Desktop `GptLiveApiVoiceProvider.appendSpeech` (gpt-live-api-provider.ts:114,138). */
export function buildCommentaryAppend(eventId: string, content: string): GptLiveClientEvent {
  return {
    type: 'session.commentary.append',
    event_id: eventId,
    delegation_id: null,
    content
  }
}

/** Kept for experiments. MediaBridge barge-in no longer sends this; Twilio `clear` + local drop is what stops playback. */
export function buildInterruptInstruction(eventId: string): GptLiveClientEvent {
  return {
    type: 'session.instructions.append',
    event_id: eventId,
    delegation_id: null,
    content: 'Stop speaking immediately. Do not continue the previous utterance. Wait for the caller.'
  }
}

export const FALLBACK_VOICEMAIL_INSTRUCTION =
  'The owner cannot take this call. Take a short message from the caller and say you will pass it on. Do not promise a specific callback time.'

export function buildFallbackVoicemailInstruction(eventId: string): GptLiveClientEvent {
  return {
    type: 'session.instructions.append',
    event_id: eventId,
    delegation_id: null,
    content: FALLBACK_VOICEMAIL_INSTRUCTION
  }
}

export function buildSessionClose(): GptLiveClientEvent {
  return { type: 'session.close' }
}

export function parseGptLiveServerEvent(raw: unknown): ParseResult<GptLiveServerEvent> {
  if (!isRecord(raw) || typeof raw.type !== 'string') return { ok: false, error: 'invalid event' }
  const type = raw.type
  if (type === 'session.started') {
    const id = isRecord(raw.session) && typeof raw.session.id === 'string' ? raw.session.id : undefined
    if (!id) return { ok: false, error: 'session.started missing session.id' }
    return { ok: true, value: { type, session: { id } } }
  }
  if (type === 'session.output_audio.delta') {
    if (typeof raw.delta !== 'string' || raw.delta.length === 0) return { ok: false, error: 'output audio missing delta' }
    return {
      ok: true,
      value: {
        type,
        delta: raw.delta,
        start_ms: typeof raw.start_ms === 'number' ? raw.start_ms : undefined,
        end_ms: typeof raw.end_ms === 'number' ? raw.end_ms : undefined
      }
    }
  }
  if (type === 'session.input_transcript.delta' || type === 'session.output_transcript.delta') {
    if (typeof raw.delta !== 'string') return { ok: false, error: 'transcript missing delta' }
    return {
      ok: true,
      value: {
        type,
        delta: raw.delta,
        start_ms: typeof raw.start_ms === 'number' ? raw.start_ms : undefined,
        end_ms: typeof raw.end_ms === 'number' ? raw.end_ms : undefined
      }
    }
  }
  if (type === 'session.usage.updated' || type === 'session.closed') {
    const seconds = isRecord(raw.usage) && typeof raw.usage.seconds === 'number' ? raw.usage.seconds : undefined
    if (type === 'session.usage.updated') {
      if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
        return { ok: false, error: 'usage.seconds missing' }
      }
      return { ok: true, value: { type, usage: { seconds } } }
    }
    const reason = typeof raw.reason === 'string' && [
      'close_requested', 'expired', 'content', 'remote_hangup', 'connection_lost', 'closed'
    ].includes(raw.reason)
      ? raw.reason as GptLiveClosedReason
      : 'closed'
    return {
      ok: true,
      value: { type, usage: seconds !== undefined ? { seconds } : undefined, reason }
    }
  }
  if (type === 'session.instructions.appended' || type === 'session.commentary.appended') {
    return {
      ok: true,
      value: { type, client_event_id: typeof raw.client_event_id === 'string' ? raw.client_event_id : undefined }
    }
  }
  if (type === 'error') {
    const nested = isRecord(raw.error) ? raw.error : undefined
    return {
      ok: true,
      value: {
        type,
        message: typeof nested?.message === 'string' ? nested.message : 'error',
        client_event_id: typeof nested?.client_event_id === 'string' ? nested.client_event_id : undefined
      }
    }
  }
  if (type === 'session.input_audio.speech_started') {
    return { ok: true, value: { type } }
  }
  return { ok: false, error: `unsupported event ${type}` }
}

export function isCallerSpeechSignal(event: GptLiveServerEvent): boolean {
  return event.type === 'session.input_transcript.delta' || event.type === 'session.input_audio.speech_started'
}

export interface GptLiveTransport {
  send(event: GptLiveClientEvent): void
  close(): void
}

export interface LiveSocket {
  send(data: string): void
  close(): void
  readyState?: number
  on(event: 'open' | 'message' | 'close' | 'error', listener: (data?: { toString(): string }) => void): void
}
