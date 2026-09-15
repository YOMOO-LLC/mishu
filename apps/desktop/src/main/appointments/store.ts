import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Appointment,
  AppointmentSource,
  AppointmentStatus,
  ListAppointmentsRequest
} from '../../shared/contracts.js'
import type { CallStore } from '../call-store.js'
import { LOCAL_TENANT_ID } from '../tenant.js'
import { ensureTenantColumn, hasUniqueOn } from '../sqlite-tenant.js'
import { normalizeTimeZone } from './config-store.js'

const E164 = /^\+[1-9]\d{7,14}$/
const STATUSES = new Set<AppointmentStatus>(['tentative', 'confirmed', 'cancelled', 'failed'])
const SOURCES = new Set<AppointmentSource>(['copilot', 'mcp', 'manual'])

interface AppointmentRow {
  id: string
  call_id: string | null
  campaign_id: string
  peer: string
  contact_name: string | null
  start_at: string
  end_at: string
  time_zone: string
  status: AppointmentStatus
  source: AppointmentSource
  external_ref: string | null
  notes: string | null
  created_at: number
  updated_at: number
}

export interface CreateAppointmentInput {
  id?: string
  callId?: string
  campaignId: string
  peer: string
  contactName?: string
  startAt: string
  endAt: string
  timeZone: string
  status?: AppointmentStatus
  source: AppointmentSource
  externalRef?: string
  notes?: string
}

export type AppointmentStoreEvent =
  | { type: 'appointment.created'; appointment: Appointment }
  | { type: 'appointment.confirmed'; appointment: Appointment }
  | { type: 'appointment.failed'; appointment: Appointment; error?: string }

export class AppointmentStore {
  private readonly database: DatabaseSync
  private readonly listeners = new Set<(event: AppointmentStoreEvent) => void>()

  constructor(private readonly callStore: CallStore) {
    this.database = callStore.getDatabase()
    this.migrate()
  }

  private get tenantId(): string {
    return this.callStore.tenantId
  }

  onEvent(listener: (event: AppointmentStoreEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  create(input: CreateAppointmentInput): Appointment {
    const value = normalizeCreate(input)
    const now = Date.now()
    try {
      this.database.prepare(`
        INSERT INTO appointments (
          id, tenant_id, call_id, campaign_id, peer, contact_name, start_at, end_at,
          time_zone, status, source, external_ref, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        value.id,
        this.tenantId,
        value.callId ?? null,
        value.campaignId,
        value.peer,
        value.contactName ?? null,
        value.startAt,
        value.endAt,
        value.timeZone,
        value.status,
        value.source,
        value.externalRef ?? null,
        value.notes ?? null,
        now,
        now
      )
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed') && String(error).includes('appointments')) {
        const existing = this.findActiveByPeerAndStart(value.peer, value.startAt)
        if (existing) return existing
      }
      throw error
    }
    const appointment = this.get(value.id) as Appointment
    this.callStore.writeAudit('appointment.created', value.callId, {
      appointmentId: appointment.id,
      campaignId: appointment.campaignId,
      startAt: appointment.startAt,
      timeZone: appointment.timeZone,
      source: appointment.source
    })
    this.emit({ type: 'appointment.created', appointment })
    return appointment
  }

  update(id: string, input: Partial<Pick<Appointment, 'status' | 'externalRef' | 'notes'>> & { error?: string }): Appointment {
    const current = this.get(id)
    if (!current) throw new Error('Appointment does not exist')
    const status = input.status ?? current.status
    if (!STATUSES.has(status)) throw new Error('Appointment status is invalid')
    const externalRef = input.externalRef === undefined ? current.externalRef : optionalText(input.externalRef, 500)
    const notes = input.notes === undefined ? current.notes : optionalText(input.notes, 4_000)
    this.database.prepare(`
      UPDATE appointments
      SET status = ?, external_ref = ?, notes = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(status, externalRef ?? null, notes ?? null, Date.now(), this.tenantId, current.id)
    const appointment = this.get(current.id) as Appointment
    if (status !== current.status && (status === 'confirmed' || status === 'failed')) {
      const action = `appointment.${status}` as 'appointment.confirmed' | 'appointment.failed'
      this.callStore.writeAudit(action, appointment.callId, {
        appointmentId: appointment.id,
        ...(appointment.externalRef ? { externalRef: appointment.externalRef } : {}),
        ...(input.error ? { error: input.error.slice(0, 500) } : {})
      })
      this.emit(status === 'confirmed'
        ? { type: action, appointment }
        : { type: action, appointment, ...(input.error ? { error: input.error.slice(0, 500) } : {}) })
    }
    return appointment
  }

  get(id: string): Appointment | undefined {
    const row = this.database.prepare('SELECT * FROM appointments WHERE tenant_id = ? AND id = ?').get(this.tenantId, requiredText(id, 'appointment ID', 200)) as
      | AppointmentRow
      | undefined
    return row ? toAppointment(row) : undefined
  }

  list(request: ListAppointmentsRequest = {}): Appointment[] {
    const limit = integer(request.limit, 50, 1, 100)
    const offset = integer(request.offset, 0, 0, 1_000_000)
    const rows = this.database.prepare(`
      SELECT * FROM appointments
      WHERE tenant_id = ?
      ORDER BY start_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(this.tenantId, limit, offset) as unknown as AppointmentRow[]
    return rows.map(toAppointment)
  }

  getByCall(callId: string): Appointment[] {
    const rows = this.database.prepare(`
      SELECT * FROM appointments WHERE tenant_id = ? AND call_id = ? ORDER BY start_at ASC, created_at ASC
    `).all(this.tenantId, requiredText(callId, 'call ID', 200)) as unknown as AppointmentRow[]
    return rows.map(toAppointment)
  }

  listByPeer(peer: string): Appointment[] {
    const rows = this.database.prepare(`
      SELECT * FROM appointments WHERE tenant_id = ? AND peer = ? ORDER BY start_at ASC, created_at ASC
    `).all(this.tenantId, normalizePeer(peer)) as unknown as AppointmentRow[]
    return rows.map(toAppointment)
  }

  findActiveByPeerAndStart(peer: string, startAt: string): Appointment | undefined {
    const row = this.database.prepare(`
      SELECT * FROM appointments
      WHERE tenant_id = ? AND peer = ? AND start_at = ? AND status <> 'cancelled'
      ORDER BY created_at ASC LIMIT 1
    `).get(this.tenantId, normalizePeer(peer), normalizeDate(startAt, 'start time')) as AppointmentRow | undefined
    return row ? toAppointment(row) : undefined
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        call_id TEXT REFERENCES call_sessions(id) ON DELETE SET NULL,
        campaign_id TEXT NOT NULL,
        peer TEXT NOT NULL,
        contact_name TEXT,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('tentative', 'confirmed', 'cancelled', 'failed')),
        source TEXT NOT NULL CHECK (source IN ('copilot', 'mcp', 'manual')),
        external_ref TEXT,
        notes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS appointments_call_start ON appointments (call_id, start_at);
      CREATE INDEX IF NOT EXISTS appointments_peer_start ON appointments (peer, start_at);
    `)
    ensureTenantColumn(this.database, 'appointments')
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS appointments_tenant_id ON appointments (tenant_id, id);
      CREATE INDEX IF NOT EXISTS appointments_tenant_call_start ON appointments (tenant_id, call_id, start_at);
      CREATE INDEX IF NOT EXISTS appointments_tenant_peer_start ON appointments (tenant_id, peer, start_at);
    `)
    if (!hasUniqueOn(this.database, 'appointments', ['tenant_id', 'peer', 'start_at'])) {
      this.database.exec('DROP INDEX IF EXISTS appointments_peer_start_active;')
      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS appointments_peer_start_active
          ON appointments (tenant_id, peer, start_at) WHERE status <> 'cancelled';
      `)
    }
    const row = this.database.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null }
    if ((row.version ?? 0) < 2) this.database.prepare('INSERT INTO schema_version (version) VALUES (2)').run()
  }

  private emit(event: AppointmentStoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.callStore.writeAudit('appointment.listener_error', event.appointment.callId, {
          type: event.type,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}

function normalizeCreate(input: CreateAppointmentInput): Required<Omit<CreateAppointmentInput, 'callId' | 'contactName' | 'externalRef' | 'notes'>> & Pick<CreateAppointmentInput, 'callId' | 'contactName' | 'externalRef' | 'notes'> {
  if (!input || typeof input !== 'object') throw new Error('Appointment data is invalid')
  const startAt = normalizeDate(input.startAt, 'start time')
  const endAt = normalizeDate(input.endAt, 'end time')
  if (Date.parse(endAt) <= Date.parse(startAt)) throw new Error('Appointment end time must be later than start time')
  if (!SOURCES.has(input.source)) throw new Error('Appointment source is invalid')
  const status = input.status ?? 'tentative'
  if (!STATUSES.has(status)) throw new Error('Appointment status is invalid')
  return {
    id: input.id === undefined ? randomUUID() : requiredText(input.id, 'appointment ID', 200),
    callId: input.callId === undefined ? undefined : requiredText(input.callId, 'call ID', 200),
    campaignId: requiredText(input.campaignId, 'Campaign ID', 200),
    peer: normalizePeer(input.peer),
    contactName: optionalText(input.contactName, 200),
    startAt,
    endAt,
    timeZone: normalizeTimeZone(input.timeZone),
    status,
    source: input.source,
    externalRef: optionalText(input.externalRef, 500),
    notes: optionalText(input.notes, 4_000)
  }
}

function normalizeDate(input: unknown, label: string): string {
  if (typeof input !== 'string' || !input.trim() || !Number.isFinite(Date.parse(input))) {
    throw new Error(`${label} must be an ISO 8601 datetime`)
  }
  return new Date(input).toISOString()
}

function normalizePeer(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Appointment number is invalid')
  const value = input.replace(/[\s().-]/g, '')
  if (!E164.test(value)) throw new Error('Appointment number must be E.164')
  return value
}

function requiredText(input: unknown, label: string, max: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max) throw new Error(`${label} is invalid`)
  return input.trim()
}

function optionalText(input: unknown, max: number): string | undefined {
  if (input === undefined || input === null || input === '') return undefined
  if (typeof input !== 'string' || input.length > max) throw new Error('Appointment text field is invalid')
  const value = input.trim()
  return value || undefined
}

function integer(input: unknown, fallback: number, min: number, max: number): number {
  return typeof input === 'number' && Number.isSafeInteger(input)
    ? Math.min(max, Math.max(min, input))
    : fallback
}

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    ...(row.call_id ? { callId: row.call_id } : {}),
    campaignId: row.campaign_id,
    peer: row.peer,
    ...(row.contact_name ? { contactName: row.contact_name } : {}),
    startAt: row.start_at,
    endAt: row.end_at,
    timeZone: row.time_zone,
    status: row.status,
    source: row.source,
    ...(row.external_ref ? { externalRef: row.external_ref } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
