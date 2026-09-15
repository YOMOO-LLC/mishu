import type {
  CallEndReason,
  CallDirection,
  CallSession,
  CallStatus,
  RecordingInfo,
  RecordingStatus,
  RuntimeMode,
  TranscriptEntry
} from '../../../shared/contracts'

export const CALL_EXPORT_SCHEMA_VERSION = 1 as const

export interface CallExport {
  schemaVersion: typeof CALL_EXPORT_SCHEMA_VERSION
  exportedAt: string
  redaction: {
    maskPeer: boolean
  }
  call: {
    id: string
    direction: CallDirection
    peer: string
    status: CallStatus
    startedAt?: number
    answeredAt?: number
    endedAt?: number
    durationMs?: number
    endReason?: CallEndReason
    campaignId?: string
    campaignName?: string
    campaignSystemPrompt?: string
    campaignVoice?: string
    runtimeMode: RuntimeMode
    threadId?: string
    sessionId?: string
    createdAt: number
    updatedAt: number
  }
  transcript: Array<{
    id: string
    speaker: TranscriptEntry['speaker']
    text: string
    final: boolean
    timestamp: number
  }>
  recording?: {
    playbackUrl: string
    bytes?: number
    sha256?: string
    durationMs?: number
    mime?: string
    status: RecordingStatus
  }
}

export interface CallExportOptions {
  maskPeer?: boolean
}

export function maskPhoneNumber(peer: string): string {
  const digits = peer.replace(/\D/g, '')
  if (digits.length <= 4) return peer
  let digitCount = 0
  let seenDigit = false
  let masked = ''
  for (const char of peer) {
    if (/\d/.test(char)) {
      digitCount += 1
      const isFirstDigit = !seenDigit
      seenDigit = true
      const isInLastFour = digitCount > digits.length - 4
      masked += isFirstDigit || isInLastFour ? char : '*'
    } else {
      masked += char
    }
  }
  return masked
}

export function buildCallExport(
  session: CallSession,
  transcript: TranscriptEntry[],
  recording?: RecordingInfo,
  options: CallExportOptions = {}
): CallExport {
  const maskPeer = options.maskPeer ?? true
  return {
    schemaVersion: CALL_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    redaction: { maskPeer },
    call: {
      id: session.id,
      direction: session.direction,
      peer: maskPeer ? maskPhoneNumber(session.peer) : session.peer,
      status: session.status,
      ...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}),
      ...(session.answeredAt !== undefined ? { answeredAt: session.answeredAt } : {}),
      ...(session.endedAt !== undefined ? { endedAt: session.endedAt } : {}),
      ...(session.durationMs !== undefined ? { durationMs: session.durationMs } : {}),
      ...(session.endReason !== undefined ? { endReason: session.endReason } : {}),
      ...(session.campaignId !== undefined ? { campaignId: session.campaignId } : {}),
      ...(session.campaignName !== undefined ? { campaignName: session.campaignName } : {}),
      ...(session.campaignSystemPrompt !== undefined
        ? { campaignSystemPrompt: session.campaignSystemPrompt }
        : {}),
      ...(session.campaignVoice !== undefined ? { campaignVoice: session.campaignVoice } : {}),
      runtimeMode: session.runtimeMode,
      ...(session.threadId !== undefined ? { threadId: session.threadId } : {}),
      ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    },
    transcript: transcript.map((entry) => ({
      id: entry.id,
      speaker: entry.speaker,
      text: entry.text,
      final: entry.final,
      timestamp: entry.timestamp
    })),
    ...(recording
      ? {
          recording: {
            playbackUrl: recording.playbackUrl,
            ...(recording.bytes !== undefined ? { bytes: recording.bytes } : {}),
            ...(recording.sha256 !== undefined ? { sha256: recording.sha256 } : {}),
            ...(recording.durationMs !== undefined ? { durationMs: recording.durationMs } : {}),
            ...(recording.mime !== undefined ? { mime: recording.mime } : {}),
            status: recording.status
          }
        }
      : {})
  }
}