import type { DatabaseSync } from 'node:sqlite'
import type { CallStore, CallStoreEvent } from '../call-store.js'
import { LOCAL_TENANT_ID } from '../tenant.js'
import { ensureTenantColumn, hasUniqueOn, rebuildSqliteTable } from '../sqlite-tenant.js'
import type { WebhookBridge } from '../webhook/bridge.js'
import type { CalendarAdapter } from './calendar-adapter.js'
import type { AppointmentStore } from './store.js'

const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 300_000] as const

interface SyncJobRow {
  id: number
  appointment_id: string
  call_id: string | null
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead'
  attempts: number
  next_attempt_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface AppointmentSyncLogEntry {
  id: number
  appointmentId: string
  callId?: string
  status: SyncJobRow['status']
  attempts: number
  nextAttemptAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface AppointmentPostCallSyncOptions {
  callStore: CallStore
  appointmentStore: AppointmentStore
  getCalendar(): CalendarAdapter
  isAutoConfirm(): boolean
  webhookBridge: WebhookBridge
  now?: () => number
}

export class AppointmentPostCallSync {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private readonly unsubscribe: () => void
  private scheduler?: NodeJS.Timeout
  private processing = false

  constructor(private readonly options: AppointmentPostCallSyncOptions) {
    this.database = options.callStore.getDatabase()
    this.now = options.now ?? Date.now
    this.migrate()
    this.unsubscribe = options.callStore.onEvent((event) => this.handleEvent(event))
  }

  startScheduler(intervalMs = 5_000): void {
    if (this.scheduler) return
    this.scheduler = setInterval(() => void this.processDue(), Math.max(100, intervalMs))
    this.scheduler.unref?.()
  }

  dispose(): void {
    this.unsubscribe()
    if (this.scheduler) clearInterval(this.scheduler)
    this.scheduler = undefined
  }

  list(limit = 20): AppointmentSyncLogEntry[] {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 20
    const rows = this.database.prepare(`
      SELECT * FROM appointment_sync_jobs WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(this.options.callStore.tenantId, safeLimit) as unknown as SyncJobRow[]
    return rows.map((row) => ({
      id: row.id,
      appointmentId: row.appointment_id,
      ...(row.call_id ? { callId: row.call_id } : {}),
      status: row.status,
      attempts: row.attempts,
      ...(row.next_attempt_at !== null ? { nextAttemptAt: row.next_attempt_at } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  async processDue(now = this.now()): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      const rows = this.database.prepare(`
        SELECT * FROM appointment_sync_jobs
        WHERE tenant_id = ? AND status IN ('pending', 'failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
        ORDER BY created_at ASC, id ASC
      `).all(this.options.callStore.tenantId, now) as unknown as SyncJobRow[]
      for (const row of rows) await this.processJob(row, now)
    } finally {
      this.processing = false
    }
  }

  private handleEvent(event: CallStoreEvent): void {
    if (event.type !== 'call.ended') return
    const appointments = this.options.appointmentStore.getByCall(event.call.id)
      .filter((appointment) => appointment.status === 'tentative')
    if (!this.options.isAutoConfirm()) {
      for (const appointment of appointments) {
        this.options.webhookBridge.publishAppointmentEvent('appointment.created', appointment)
      }
      return
    }
    const now = this.now()
    for (const appointment of appointments) {
      this.database.prepare(`
        INSERT INTO appointment_sync_jobs (
          tenant_id, appointment_id, call_id, status, attempts, next_attempt_at,
          last_error, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
        ON CONFLICT(tenant_id, appointment_id) DO NOTHING
      `).run(this.options.callStore.tenantId, appointment.id, appointment.callId ?? null, now, now, now)
    }
    void this.processDue(now).catch((error) => {
      this.options.callStore.writeAudit('appointment.sync.scheduler_error', event.call.id, {
        error: errorMessage(error)
      })
    })
  }

  private async processJob(job: SyncJobRow, now: number): Promise<void> {
    this.database.prepare(`
      UPDATE appointment_sync_jobs SET status = 'processing', updated_at = ? WHERE tenant_id = ? AND id = ?
    `).run(now, this.options.callStore.tenantId, job.id)
    try {
      const appointment = this.options.appointmentStore.get(job.appointment_id)
      if (!appointment) throw new Error('Appointment record does not exist')
      if (appointment.status === 'confirmed' && appointment.externalRef) {
        this.markSucceeded(job, appointment.updatedAt)
        return
      }
      const result = await this.options.getCalendar().createEvent(appointment)
      const confirmed = this.options.appointmentStore.update(appointment.id, {
        status: 'confirmed',
        externalRef: result.externalRef
      })
      const completedAt = this.now()
      this.markSucceeded(job, completedAt)
      this.options.webhookBridge.publishAppointmentEvent('appointment.confirmed', confirmed)
    } catch (error) {
      const attempts = job.attempts + 1
      const lastError = errorMessage(error).slice(0, 500)
      const dead = attempts >= RETRY_BACKOFF_MS.length
      const appointment = this.options.appointmentStore.get(job.appointment_id)
      if (appointment && appointment.status !== 'confirmed') {
        const failed = this.options.appointmentStore.update(appointment.id, { status: 'failed', error: lastError })
        this.options.webhookBridge.publishAppointmentEvent('appointment.failed', failed, lastError)
      }
      this.database.prepare(`
        UPDATE appointment_sync_jobs
        SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?
      `).run(
        dead ? 'dead' : 'failed',
        attempts,
        dead ? null : now + RETRY_BACKOFF_MS[attempts - 1],
        lastError,
        this.now(),
        this.options.callStore.tenantId,
        job.id
      )
    }
  }

  private markSucceeded(job: SyncJobRow, at: number): void {
    this.database.prepare(`
      UPDATE appointment_sync_jobs
      SET status = 'succeeded', attempts = ?, next_attempt_at = NULL,
          last_error = NULL, updated_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(job.attempts + 1, at, this.options.callStore.tenantId, job.id)
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS appointment_sync_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
        call_id TEXT REFERENCES call_sessions(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(tenant_id, appointment_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS appointment_sync_jobs_due
        ON appointment_sync_jobs (status, next_attempt_at);
      UPDATE appointment_sync_jobs SET status = 'failed'
        WHERE status = 'processing';
    `)
    ensureTenantColumn(this.database, 'appointment_sync_jobs')
    if (!hasUniqueOn(this.database, 'appointment_sync_jobs', ['tenant_id', 'appointment_id'])) {
      this.database.exec('PRAGMA foreign_keys = OFF;')
      try {
        rebuildSqliteTable(
          this.database,
          'appointment_sync_jobs',
          `CREATE TABLE appointment_sync_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
            appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
            call_id TEXT REFERENCES call_sessions(id) ON DELETE SET NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(tenant_id, appointment_id)
          ) STRICT;`,
          ['id', 'tenant_id', 'appointment_id', 'call_id', 'status', 'attempts', 'next_attempt_at', 'last_error', 'created_at', 'updated_at']
        )
      } finally {
        this.database.exec('PRAGMA foreign_keys = ON;')
      }
      this.database.exec(
        'CREATE INDEX IF NOT EXISTS appointment_sync_jobs_due ON appointment_sync_jobs (tenant_id, status, next_attempt_at);'
      )
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
