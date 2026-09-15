import type { Clock, IdGen } from '@mishu/core/clock'
import {
  type VoiceAudioFormat,
  type VoiceSessionCapabilities,
  type VoiceSessionEvent,
  type VoiceSessionPort,
  type VoiceSessionStartInput,
  type VoiceSessionStartResult,
  type VoiceSessionTarget
} from '@mishu/core/ports'
import { FakeClock, FakeIdGen } from './clock.js'
import { requireTenantId } from './require-tenant.js'

/** Kept so the T12.14 stub suite still passes. */
export const ADAPTERS_MOCK_VOICE_TASK = 'T12.18'

const SUPPORTED_FORMATS: ReadonlySet<VoiceAudioFormat> = new Set([
  'pcmu-8k',
  'pcm24k',
  'webrtc-sdp'
])

const MOCK_SDP_ANSWER =
  'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=mock\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\nc=IN IP4 0.0.0.0\r\n'

export interface MockVoiceSessionOptions {
  clock?: Clock
  idGen?: IdGen
}

export interface MockVoiceAction {
  tenantId: string
  callId: string
  at: number
}

interface SessionRecord {
  tenantId: string
  callId: string
  sessionId: string
  format: VoiceAudioFormat
  startedAt: number
  closed: boolean
  closeReason?: string
}

function sessionKey(tenantId: string, callId: string): string {
  return `${tenantId}:${callId}`
}

function requireTarget(input: VoiceSessionTarget): { tenantId: string; callId: string } {
  const tenantId = requireTenantId(input.tenantId)
  if (typeof input.callId !== 'string' || input.callId.trim() === '') {
    throw new Error('callId is required')
  }
  return { tenantId, callId: input.callId.trim() }
}

/**
 * Scripted VoiceSessionPort. Audio bytes never appear; tests queue transcripts
 * and optional assistant replies. Timers go through Clock.
 */
export class MockVoiceSession implements VoiceSessionPort {
  readonly capabilities: VoiceSessionCapabilities = {
    sdp: true,
    websocketFrames: true,
    localOnly: false,
    fallbackVoicemail: true,
    discardPlayback: true
  }

  readonly clock: Clock
  readonly idGen: IdGen
  readonly discardedPlayback: MockVoiceAction[] = []
  readonly fallbackVoicemail: MockVoiceAction[] = []

  private readonly listeners = new Set<(event: VoiceSessionEvent) => void>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly replies = new Map<string, string[]>()

  constructor(options: MockVoiceSessionOptions = {}) {
    this.clock = options.clock ?? new FakeClock(0)
    this.idGen = options.idGen ?? new FakeIdGen('sess')
  }

  /** Queue assistant text to speak after the next matching caller transcript. */
  scriptAssistantReply(target: VoiceSessionTarget, text: string): void {
    const ids = requireTarget(target)
    const key = sessionKey(ids.tenantId, ids.callId)
    const queued = this.replies.get(key) ?? []
    queued.push(text)
    this.replies.set(key, queued)
  }

  /** Emit a caller transcript (delta then final). Plays a scripted reply if queued. */
  emitCallerTranscript(target: VoiceSessionTarget, text: string): void {
    this.emitRoleTranscript(target, 'caller', text, true)
  }

  /** Emit an assistant transcript (delta then final) and turnIdle. */
  emitAssistantTranscript(target: VoiceSessionTarget, text: string): void {
    this.emitRoleTranscript(target, 'assistant', text, false)
  }

  async start(input: VoiceSessionStartInput): Promise<VoiceSessionStartResult> {
    const ids = requireTarget(input)
    if (!SUPPORTED_FORMATS.has(input.format)) {
      throw new Error(`Unsupported voice format: ${String(input.format)}`)
    }
    const key = sessionKey(ids.tenantId, ids.callId)
    const existing = this.sessions.get(key)
    if (existing && !existing.closed) {
      throw new Error(`Voice session already started for ${key}`)
    }
    const sessionId = this.idGen.id()
    const record: SessionRecord = {
      tenantId: ids.tenantId,
      callId: ids.callId,
      sessionId,
      format: input.format,
      startedAt: this.clock.now(),
      closed: false
    }
    this.sessions.set(key, record)
    this.emit({
      tenantId: ids.tenantId,
      callId: ids.callId,
      type: 'started',
      sessionId
    })
    if (input.openingLine?.trim()) {
      this.publishTranscript(record, 'assistant', input.openingLine.trim())
    }
    const result: VoiceSessionStartResult = { sessionId }
    if (input.format === 'webrtc-sdp') result.sdp = MOCK_SDP_ANSWER
    return result
  }

  discardPlayback(input: VoiceSessionTarget): void {
    const ids = requireTarget(input)
    this.discardedPlayback.push({ ...ids, at: this.clock.now() })
  }

  appendFallbackVoicemail(input: VoiceSessionTarget): void {
    const ids = requireTarget(input)
    this.fallbackVoicemail.push({ ...ids, at: this.clock.now() })
  }

  async close(input: VoiceSessionTarget & { reason: string }): Promise<void> {
    const ids = requireTarget(input)
    const record = this.sessions.get(sessionKey(ids.tenantId, ids.callId))
    if (!record || record.closed) return
    record.closed = true
    record.closeReason = input.reason
    const observedSeconds = Math.max(0, (this.clock.now() - record.startedAt) / 1000)
    this.emit({
      tenantId: record.tenantId,
      callId: record.callId,
      type: 'usage',
      observedSeconds
    })
    this.emit({
      tenantId: record.tenantId,
      callId: record.callId,
      type: 'closed',
      reason: input.reason
    })
  }

  subscribe(listener: (event: VoiceSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitRoleTranscript(
    target: VoiceSessionTarget,
    role: 'caller' | 'assistant',
    text: string,
    playReply: boolean
  ): void {
    const ids = requireTarget(target)
    const record = this.requireOpen(ids)
    this.publishTranscript(record, role, text)
    if (!playReply || role !== 'caller') return
    const key = sessionKey(record.tenantId, record.callId)
    const next = this.replies.get(key)?.shift()
    if (next === undefined) return
    this.publishTranscript(record, 'assistant', next)
  }

  private requireOpen(ids: { tenantId: string; callId: string }): SessionRecord {
    const record = this.sessions.get(sessionKey(ids.tenantId, ids.callId))
    if (!record || record.closed) {
      throw new Error('Voice session is not open')
    }
    return record
  }

  private publishTranscript(
    record: SessionRecord,
    role: 'caller' | 'assistant',
    text: string
  ): void {
    this.emit({
      tenantId: record.tenantId,
      callId: record.callId,
      type: 'transcript',
      role,
      delta: text,
      final: false
    })
    this.emit({
      tenantId: record.tenantId,
      callId: record.callId,
      type: 'transcript',
      role,
      text,
      final: true
    })
    if (role === 'assistant') {
      this.emit({
        tenantId: record.tenantId,
        callId: record.callId,
        type: 'turnIdle',
        at: this.clock.now()
      })
    }
  }

  private emit(event: VoiceSessionEvent): void {
    const record = this.sessions.get(sessionKey(event.tenantId, event.callId))
    if (record?.closed && event.type !== 'closed' && event.type !== 'usage') return
    for (const listener of [...this.listeners]) listener(event)
  }
}
