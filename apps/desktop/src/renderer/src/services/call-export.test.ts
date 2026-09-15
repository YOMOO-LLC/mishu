import { describe, expect, it } from 'vitest'
import type { CallSession, RecordingInfo, TranscriptEntry } from '../../../shared/contracts'
import { buildCallExport, maskPhoneNumber } from './call-export'

const SESSION: CallSession = {
  id: 'call-1',
  direction: 'inbound',
  peer: '+1 415 555 0142',
  status: 'ended',
  startedAt: 1000,
  answeredAt: 2000,
  endedAt: 9000,
  durationMs: 7000,
  endReason: 'hangup',
  campaignId: 'campaign-1',
  campaignName: 'Default Campaign',
  campaignSystemPrompt: 'Answer inbound calls politely',
  campaignVoice: 'juniper',
  runtimeMode: 'mock',
  threadId: 'thread-1',
  sessionId: 'session-1',
  createdAt: 1000,
  updatedAt: 9000
}

const TRANSCRIPT: TranscriptEntry[] = [
  {
    id: 't-1',
    speaker: 'caller',
    text: 'Hi, I am calling to check whether the assistant is available.',
    final: true,
    timestamp: 3000
  },
  {
    id: 't-2',
    speaker: 'assistant',
    text: 'Yes, I am here and ready to help.',
    final: true,
    timestamp: 4000
  }
]

const RECORDING: RecordingInfo = {
  callId: 'call-1',
  playbackUrl: 'live-phone-recording://call/call-1',
  bytes: 1024,
  sha256: 'a'.repeat(64),
  durationMs: 7000,
  mime: 'audio/webm',
  status: 'complete',
  createdAt: 1000,
  updatedAt: 9000
}

describe('maskPhoneNumber', () => {
  it('keeps the country prefix and the last four digits, masking the middle', () => {
    expect(maskPhoneNumber('+1 415 555 0142')).toBe('+1 *** *** 0142')
    expect(maskPhoneNumber('+17735550100')).toBe('+1******0100')
  })

  it('does not expose a short number', () => {
    expect(maskPhoneNumber('+1 0000')).toBe('+1 0000')
  })
})

describe('buildCallExport', () => {
  it('produces a stable, path-free JSON structure with metadata', () => {
    const exported = buildCallExport(SESSION, TRANSCRIPT, RECORDING)

    expect(exported.schemaVersion).toBe(1)
    expect(typeof exported.exportedAt).toBe('string')
    expect(exported.redaction).toEqual({ maskPeer: true })
    expect(exported.call.id).toBe('call-1')
    expect(exported.call.direction).toBe('inbound')
    expect(exported.call.status).toBe('ended')
    expect(exported.call.endReason).toBe('hangup')
    expect(exported.call.campaignName).toBe('Default Campaign')
    expect(exported.call.runtimeMode).toBe('mock')
    expect(exported.transcript).toHaveLength(2)
    expect(exported.transcript[0].speaker).toBe('caller')
    expect(exported.transcript[1].text).toContain('ready to help')
    expect(exported.recording?.playbackUrl).toBe('live-phone-recording://call/call-1')
    expect(exported.recording?.status).toBe('complete')

    expect(JSON.stringify(exported)).not.toContain('"path"')
  })

  it('masks the peer by default and keeps the full number when requested', () => {
    const masked = buildCallExport(SESSION, TRANSCRIPT)
    expect(masked.call.peer).toBe('+1 *** *** 0142')

    const full = buildCallExport(SESSION, TRANSCRIPT, undefined, { maskPeer: false })
    expect(full.call.peer).toBe('+1 415 555 0142')
    expect(full.redaction).toEqual({ maskPeer: false })
  })

  it('omits the recording block when there is no recording', () => {
    const exported = buildCallExport(SESSION, TRANSCRIPT)
    expect(exported.recording).toBeUndefined()
  })

  it('serializes to stable JSON', () => {
    const a = buildCallExport(SESSION, TRANSCRIPT, RECORDING)
    const b = buildCallExport(SESSION, TRANSCRIPT, RECORDING)
    expect(JSON.parse(JSON.stringify(a))).toEqual(b)
  })
})