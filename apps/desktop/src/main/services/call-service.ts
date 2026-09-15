import { createReadStream, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  Appointment,
  CallAnalysis,
  CallAuditRecord,
  CallSession,
  CallSummary,
  GuardrailEvent,
  ListAppointmentsRequest,
  ListCallsRequest,
  RecordingInfo,
  TranscriptEntry
} from '../../shared/contracts.js'
import { maskPhoneNumber } from '../../shared/phone-mask.js'
import type { AppointmentStore } from '../appointments/store.js'
import type { CallStore } from '../call-store.js'
import type { RecordingWriter } from '../recording-writer.js'
import { ServiceError, requiredId } from './service-error.js'

export interface RecordingAudio {
  mime: string
  bytes: number
  stream: ReturnType<typeof createReadStream>
}

export class CallService {
  constructor(
    private readonly calls: CallStore,
    private readonly appointments: AppointmentStore,
    private readonly recordings: RecordingWriter
  ) {}

  list(request: ListCallsRequest = {}, options: { reveal?: boolean } = {}): CallSummary[] {
    const values = this.calls.listCalls(request)
    if (!options.reveal) return values
    return values.map((summary) => {
      const call = this.calls.getCall(summary.id)
      return call ? { ...summary, peer: call.peer } : summary
    })
  }

  get(id: unknown, options: { reveal?: boolean } = {}): CallSession {
    const call = this.calls.getCall(requiredId(id, 'callId'))
    if (!call) throw new ServiceError('NOT_FOUND', 'Call not found')
    return {
      ...call,
      peer: options.reveal ? call.peer : maskPhoneNumber(call.peer),
      campaignSystemPrompt: undefined
    }
  }

  find(id: unknown, options: { reveal?: boolean } = {}): CallSession | undefined {
    try {
      return this.get(id, options)
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'NOT_FOUND') return undefined
      throw error
    }
  }

  transcript(id: unknown, options: { reveal?: boolean } = {}): TranscriptEntry[] {
    this.get(id)
    const entries = this.calls.getCallTranscript(requiredId(id, 'callId'))
    return options.reveal ? entries : entries.map((entry) => ({
      ...entry,
      text: entry.text.replace(/\+[1-9]\d{6,14}/g, (phone) => maskPhoneNumber(phone))
    }))
  }

  analysis(id: unknown): CallAnalysis {
    const callId = requiredId(id, 'callId')
    this.get(callId)
    const result = this.calls.getLatestCallResult(callId)
    if (!result) throw new ServiceError('NOT_FOUND', 'Call analysis not found')
    return {
      resultId: result.id,
      outcome: result.outcome,
      summary: result.summary,
      confidence: result.confidence,
      schemaHash: result.schemaHash,
      ...(result.result !== undefined ? { result: result.result } : {}),
      analyzedAt: result.createdAt
    }
  }

  audit(
    id: unknown,
    request: { limit?: number; offset?: number } = {},
    options: { reveal?: boolean } = {}
  ): CallAuditRecord[] {
    const callId = requiredId(id, 'callId')
    this.get(callId)
    return this.calls.listCallAudit(callId, request).map(({ at, actor, action, tenantId, details }) => ({
      at,
      actor,
      action,
      tenantId,
      ...(details === undefined ? {} : { details: sanitizeAuditDetails(details, options.reveal === true) })
    }))
  }

  recording(id: unknown): RecordingInfo {
    this.get(id)
    const recording = this.calls.getRecording(requiredId(id, 'callId'))
    if (!recording) throw new ServiceError('NOT_FOUND', 'Recording not found')
    return recording
  }

  recordingAudio(id: unknown): RecordingAudio {
    const callId = requiredId(id, 'callId')
    const recording = this.recording(callId)
    if (recording.status !== 'complete' || !recording.mime) {
      throw new ServiceError('CONFLICT', 'Recording is not complete')
    }
    const storedPath = this.calls.getRecordingPath(callId)
    if (!storedPath) throw new ServiceError('NOT_FOUND', 'Recording audio not found')
    const root = resolve(this.recordings.getRecordingsPath())
    const candidate = resolve(storedPath)
    if (candidate !== root && !candidate.startsWith(`${root}/`)) {
      throw new ServiceError('NOT_FOUND', 'Recording audio not found')
    }
    return { mime: recording.mime, bytes: statSync(candidate).size, stream: createReadStream(candidate) }
  }

  guardrails(id: unknown): GuardrailEvent[] {
    this.get(id)
    return this.calls.listGuardrailEvents(requiredId(id, 'callId'))
  }

  listAppointments(request: ListAppointmentsRequest = {}, options: { reveal?: boolean } = {}): Appointment[] {
    return this.maskAppointments(this.appointments.list(request), options.reveal)
  }

  callAppointments(id: unknown, options: { reveal?: boolean } = {}): Appointment[] {
    this.get(id)
    return this.maskAppointments(this.appointments.getByCall(requiredId(id, 'callId')), options.reveal)
  }

  private maskAppointments(values: Appointment[], reveal = false): Appointment[] {
    return reveal ? values : values.map((value) => ({ ...value, peer: maskPhoneNumber(value.peer) }))
  }
}

function sanitizeAuditDetails(value: unknown, reveal: boolean, key = ''): unknown {
  if (/transcript|utterance|text|content|prompt|token|secret|authorization|password/i.test(key)) {
    return '[redacted: sensitive audit field omitted]'
  }
  if (typeof value === 'string') {
    return reveal ? value : value.replace(/\+[1-9]\d{6,14}/g, (phone) => maskPhoneNumber(phone))
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditDetails(item, reveal, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, item]) => [childKey, sanitizeAuditDetails(item, reveal, childKey)]))
}
