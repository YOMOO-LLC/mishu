import { DatabaseSync } from 'node:sqlite'
import { maskPhoneNumber } from '../shared/phone-mask.js'
import type {
  AnalysisJob,
  AnalysisJobFailure,
  CallAnalysisResult,
  EnqueueAnalysisJobInput
} from './analysis/types.js'
import type {
  CallBudget,
  CallDirection,
  CallEndReason,
  CallLifecycleReport,
  CallSession,
  CallStatus,
  CallSummary,
  CallTask,
  CallTaskStatus,
  ContactCard,
  ContactCardSummary,
  ListContactCardsRequest,
  ListCallTasksRequest,
  GuardrailEvent,
  GuardrailEventKind,
  ListCallsRequest,
  RecordingInfo,
  RuntimeMode,
  TranscriptEntry
} from '../shared/contracts.js'
import { LOCAL_TENANT_ID, normalizeTenantId } from './tenant.js'
import {
  ensureTenantColumn,
  hasUniqueOn,
  primaryKeyColumns,
  rebuildSqliteTable
} from './sqlite-tenant.js'

const CALL_STATUSES: ReadonlySet<string> = new Set([
  'idle',
  'ringing',
  'dialing',
  'connecting',
  'active',
  'held',
  'ended',
  'error'
])
const DIRECTIONS: ReadonlySet<string> = new Set(['inbound', 'outbound'])
const RUNTIME_MODES: ReadonlySet<string> = new Set(['mock', 'twilio'])
const END_REASONS: ReadonlySet<string> = new Set([
  'hangup',
  'rejected',
  'remote',
  'error',
  'timeout',
  'max_duration',
  'unknown',
  'remote_hangup',
  'local_hangup',
  'carrier_error',
  'session_error'
])
const GUARDRAIL_KINDS: ReadonlySet<string> = new Set([
  'max_duration',
  'forbidden_claim',
  'dnc_blocked',
  'outside_calling_hours',
  'blocked_caller'
])
const SPEAKERS: ReadonlySet<string> = new Set(['caller', 'assistant', 'system'])
const MAX_TRANSCRIPT_TEXT = 20_000
const MAX_PEER_LENGTH = 40
const MAX_CAMPAIGN_NAME_LENGTH = 120
const MAX_PROMPT_LENGTH = 12_000
const MAX_ID_LENGTH = 200
const MAX_GUARDRAIL_DETAILS_JSON = 4_000
const PRE_DIAL_CALL_ID = 'pre-dial'
export const ORPHANED_CALL_THRESHOLD_MS = 10 * 60_000
export const CALLS_SCHEMA_VERSION = 7

interface CallSessionRow {
  voice_provider: 'codex' | 'gpt-live-api'
  voice_seconds: number | null
  id: string
  direction: CallDirection
  peer: string
  status: CallStatus
  provider_call_sid: string | null
  started_at: number | null
  answered_at: number | null
  ended_at: number | null
  duration_ms: number | null
  end_reason: CallEndReason | null
  campaign_id: string | null
  campaign_name: string | null
  campaign_system_prompt: string | null
  campaign_voice: string | null
  runtime_mode: RuntimeMode
  thread_id: string | null
  session_id: string | null
  contact_card_json: string | null
  created_at: number
  updated_at: number
}

interface ContactCardRow {
  phone: string
  display_name: string | null
  company: string | null
  tier: string | null
  language: string | null
  time_zone: string | null
  notes: string | null
  facts_json: string
  source: string
  expires_at: number | null
  created_at: number
  updated_at: number
}

interface TranscriptEntryRow {
  id: string
  call_id: string
  speaker: TranscriptEntry['speaker']
  text: string
  final: number
  timestamp: number
  seq: number
}

interface AuditLogRow {
  id: number
  at: number
  actor: string
  action: string
  call_id: string | null
  details_json: string | null
  tenant_id: string
}

interface RecordingRow {
  call_id: string
  path: string
  bytes: number | null
  sha256: string | null
  duration_ms: number | null
  mime: string | null
  status: 'recording' | 'complete' | 'incomplete'
  created_at: number
  updated_at: number
}

interface CallResultRow {
  id: string
  call_id: string
  schema_hash: string
  outcome: CallAnalysisResult['outcome']
  summary: string
  result_json: string | null
  confidence: CallAnalysisResult['confidence']
  model: string
  created_at: number
  error: string | null
}

interface AnalysisJobRow {
  id: number
  call_id: string
  schema_hash: string
  schema_json: string | null
  goal: string | null
  status: AnalysisJob['status']
  attempts: number
  next_attempt_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

interface CallTaskRow {
  id: string
  to_number: string
  campaign_id: string
  goal: string
  result_schema_json: string | null
  constraints_json: string
  callback_url: string | null
  idempotency_key: string
  status: CallTaskStatus
  attempts: number
  call_id: string | null
  result_id: string | null
  result_json?: string | null
  outcome: CallTask['outcome'] | null
  error: string | null
  created_by: CallTask['createdBy']
  created_at: number
  updated_at: number
  started_at: number | null
  ended_at: number | null
}

interface CallBudgetRow {
  enabled: number
  daily_max_calls: number
  daily_max_minutes: number
  allowed_prefixes_json: string
  allowed_numbers_json: string
  allowed_hours_json: string
  kill_switch: number
}

export type RecordingStatus = 'recording' | 'complete' | 'incomplete'

export type { RecordingInfo } from '../shared/contracts.js'

export type CallStoreEvent =
  | { type: 'call.started'; call: CallSession }
  | { type: 'call.ended'; call: CallSession }
  | { type: 'transcript.final'; callId: string; entry: TranscriptEntry }
  | { type: 'recording.ready'; callId: string; recording: RecordingInfo }
  | { type: 'guardrail.triggered'; callId: string; guardrail: GuardrailEvent }

export interface RecordingInput {
  callId: string
  path: string
  mime?: string
  status: RecordingStatus
}

export interface AuditEntry {
  id: number
  at: number
  actor: string
  action: string
  tenantId: string
  callId?: string
  details?: unknown
}

export interface CallStoreOptions {
  tenantId?: string
}

export class CallStore {
  readonly tenantId: string
  private readonly database: DatabaseSync
  private activeCallId?: string
  private readonly transcriptCounters = new Map<string, number>()
  private readonly listeners = new Set<(event: CallStoreEvent) => void>()

  constructor(path: string, options: CallStoreOptions = {}) {
    this.database = new DatabaseSync(path)
    this.tenantId = normalizeTenantId(options.tenantId ?? LOCAL_TENANT_ID)
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    this.migrate()
    this.ensureBudgetRow()
    this.finalizeOrphanedSessions()
  }

  onEvent(listener: (event: CallStoreEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getDatabase(): DatabaseSync {
    return this.database
  }

  report(
    report: CallLifecycleReport,
    voiceSnapshot?: { provider: CallSession['voiceProvider']; voice: string }
  ): void {
    const call = normalizeCall(report.call)
    const status = call.status
    const now = Date.now()

    const existing = this.findSession(call.id)
    if (!existing) {
      const startedAt = call.startedAt ?? now
      this.database.prepare(`
        INSERT INTO call_sessions (
          id, tenant_id, direction, peer, status, provider_call_sid, started_at, answered_at, ended_at,
          duration_ms, end_reason, campaign_id, campaign_name,
          campaign_system_prompt, campaign_voice, voice_provider, runtime_mode, thread_id,
          session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        call.id,
        this.tenantId,
        call.direction,
        call.peer,
        status,
        call.providerCallSid ?? null,
        startedAt,
        status === 'active' ? now : null,
        status === 'ended' || status === 'error' ? now : null,
        status === 'ended' || status === 'error' ? Math.max(0, now - startedAt) : null,
        status === 'ended' || status === 'error' ? normalizeEndReason(report.endReason, call) : null,
        normalizeOptionalString(report.campaign?.id),
        normalizeOptionalString(report.campaign?.name),
        normalizeOptionalString(report.campaign?.systemPrompt, MAX_PROMPT_LENGTH),
        normalizeOptionalString(voiceSnapshot?.voice ?? report.campaign?.voice),
        voiceSnapshot?.provider ?? 'codex',
        normalizeRuntimeMode(report.runtimeMode),
        normalizeOptionalString(report.threadId),
        normalizeOptionalString(report.sessionId),
        now,
        now
      )
      this.writeAudit('call.created', call.id, {
        direction: call.direction,
        status,
        runtimeMode: report.runtimeMode
      })
    } else {
      const startedAt = existing.started_at ?? call.startedAt ?? now
      const ended = status === 'ended' || status === 'error'
      const answeredAt = status === 'active' && existing.answered_at === null
        ? now
        : existing.answered_at
      const endedAt = ended && existing.ended_at === null ? now : existing.ended_at
      const durationMs = ended && endedAt !== null
        ? Math.max(0, endedAt - (answeredAt ?? startedAt))
        : null
      const endReason = ended
        ? normalizeEndReason(report.endReason, call)
        : existing.end_reason
      this.database.prepare(`
        UPDATE call_sessions
        SET direction = ?, peer = ?, status = ?, started_at = ?, answered_at = ?,
            ended_at = ?, duration_ms = ?, end_reason = ?, thread_id = ?,
            session_id = ?, provider_call_sid = COALESCE(?, provider_call_sid), updated_at = ?
        WHERE tenant_id = ? AND id = ?
      `).run(
        call.direction,
        call.peer,
        status,
        startedAt,
        answeredAt,
        endedAt,
        durationMs,
        endReason,
        normalizeOptionalString(report.threadId),
        normalizeOptionalString(report.sessionId),
        call.providerCallSid ?? null,
        now,
        this.tenantId,
        call.id
      )
      if (ended && existing.status !== 'ended' && existing.status !== 'error') {
        this.writeAudit('call.ended', call.id, {
          status,
          endReason: normalizeEndReason(report.endReason, call),
          durationMs
        })
      }
    }

    if (status === 'ended' || status === 'error') {
      if (this.activeCallId === call.id) this.activeCallId = undefined
    } else {
      this.activeCallId = call.id
    }

    if (!existing) {
      this.emit({
        type: 'call.started',
        call: this.getCall(call.id) as CallSession
      })
    }
    if (status === 'ended' || status === 'error') {
      this.emit({
        type: 'call.ended',
        call: this.getCall(call.id) as CallSession
      })
    }
  }

  reportTranscriptEntry(entry: TranscriptEntry, actor: 'renderer' | 'main' = 'renderer'): void {
    const normalized = normalizeTranscriptEntry(entry)
    const callId = this.activeCallId
    if (!callId || !this.findSession(callId)) {
      this.writeAudit('transcript.dropped', undefined, {
        actor,
        entryId: normalized.id,
        reason: 'no active call session'
      })
      return
    }
    const counter = (this.transcriptCounters.get(callId) ?? -1) + 1
    this.transcriptCounters.set(callId, counter)
    this.database.prepare(`
      INSERT INTO transcript_entries (
        id, tenant_id, call_id, speaker, text, final, timestamp, seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        speaker = excluded.speaker,
        text = excluded.text,
        final = excluded.final,
        timestamp = excluded.timestamp,
        seq = excluded.seq
    `).run(
      normalized.id,
      this.tenantId,
      callId,
      normalized.speaker,
      normalized.text,
      normalized.final ? 1 : 0,
      normalized.timestamp,
      counter
    )
    if (normalized.final) {
      this.emit({ type: 'transcript.final', callId, entry: normalized })
    }
  }

  listCalls(request: ListCallsRequest): CallSummary[] {
    const { limit, offset } = normalizeListRequest(request)
    const rows = this.database.prepare(`
      SELECT * FROM call_sessions
      WHERE tenant_id = ?
      ORDER BY COALESCE(started_at, created_at) DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(this.tenantId, limit, offset) as unknown as CallSessionRow[]
    return rows.map(toCallSummary)
  }

  getCall(id: string): CallSession | undefined {
    const row = this.findSession(id)
    return row ? toCallSession(row) : undefined
  }

  getCallTranscript(id: string): TranscriptEntry[] {
    const callId = normalizeCallId(id)
    const rows = this.database.prepare(`
      SELECT * FROM transcript_entries
      WHERE tenant_id = ? AND call_id = ?
      ORDER BY seq ASC, timestamp ASC, rowid ASC
    `).all(this.tenantId, callId) as unknown as TranscriptEntryRow[]
    return rows.map(toTranscriptEntry)
  }

  getActiveCallId(): string | undefined {
    return this.activeCallId
  }

  putContactCard(card: ContactCard): ContactCard {
    this.database.prepare(`
      INSERT INTO contact_cards (
        tenant_id, phone, display_name, company, tier, language, time_zone, notes,
        facts_json, source, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, phone) DO UPDATE SET
        display_name = excluded.display_name,
        company = excluded.company,
        tier = excluded.tier,
        language = excluded.language,
        time_zone = excluded.time_zone,
        notes = excluded.notes,
        facts_json = excluded.facts_json,
        source = excluded.source,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      this.tenantId,
      card.phone,
      card.displayName ?? null,
      card.company ?? null,
      card.tier ?? null,
      card.language ?? null,
      card.timeZone ?? null,
      card.notes ?? null,
      JSON.stringify(card.facts),
      card.source,
      card.expiresAt ?? null,
      card.createdAt,
      card.updatedAt
    )
    return this.getContactCard(card.phone) as ContactCard
  }

  getContactCard(phone: string): ContactCard | undefined {
    const row = this.database.prepare('SELECT * FROM contact_cards WHERE tenant_id = ? AND phone = ?').get(this.tenantId, phone) as
      | ContactCardRow
      | undefined
    return row ? toContactCard(row) : undefined
  }

  listContactCards(request: ListContactCardsRequest = {}, now = Date.now()): ContactCard[] {
    const limit = normalizeLimit(request.limit)
    const offset = typeof request.offset === 'number' && Number.isFinite(request.offset)
      ? Math.max(0, Math.floor(request.offset))
      : 0
    const rows = this.database.prepare(`
      SELECT * FROM contact_cards
      WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC, phone ASC
      LIMIT ? OFFSET ?
    `).all(this.tenantId, now, limit, offset) as unknown as ContactCardRow[]
    return rows.map(toContactCard)
  }

  deleteContactCard(phone: string): boolean {
    return this.database.prepare('DELETE FROM contact_cards WHERE tenant_id = ? AND phone = ?').run(this.tenantId, phone).changes > 0
  }

  attachContactCard(callId: string, card: ContactCardSummary): CallSession {
    this.database.prepare(`
      UPDATE call_sessions
      SET contact_card_json = COALESCE(contact_card_json, ?), updated_at = updated_at
      WHERE tenant_id = ? AND id = ?
    `).run(JSON.stringify(card), this.tenantId, callId)
    const call = this.getCall(callId)
    if (!call) throw new Error('Call session does not exist')
    return call
  }

  createCallTask(task: CallTask): CallTask {
    this.database.prepare(`
      INSERT INTO call_tasks (
        id, tenant_id, to_number, campaign_id, goal, result_schema_json, constraints_json,
        callback_url, idempotency_key, status, attempts, call_id, result_id,
        outcome, error, created_by, created_at, updated_at, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      this.tenantId,
      task.to,
      task.campaignId,
      task.goal,
      task.resultSchema === undefined ? null : JSON.stringify(task.resultSchema),
      JSON.stringify(task.constraints),
      task.callbackUrl ?? null,
      task.idempotencyKey,
      task.status,
      task.attempts,
      task.callId ?? null,
      task.resultId ?? null,
      task.outcome ?? null,
      task.error ?? null,
      task.createdBy,
      task.createdAt,
      task.updatedAt,
      task.startedAt ?? null,
      task.endedAt ?? null
    )
    return this.getCallTask(task.id) as CallTask
  }

  getCallTask(id: string): CallTask | undefined {
    const row = this.database.prepare(`
      SELECT task.*, result.result_json
      FROM call_tasks task
      LEFT JOIN call_results result ON result.tenant_id = task.tenant_id AND result.id = task.result_id
      WHERE task.tenant_id = ? AND task.id = ?
    `).get(this.tenantId, id) as CallTaskRow | undefined
    return row ? toCallTask(row) : undefined
  }

  getCallTaskByIdempotencyKey(key: string): CallTask | undefined {
    const row = this.database.prepare(`
      SELECT task.*, result.result_json
      FROM call_tasks task
      LEFT JOIN call_results result ON result.tenant_id = task.tenant_id AND result.id = task.result_id
      WHERE task.tenant_id = ? AND task.idempotency_key = ?
    `).get(this.tenantId, key) as CallTaskRow | undefined
    return row ? toCallTask(row) : undefined
  }

  listCallTasks(request: ListCallTasksRequest = {}): CallTask[] {
    const limit = normalizeLimit(request.limit)
    const offset = typeof request.offset === 'number' && Number.isFinite(request.offset)
      ? Math.max(0, Math.floor(request.offset))
      : 0
    const rows = request.status
      ? this.database.prepare(`
          SELECT task.*, result.result_json
          FROM call_tasks task
          LEFT JOIN call_results result ON result.tenant_id = task.tenant_id AND result.id = task.result_id
          WHERE task.tenant_id = ? AND task.status = ?
          ORDER BY task.created_at DESC, task.id DESC LIMIT ? OFFSET ?
        `).all(this.tenantId, request.status, limit, offset)
      : this.database.prepare(`
          SELECT task.*, result.result_json
          FROM call_tasks task
          LEFT JOIN call_results result ON result.tenant_id = task.tenant_id AND result.id = task.result_id
          WHERE task.tenant_id = ?
          ORDER BY task.created_at DESC, task.id DESC LIMIT ? OFFSET ?
        `).all(this.tenantId, limit, offset)
    return (rows as unknown as CallTaskRow[]).map(toCallTask)
  }

  listQueuedCallTasks(): CallTask[] {
    const rows = this.database.prepare(`
      SELECT task.*, result.result_json
      FROM call_tasks task
      LEFT JOIN call_results result ON result.tenant_id = task.tenant_id AND result.id = task.result_id
      WHERE task.tenant_id = ? AND task.status = 'queued'
      ORDER BY task.created_at ASC, task.id ASC
    `).all(this.tenantId) as unknown as CallTaskRow[]
    return rows.map(toCallTask)
  }

  updateCallTask(id: string, patch: Partial<CallTask>): CallTask {
    const current = this.getCallTask(id)
    if (!current) throw new Error('Call task does not exist')
    const next = { ...current, ...patch }
    this.database.prepare(`
      UPDATE call_tasks SET
        status = ?, attempts = ?, call_id = ?, result_id = ?, outcome = ?,
        error = ?, updated_at = ?, started_at = ?, ended_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(
      next.status,
      next.attempts,
      next.callId ?? null,
      next.resultId ?? null,
      next.outcome ?? null,
      next.error ?? null,
      next.updatedAt,
      next.startedAt ?? null,
      next.endedAt ?? null,
      this.tenantId,
      id
    )
    return this.getCallTask(id) as CallTask
  }

  getCallBudget(): CallBudget {
    const row = this.database.prepare('SELECT * FROM call_budgets WHERE tenant_id = ?').get(this.tenantId) as unknown as CallBudgetRow
    return {
      enabled: row.enabled === 1,
      dailyMaxCalls: row.daily_max_calls,
      dailyMaxMinutes: row.daily_max_minutes,
      allowedPrefixes: JSON.parse(row.allowed_prefixes_json) as string[],
      allowedNumbers: JSON.parse(row.allowed_numbers_json) as string[],
      allowedHours: JSON.parse(row.allowed_hours_json) as CallBudget['allowedHours'],
      killSwitch: row.kill_switch === 1
    }
  }

  saveCallBudget(budget: CallBudget): CallBudget {
    this.database.prepare(`
      UPDATE call_budgets SET enabled = ?, daily_max_calls = ?, daily_max_minutes = ?,
        allowed_prefixes_json = ?, allowed_numbers_json = ?, allowed_hours_json = ?,
        kill_switch = ?, updated_at = ? WHERE tenant_id = ?
    `).run(
      budget.enabled ? 1 : 0,
      budget.dailyMaxCalls,
      budget.dailyMaxMinutes,
      JSON.stringify(budget.allowedPrefixes),
      JSON.stringify(budget.allowedNumbers),
      JSON.stringify(budget.allowedHours),
      budget.killSwitch ? 1 : 0,
      Date.now(),
      this.tenantId
    )
    return this.getCallBudget()
  }

  getDailyCallUsage(dayStart: number): { calls: number; minutes: number } {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS calls, COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM call_sessions WHERE tenant_id = ? AND direction = 'outbound' AND started_at >= ?
    `).get(this.tenantId, dayStart) as { calls: number; duration_ms: number }
    return { calls: row.calls, minutes: row.duration_ms / 60_000 }
  }

  getCallResult(callId: string, schemaHash: string): CallAnalysisResult | undefined {
    const row = this.database.prepare(`
      SELECT * FROM call_results WHERE tenant_id = ? AND call_id = ? AND schema_hash = ?
    `).get(this.tenantId, normalizeCallId(callId), schemaHash) as CallResultRow | undefined
    return row ? toCallAnalysisResult(row) : undefined
  }

  getLatestCallResult(callId: string): CallAnalysisResult | undefined {
    const row = this.database.prepare(`
      SELECT * FROM call_results
      WHERE tenant_id = ? AND call_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(this.tenantId, normalizeCallId(callId)) as CallResultRow | undefined
    return row ? toCallAnalysisResult(row) : undefined
  }

  putCallResult(result: CallAnalysisResult): CallAnalysisResult {
    const callId = normalizeCallId(result.callId)
    this.database.prepare(`
      INSERT INTO call_results (
        id, tenant_id, call_id, schema_hash, outcome, summary, result_json,
        confidence, model, created_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, call_id, schema_hash) DO NOTHING
    `).run(
      result.id,
      this.tenantId,
      callId,
      result.schemaHash,
      result.outcome,
      result.summary,
      result.result === undefined ? null : JSON.stringify(result.result),
      result.confidence,
      result.model,
      result.createdAt,
      result.error ?? null
    )
    const stored = this.getCallResult(callId, result.schemaHash)
    if (!stored) throw new Error('Failed to save call analysis result')
    return stored
  }

  enqueueAnalysisJob(input: EnqueueAnalysisJobInput): AnalysisJob {
    const callId = normalizeCallId(input.callId)
    this.database.prepare(`
      INSERT INTO analysis_jobs (
        tenant_id, call_id, schema_hash, schema_json, goal, status, attempts,
        next_attempt_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
      ON CONFLICT(tenant_id, call_id, schema_hash) DO NOTHING
    `).run(
      this.tenantId,
      callId,
      input.schemaHash,
      input.resultSchema === undefined ? null : JSON.stringify(input.resultSchema),
      input.goal ?? null,
      input.now,
      input.now,
      input.now
    )
    const job = this.getAnalysisJob(callId, input.schemaHash)
    if (!job) throw new Error('Failed to create call analysis job')
    return job
  }

  getAnalysisJob(callId: string, schemaHash: string): AnalysisJob | undefined {
    const row = this.database.prepare(`
      SELECT * FROM analysis_jobs WHERE tenant_id = ? AND call_id = ? AND schema_hash = ?
    `).get(this.tenantId, normalizeCallId(callId), schemaHash) as AnalysisJobRow | undefined
    return row ? toAnalysisJob(row) : undefined
  }

  listDueAnalysisJobs(now: number): AnalysisJob[] {
    const rows = this.database.prepare(`
      SELECT * FROM analysis_jobs
      WHERE tenant_id = ?
        AND status IN ('pending', 'failed')
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at <= ?
      ORDER BY created_at ASC, id ASC
    `).all(this.tenantId, now) as unknown as AnalysisJobRow[]
    return rows.map(toAnalysisJob)
  }

  markAnalysisJobProcessing(id: number, updatedAt: number): void {
    this.database.prepare(`
      UPDATE analysis_jobs SET status = 'processing', updated_at = ? WHERE tenant_id = ? AND id = ?
    `).run(updatedAt, this.tenantId, id)
  }

  markAnalysisJobSucceeded(id: number, attempts: number, updatedAt: number): void {
    this.database.prepare(`
      UPDATE analysis_jobs
      SET status = 'succeeded', attempts = ?, next_attempt_at = NULL,
          last_error = NULL, updated_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(attempts, updatedAt, this.tenantId, id)
  }

  markAnalysisJobFailed(id: number, failure: AnalysisJobFailure): void {
    this.database.prepare(`
      UPDATE analysis_jobs
      SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(
      failure.status,
      failure.attempts,
      failure.nextAttemptAt ?? null,
      failure.lastError,
      failure.updatedAt,
      this.tenantId,
      id
    )
  }

  recordGuardrailEvent(event: GuardrailEvent): void {
    const normalized = normalizeGuardrailEvent(event)
    const callId = normalized.callId
    if (callId === PRE_DIAL_CALL_ID) {
      this.writeAudit(`guardrail.${normalized.kind}`, undefined, {
        kind: normalized.kind,
        at: normalized.at,
        details: normalized.details
      })
      return
    }
    if (!this.findSession(callId)) throw new Error('Call session does not exist')
    this.writeAudit(`guardrail.${normalized.kind}`, callId, {
      kind: normalized.kind,
      at: normalized.at,
      details: normalized.details
    })
    this.emit({ type: 'guardrail.triggered', callId, guardrail: normalized })
  }

  listGuardrailEvents(callId: string): GuardrailEvent[] {
    const normalized = normalizeCallId(callId)
    const rows = this.database.prepare(`
      SELECT * FROM audit_log
      WHERE tenant_id = ? AND call_id = ? AND action LIKE 'guardrail.%'
      ORDER BY id ASC
    `).all(this.tenantId, normalized) as unknown as AuditLogRow[]
    return rows.map((row) => {
      const parsed = JSON.parse(row.details_json ?? '{}') as Record<string, unknown>
      return {
        callId: normalized,
        kind: row.action.slice('guardrail.'.length) as GuardrailEventKind,
        at: parsed.at as number,
        ...(parsed.details ? { details: parsed.details as Record<string, unknown> } : {})
      }
    })
  }

  getRecording(callId: string): RecordingInfo | undefined {
    const row = this.database.prepare('SELECT * FROM recordings WHERE tenant_id = ? AND call_id = ?').get(this.tenantId, callId) as
      | RecordingRow
      | undefined
    return row ? toRecordingInfo(row) : undefined
  }

  getRecordingPath(callId: string): string | undefined {
    const row = this.database.prepare('SELECT path FROM recordings WHERE tenant_id = ? AND call_id = ?').get(this.tenantId, callId) as
      | { path: string }
      | undefined
    return row?.path
  }

  putRecording(input: RecordingInput): void {
    const callId = normalizeCallId(input.callId)
    const now = Date.now()
    this.database.prepare(`
      INSERT INTO recordings (tenant_id, call_id, path, bytes, sha256, duration_ms, mime, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(call_id) DO UPDATE SET
        path = excluded.path,
        bytes = excluded.bytes,
        sha256 = excluded.sha256,
        duration_ms = excluded.duration_ms,
        mime = excluded.mime,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      this.tenantId,
      callId,
      input.path,
      null,
      null,
      null,
      input.mime ?? null,
      input.status,
      now,
      now
    )
  }

  updateRecordingStatus(
    callId: string,
    status: RecordingStatus,
    metadata?: { bytes?: number; sha256?: string; durationMs?: number }
  ): void {
    const normalized = normalizeCallId(callId)
    this.database.prepare(`
      UPDATE recordings
      SET bytes = ?, sha256 = ?, duration_ms = ?, status = ?, updated_at = ?
      WHERE tenant_id = ? AND call_id = ?
    `).run(
      metadata?.bytes ?? null,
      metadata?.sha256 ?? null,
      metadata?.durationMs ?? null,
      status,
      Date.now(),
      this.tenantId,
      normalized
    )
    if (status === 'complete') {
      const recording = this.getRecording(normalized)
      if (recording) this.emit({ type: 'recording.ready', callId: normalized, recording })
    }
  }

  listIncompleteRecordings(): Array<{ callId: string; path: string }> {
    const rows = this.database.prepare(`
      SELECT * FROM recordings WHERE tenant_id = ? AND status = 'recording'
    `).all(this.tenantId) as unknown as RecordingRow[]
    return rows.map(({ call_id, path }) => ({ callId: call_id, path }))
  }

  writeAudit(action: string, callId: string | undefined, details?: unknown, actor = 'main'): void {
    this.database.prepare(`
      INSERT INTO audit_log (tenant_id, at, actor, action, call_id, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      this.tenantId,
      Date.now(),
      actor.trim().slice(0, 80) || 'unknown',
      action,
      callId ?? null,
      details === undefined ? null : JSON.stringify(details)
    )
  }

  listAudit(request: { limit?: number } = {}): AuditEntry[] {
    const limit = normalizeLimit(request.limit)
    const rows = this.database.prepare(`
      SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?
    `).all(this.tenantId, limit) as unknown as AuditLogRow[]
    return rows.map(toAuditEntry)
  }

  listCallAudit(callId: string, request: { limit?: number; offset?: number } = {}): AuditEntry[] {
    const normalized = normalizeCallId(callId)
    const limit = normalizeLimit(request.limit)
    const offset = typeof request.offset === 'number' && Number.isFinite(request.offset)
      ? Math.max(0, Math.floor(request.offset))
      : 0
    const rows = this.database.prepare(`
      SELECT * FROM audit_log
      WHERE tenant_id = ? AND call_id = ?
      ORDER BY at ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(this.tenantId, normalized, limit, offset) as unknown as AuditLogRow[]
    return rows.map(toAuditEntry)
  }

  close(): void {
    this.database.close()
  }

  setVoiceUsage(callId: string, provider: 'codex' | 'gpt-live-api', seconds?: number): void {
    this.database.prepare('UPDATE call_sessions SET voice_provider = ?, voice_seconds = COALESCE(?, voice_seconds) WHERE tenant_id = ? AND id = ?')
      .run(provider, seconds ?? null, this.tenantId, callId)
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS call_sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        peer TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'ringing', 'dialing', 'connecting', 'active', 'held', 'ended', 'error')),
        started_at INTEGER,
        answered_at INTEGER,
        ended_at INTEGER,
        duration_ms INTEGER,
        end_reason TEXT,
        campaign_id TEXT,
        campaign_name TEXT,
        campaign_system_prompt TEXT,
        campaign_voice TEXT,
        runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('mock', 'twilio')),
        thread_id TEXT,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transcript_entries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
        speaker TEXT NOT NULL CHECK (speaker IN ('caller', 'assistant', 'system')),
        text TEXT NOT NULL,
        final INTEGER NOT NULL CHECK (final IN (0, 1)),
        timestamp INTEGER NOT NULL,
        seq INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS transcript_entries_call_seq
        ON transcript_entries (call_id, seq);
      CREATE TABLE IF NOT EXISTS recordings (
        call_id TEXT PRIMARY KEY REFERENCES call_sessions(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        path TEXT NOT NULL,
        bytes INTEGER,
        sha256 TEXT,
        duration_ms INTEGER,
        mime TEXT,
        status TEXT NOT NULL CHECK (status IN ('recording', 'complete', 'incomplete')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        call_id TEXT,
        details_json TEXT
      ) STRICT;
    `)
    const row = this.database.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
      | { version: number | null }
      | undefined
    let version = row?.version ?? 0
    if (row?.version === null || row?.version === undefined) {
      this.database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1)
      version = 1
    }
    if (version < 2) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE call_results (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
          call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
          schema_hash TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('reached', 'no_answer', 'voicemail', 'refused', 'wrong_number', 'error')),
          summary TEXT NOT NULL CHECK (length(summary) <= 400),
          result_json TEXT,
          confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
          model TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          error TEXT,
          UNIQUE(tenant_id, call_id, schema_hash)
        ) STRICT;
        CREATE INDEX call_results_call_created
          ON call_results (call_id, created_at DESC);
        CREATE TABLE analysis_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
          call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
          schema_hash TEXT NOT NULL,
          schema_json TEXT,
          goal TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(tenant_id, call_id, schema_hash)
        ) STRICT;
        CREATE INDEX analysis_jobs_due
          ON analysis_jobs (status, next_attempt_at);
        INSERT INTO schema_version (version) VALUES (2);
        COMMIT;
      `)
      version = 2
    }
    if (version < 3) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE call_tasks (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
          to_number TEXT NOT NULL,
          campaign_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          result_schema_json TEXT,
          constraints_json TEXT NOT NULL,
          callback_url TEXT,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'awaiting_approval', 'dialing', 'in_call', 'analyzing', 'completed', 'failed', 'cancelled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          call_id TEXT,
          result_id TEXT,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('reached', 'no_answer', 'voicemail', 'refused', 'wrong_number', 'error')),
          error TEXT,
          created_by TEXT NOT NULL CHECK (created_by IN ('http', 'mcp', 'ui', 'cli')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          ended_at INTEGER,
          UNIQUE(tenant_id, idempotency_key)
        ) STRICT;
        CREATE INDEX call_tasks_queue ON call_tasks (status, created_at);
        CREATE INDEX call_tasks_call ON call_tasks (call_id);
        CREATE TABLE call_budgets (
          tenant_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          daily_max_calls INTEGER NOT NULL,
          daily_max_minutes INTEGER NOT NULL,
          allowed_prefixes_json TEXT NOT NULL,
          allowed_numbers_json TEXT NOT NULL,
          allowed_hours_json TEXT NOT NULL,
          kill_switch INTEGER NOT NULL CHECK (kill_switch IN (0, 1)),
          updated_at INTEGER NOT NULL
        ) STRICT;
        INSERT INTO call_budgets (
          tenant_id, enabled, daily_max_calls, daily_max_minutes,
          allowed_prefixes_json, allowed_numbers_json, allowed_hours_json,
          kill_switch, updated_at
        ) VALUES ('${LOCAL_TENANT_ID}', 0, 0, 0, '[]', '[]', '{"timeZone":"UTC","windows":[]}', 0, 0);
        INSERT INTO schema_version (version) VALUES (3);
        COMMIT;
      `)
      version = 3
    }
    if (version < 4) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE contact_cards (
          tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
          phone TEXT NOT NULL,
          display_name TEXT,
          company TEXT,
          tier TEXT,
          language TEXT,
          time_zone TEXT,
          notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
          facts_json TEXT NOT NULL CHECK (length(facts_json) <= 4000),
          source TEXT NOT NULL,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, phone)
        ) STRICT;
        CREATE INDEX contact_cards_updated ON contact_cards (updated_at DESC);
        ALTER TABLE call_sessions ADD COLUMN contact_card_json TEXT;
        INSERT INTO schema_version (version) VALUES (4);
        COMMIT;
      `)
      version = 4
    }
    if (version < 5) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE call_sessions ADD COLUMN provider_call_sid TEXT;
        INSERT INTO schema_version (version) VALUES (5);
        COMMIT;
      `)
    }
    if (version < 6) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE call_sessions ADD COLUMN voice_provider TEXT NOT NULL DEFAULT 'codex';
        ALTER TABLE call_sessions ADD COLUMN voice_seconds REAL;
        INSERT INTO schema_version (version) VALUES (6);
        COMMIT;
      `)
      version = 6
    }
    if (version < 7) {
      this.migrateTenantScope()
    }
    this.database.exec(`
      UPDATE analysis_jobs
      SET status = 'failed', next_attempt_at = COALESCE(next_attempt_at, updated_at)
      WHERE status = 'processing';
    `)
  }

  private migrateTenantScope(): void {
    this.database.exec('PRAGMA foreign_keys = OFF;')
    this.database.exec('BEGIN IMMEDIATE;')
    try {
      const tables = [
        'call_sessions',
        'transcript_entries',
        'recordings',
        'audit_log',
        'call_results',
        'analysis_jobs',
        'call_tasks',
        'call_budgets',
        'contact_cards'
      ]
      for (const table of tables) ensureTenantColumn(this.database, table)

      if (!hasUniqueOn(this.database, 'call_results', ['tenant_id', 'call_id', 'schema_hash'])) {
        rebuildSqliteTable(
          this.database,
          'call_results',
          `CREATE TABLE call_results (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
            call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
            schema_hash TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN ('reached', 'no_answer', 'voicemail', 'refused', 'wrong_number', 'error')),
            summary TEXT NOT NULL CHECK (length(summary) <= 400),
            result_json TEXT,
            confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
            model TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            error TEXT,
            UNIQUE(tenant_id, call_id, schema_hash)
          ) STRICT;`,
          ['id', 'tenant_id', 'call_id', 'schema_hash', 'outcome', 'summary', 'result_json', 'confidence', 'model', 'created_at', 'error']
        )
        this.database.exec('CREATE INDEX IF NOT EXISTS call_results_call_created ON call_results (tenant_id, call_id, created_at DESC);')
      }
      if (!hasUniqueOn(this.database, 'analysis_jobs', ['tenant_id', 'call_id', 'schema_hash'])) {
        rebuildSqliteTable(
          this.database,
          'analysis_jobs',
          `CREATE TABLE analysis_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
            call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
            schema_hash TEXT NOT NULL,
            schema_json TEXT,
            goal TEXT,
            status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(tenant_id, call_id, schema_hash)
          ) STRICT;`,
          ['id', 'tenant_id', 'call_id', 'schema_hash', 'schema_json', 'goal', 'status', 'attempts', 'next_attempt_at', 'last_error', 'created_at', 'updated_at']
        )
        this.database.exec('CREATE INDEX IF NOT EXISTS analysis_jobs_due ON analysis_jobs (tenant_id, status, next_attempt_at);')
      }
      if (!hasUniqueOn(this.database, 'call_tasks', ['tenant_id', 'idempotency_key'])) {
        rebuildSqliteTable(
          this.database,
          'call_tasks',
          `CREATE TABLE call_tasks (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
            to_number TEXT NOT NULL,
            campaign_id TEXT NOT NULL,
            goal TEXT NOT NULL,
            result_schema_json TEXT,
            constraints_json TEXT NOT NULL,
            callback_url TEXT,
            idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued', 'awaiting_approval', 'dialing', 'in_call', 'analyzing', 'completed', 'failed', 'cancelled')),
            attempts INTEGER NOT NULL DEFAULT 0,
            call_id TEXT,
            result_id TEXT,
            outcome TEXT CHECK (outcome IS NULL OR outcome IN ('reached', 'no_answer', 'voicemail', 'refused', 'wrong_number', 'error')),
            error TEXT,
            created_by TEXT NOT NULL CHECK (created_by IN ('http', 'mcp', 'ui', 'cli')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            started_at INTEGER,
            ended_at INTEGER,
            UNIQUE(tenant_id, idempotency_key)
          ) STRICT;`,
          ['id', 'tenant_id', 'to_number', 'campaign_id', 'goal', 'result_schema_json', 'constraints_json', 'callback_url', 'idempotency_key', 'status', 'attempts', 'call_id', 'result_id', 'outcome', 'error', 'created_by', 'created_at', 'updated_at', 'started_at', 'ended_at']
        )
        this.database.exec(`
          CREATE INDEX IF NOT EXISTS call_tasks_queue ON call_tasks (tenant_id, status, created_at);
          CREATE INDEX IF NOT EXISTS call_tasks_call ON call_tasks (tenant_id, call_id);
        `)
      }
      if (primaryKeyColumns(this.database, 'contact_cards').join(',') !== 'tenant_id,phone') {
        rebuildSqliteTable(
          this.database,
          'contact_cards',
          `CREATE TABLE contact_cards (
            tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
            phone TEXT NOT NULL,
            display_name TEXT,
            company TEXT,
            tier TEXT,
            language TEXT,
            time_zone TEXT,
            notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
            facts_json TEXT NOT NULL CHECK (length(facts_json) <= 4000),
            source TEXT NOT NULL,
            expires_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (tenant_id, phone)
          ) STRICT;`,
          ['tenant_id', 'phone', 'display_name', 'company', 'tier', 'language', 'time_zone', 'notes', 'facts_json', 'source', 'expires_at', 'created_at', 'updated_at']
        )
        this.database.exec('CREATE INDEX IF NOT EXISTS contact_cards_updated ON contact_cards (tenant_id, updated_at DESC);')
      }
      if (primaryKeyColumns(this.database, 'call_budgets').join(',') !== 'tenant_id') {
        rebuildSqliteTable(
          this.database,
          'call_budgets',
          `CREATE TABLE call_budgets (
            tenant_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
            daily_max_calls INTEGER NOT NULL,
            daily_max_minutes INTEGER NOT NULL,
            allowed_prefixes_json TEXT NOT NULL,
            allowed_numbers_json TEXT NOT NULL,
            allowed_hours_json TEXT NOT NULL,
            kill_switch INTEGER NOT NULL CHECK (kill_switch IN (0, 1)),
            updated_at INTEGER NOT NULL
          ) STRICT;`,
          ['tenant_id', 'enabled', 'daily_max_calls', 'daily_max_minutes', 'allowed_prefixes_json', 'allowed_numbers_json', 'allowed_hours_json', 'kill_switch', 'updated_at']
        )
      }

      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS call_sessions_tenant_id ON call_sessions (tenant_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS transcript_entries_tenant_id ON transcript_entries (tenant_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS recordings_tenant_call ON recordings (tenant_id, call_id);
        CREATE INDEX IF NOT EXISTS audit_log_tenant ON audit_log (tenant_id, id);
      `)
      this.database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(7)
      this.database.exec('COMMIT;')
    } catch (error) {
      this.database.exec('ROLLBACK;')
      throw error
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON;')
    }
  }

  private ensureBudgetRow(): void {
    this.database.prepare(`
      INSERT INTO call_budgets (
        tenant_id, enabled, daily_max_calls, daily_max_minutes,
        allowed_prefixes_json, allowed_numbers_json, allowed_hours_json,
        kill_switch, updated_at
      ) VALUES (?, 0, 0, 0, '[]', '[]', '{"timeZone":"UTC","windows":[]}', 0, 0)
      ON CONFLICT(tenant_id) DO NOTHING
    `).run(this.tenantId)
  }

  private finalizeOrphanedSessions(now = Date.now()): void {
    const cutoff = now - ORPHANED_CALL_THRESHOLD_MS
    const rows = this.database.prepare(`
      SELECT id, status FROM call_sessions
      WHERE tenant_id = ?
        AND status IN ('dialing', 'connecting')
        AND ended_at IS NULL
        AND COALESCE(started_at, created_at) < ?
    `).all(this.tenantId, cutoff) as unknown as Array<{ id: string; status: CallStatus }>
    if (rows.length === 0) return

    this.database.exec('BEGIN IMMEDIATE;')
    try {
      const update = this.database.prepare(`
        UPDATE call_sessions
        SET status = 'ended', ended_at = ?, duration_ms = ?, end_reason = 'unknown', updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status IN ('dialing', 'connecting') AND ended_at IS NULL
      `)
      const audit = this.database.prepare(`
        INSERT INTO audit_log (tenant_id, at, actor, action, call_id, details_json)
        VALUES (?, ?, 'main', 'call.orphaned', ?, ?)
      `)
      for (const row of rows) {
        const session = this.findSession(row.id)
        if (!session) continue
        const startedAt = session.started_at ?? session.created_at
        const result = update.run(now, Math.max(0, now - startedAt), now, this.tenantId, row.id)
        if (result.changes === 1) {
          audit.run(this.tenantId, now, row.id, JSON.stringify({
            previousStatus: row.status,
            staleAfterMs: ORPHANED_CALL_THRESHOLD_MS
          }))
        }
      }
      this.database.exec('COMMIT;')
    } catch (error) {
      this.database.exec('ROLLBACK;')
      throw error
    }
  }

  private findSession(id: string): CallSessionRow | undefined {
    const row = this.database.prepare('SELECT * FROM call_sessions WHERE tenant_id = ? AND id = ?').get(this.tenantId, id) as
      | CallSessionRow
      | undefined
    return row
  }

  private emit(event: CallStoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.writeAudit('event.listener_error', 'callId' in event ? event.callId : undefined, {
          type: event.type,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}

function normalizeCall(call: PhoneCallLike): { id: string; direction: CallDirection; peer: string; status: CallStatus; providerCallSid?: string; startedAt?: number } {
  if (!call || typeof call !== 'object') throw new Error('Call data is invalid')
  const id = normalizeCallId(call.id)
  if (typeof call.direction !== 'string' || !DIRECTIONS.has(call.direction)) {
    throw new Error('Call direction is invalid')
  }
  const peer = normalizePeer(call.peer)
  if (typeof call.status !== 'string' || !CALL_STATUSES.has(call.status)) {
    throw new Error('Call status is invalid')
  }
  const providerCallSid = normalizeOptionalString(call.providerCallSid)
  return {
    id,
    direction: call.direction as CallDirection,
    peer,
    status: call.status as CallStatus,
    ...(providerCallSid !== null
      ? { providerCallSid }
      : {}),
    ...(typeof call.startedAt === 'number' && Number.isFinite(call.startedAt)
      ? { startedAt: Math.max(0, Math.floor(call.startedAt)) }
      : {})
  }
}

interface PhoneCallLike {
  id: unknown
  direction: unknown
  peer: unknown
  status: unknown
  providerCallSid?: unknown
  startedAt?: unknown
}

function normalizeCallId(id: unknown): string {
  if (typeof id !== 'string' || !id.trim() || id.length > MAX_ID_LENGTH) {
    throw new Error('Call ID is invalid')
  }
  return id.slice(0, MAX_ID_LENGTH)
}

function normalizePeer(peer: unknown): string {
  if (typeof peer !== 'string' || !peer.trim() || peer.length > MAX_PEER_LENGTH) {
    throw new Error('Call number is invalid')
  }
  return peer.trim().slice(0, MAX_PEER_LENGTH)
}

function normalizeOptionalString(value: unknown, maxLength = MAX_ID_LENGTH): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > maxLength) return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : null
}

function normalizeRuntimeMode(mode: unknown): RuntimeMode {
  if (typeof mode !== 'string' || !RUNTIME_MODES.has(mode)) throw new Error('Runtime mode is invalid')
  return mode as RuntimeMode
}

function normalizeEndReason(reason: unknown, call: { direction: CallDirection; status: CallStatus }): CallEndReason {
  if (typeof reason === 'string' && END_REASONS.has(reason)) return reason as CallEndReason
  if (call.status === 'error') return 'error'
  if (call.direction === 'inbound') return 'rejected'
  return 'unknown'
}

function normalizeTranscriptEntry(entry: TranscriptEntryLike): { id: string; speaker: TranscriptEntry['speaker']; text: string; final: boolean; timestamp: number } {
  if (!entry || typeof entry !== 'object') throw new Error('Transcript entry is invalid')
  const id = normalizeCallId(entry.id)
  if (typeof entry.speaker !== 'string' || !SPEAKERS.has(entry.speaker)) {
    throw new Error('Speaker is invalid')
  }
  if (typeof entry.text !== 'string') throw new Error('Transcript text is invalid')
  if (entry.text.length > MAX_TRANSCRIPT_TEXT) {
    throw new Error(`Transcript text cannot exceed ${MAX_TRANSCRIPT_TEXT} characters`)
  }
  const timestamp = typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
    ? Math.max(0, Math.floor(entry.timestamp))
    : Date.now()
  return {
    id,
    speaker: entry.speaker as TranscriptEntry['speaker'],
    text: entry.text,
    final: entry.final === true,
    timestamp
  }
}

interface TranscriptEntryLike {
  id: unknown
  speaker: unknown
  text: unknown
  final?: unknown
  timestamp?: unknown
}

function normalizeGuardrailEvent(event: GuardrailEvent): GuardrailEvent {
  if (!event || typeof event !== 'object') throw new Error('Guardrail event is invalid')
  const callId = normalizeCallId(event.callId)
  if (typeof event.kind !== 'string' || !GUARDRAIL_KINDS.has(event.kind)) {
    throw new Error('Guardrail event kind is invalid')
  }
  const at = typeof event.at === 'number' && Number.isFinite(event.at)
    ? Math.max(0, Math.floor(event.at))
    : Date.now()
  let details: Record<string, unknown> | undefined
  if (event.details !== undefined && event.details !== null) {
    if (typeof event.details !== 'object' || Array.isArray(event.details)) {
      throw new Error('Guardrail event details must be an object')
    }
    const serialized = JSON.stringify(event.details)
    if (serialized.length > MAX_GUARDRAIL_DETAILS_JSON) {
      throw new Error(`Guardrail event details cannot exceed ${MAX_GUARDRAIL_DETAILS_JSON} characters`)
    }
    details = event.details
  }
  return {
    callId,
    kind: event.kind as GuardrailEventKind,
    at,
    ...(details ? { details } : {})
  }
}

function normalizeListRequest(request: ListCallsRequest): { limit: number; offset: number } {
  return {
    limit: normalizeLimit(request?.limit),
    offset: typeof request?.offset === 'number' && Number.isFinite(request.offset)
      ? Math.max(0, Math.floor(request.offset))
      : 0
  }
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50
  return Math.min(500, Math.max(1, Math.floor(value)))
}

function toCallSession(row: CallSessionRow): CallSession {
  const contactCard = parseContactCardSummary(row.contact_card_json)
  return {
    voiceProvider: row.voice_provider,
    ...(row.voice_seconds !== null ? { voiceSeconds: row.voice_seconds } : {}),
    id: row.id,
    direction: row.direction,
    peer: row.peer,
    status: row.status,
    ...(row.provider_call_sid !== null ? { providerCallSid: row.provider_call_sid } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.end_reason !== null ? { endReason: row.end_reason } : {}),
    ...(row.campaign_id !== null ? { campaignId: row.campaign_id } : {}),
    ...(row.campaign_name !== null ? { campaignName: row.campaign_name } : {}),
    ...(row.campaign_system_prompt !== null ? { campaignSystemPrompt: row.campaign_system_prompt } : {}),
    ...(row.campaign_voice !== null ? { campaignVoice: row.campaign_voice } : {}),
    runtimeMode: row.runtime_mode,
    ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(contactCard ? { contactCard } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toContactCard(row: ContactCardRow): ContactCard {
  return {
    phone: row.phone,
    ...(row.display_name !== null ? { displayName: row.display_name } : {}),
    ...(row.company !== null ? { company: row.company } : {}),
    ...(row.tier !== null ? { tier: row.tier } : {}),
    ...(row.language !== null ? { language: row.language } : {}),
    ...(row.time_zone !== null ? { timeZone: row.time_zone } : {}),
    ...(row.notes !== null ? { notes: row.notes } : {}),
    facts: JSON.parse(row.facts_json) as Record<string, unknown>,
    source: row.source,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function parseContactCardSummary(value: string | null): ContactCardSummary | undefined {
  if (value === null) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ContactCardSummary
      : undefined
  } catch {
    return undefined
  }
}

function toCallSummary(row: CallSessionRow): CallSummary {
  return {
    voiceProvider: row.voice_provider,
    ...(row.voice_seconds !== null ? { voiceSeconds: row.voice_seconds } : {}),
    id: row.id,
    direction: row.direction,
    peer: maskPhoneNumber(row.peer),
    status: row.status,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.campaign_name !== null ? { campaignName: row.campaign_name } : {}),
    runtimeMode: row.runtime_mode,
    createdAt: row.created_at
  }
}

function toTranscriptEntry(row: TranscriptEntryRow): TranscriptEntry {
  return {
    id: row.id,
    speaker: row.speaker,
    text: row.text,
    final: row.final === 1,
    timestamp: row.timestamp
  }
}

function toAuditEntry(row: AuditLogRow): AuditEntry {
  let details: unknown
  if (row.details_json !== null) {
    try {
      details = JSON.parse(row.details_json)
    } catch {
      details = undefined
    }
  }
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    tenantId: row.tenant_id ?? LOCAL_TENANT_ID,
    ...(row.call_id !== null ? { callId: row.call_id } : {}),
    ...(details !== undefined ? { details } : {})
  }
}

function toRecordingInfo(row: RecordingRow): RecordingInfo {
  return {
    callId: row.call_id,
    playbackUrl: `live-phone-recording://call/${row.call_id}`,
    ...(row.bytes !== null ? { bytes: row.bytes } : {}),
    ...(row.sha256 !== null ? { sha256: row.sha256 } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.mime !== null ? { mime: row.mime } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toCallAnalysisResult(row: CallResultRow): CallAnalysisResult {
  let result: unknown
  if (row.result_json !== null) result = JSON.parse(row.result_json)
  return {
    id: row.id,
    callId: row.call_id,
    schemaHash: row.schema_hash,
    outcome: row.outcome,
    summary: row.summary,
    ...(row.result_json !== null ? { result } : {}),
    confidence: row.confidence,
    model: row.model,
    createdAt: row.created_at,
    ...(row.error !== null ? { error: row.error } : {})
  }
}

function toAnalysisJob(row: AnalysisJobRow): AnalysisJob {
  return {
    id: row.id,
    callId: row.call_id,
    schemaHash: row.schema_hash,
    ...(row.schema_json !== null
      ? { resultSchema: JSON.parse(row.schema_json) as Record<string, unknown> }
      : {}),
    ...(row.goal !== null ? { goal: row.goal } : {}),
    status: row.status,
    attempts: row.attempts,
    ...(row.next_attempt_at !== null ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toCallTask(row: CallTaskRow): CallTask {
  return {
    id: row.id,
    to: row.to_number,
    campaignId: row.campaign_id,
    goal: row.goal,
    ...(row.result_schema_json !== null
      ? { resultSchema: JSON.parse(row.result_schema_json) as Record<string, unknown> }
      : {}),
    constraints: JSON.parse(row.constraints_json) as CallTask['constraints'],
    ...(row.callback_url !== null ? { callbackUrl: row.callback_url } : {}),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    ...(row.call_id !== null ? { callId: row.call_id } : {}),
    ...(row.result_id !== null ? { resultId: row.result_id } : {}),
    ...(row.result_json !== null && row.result_json !== undefined
      ? { result: JSON.parse(row.result_json) as unknown }
      : {}),
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {})
  }
}
