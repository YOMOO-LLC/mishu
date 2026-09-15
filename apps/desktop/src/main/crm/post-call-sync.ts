import type { DatabaseSync } from 'node:sqlite'
import type { CallSession } from '../../shared/contracts.js'
import type { CallStore, CallStoreEvent } from '../call-store.js'
import { LOCAL_TENANT_ID } from '../tenant.js'
import { ensureTenantColumn, hasUniqueOn, rebuildSqliteTable } from '../sqlite-tenant.js'
import type { WebhookBridge } from '../webhook/bridge.js'
import type { CrmClient, CrmRecordRef } from './client.js'

const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 300_000] as const
const TRANSCRIPT_LIMIT = 8

interface SyncJobRow {
  id: number
  call_id: string
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead'
  attempts: number
  next_attempt_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface CrmSyncLogEntry {
  id: number
  callId: string
  status: SyncJobRow['status']
  attempts: number
  createdAt: number
  updatedAt: number
  lastError?: string
}

export interface PostCallSyncOptions {
  callStore: CallStore
  getClient: () => CrmClient
  isEnabled: () => boolean
  webhookBridge: WebhookBridge
  onSuccess?: (at: number) => void
  onError?: (message: string) => void
  now?: () => number
}

export class PostCallSync {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private readonly unsubscribe: () => void
  private scheduler: NodeJS.Timeout | undefined
  private processing = false

  constructor(private readonly options: PostCallSyncOptions) {
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

  list(limit = 20): CrmSyncLogEntry[] {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 20
    const rows = this.database.prepare(
      'SELECT * FROM crm_sync_jobs WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    ).all(this.options.callStore.tenantId, safeLimit) as unknown as SyncJobRow[]
    return rows.map((row) => ({
      id: row.id,
      callId: row.call_id,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_error ? { lastError: row.last_error } : {})
    }))
  }

  async processDue(now = this.now()): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      const jobs = this.database.prepare(`
        SELECT * FROM crm_sync_jobs
        WHERE tenant_id = ? AND status IN ('pending', 'failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
        ORDER BY created_at ASC, id ASC
      `).all(this.options.callStore.tenantId, now) as unknown as SyncJobRow[]
      for (const job of jobs) await this.processJob(job, now)
    } finally {
      this.processing = false
    }
  }

  private handleEvent(event: CallStoreEvent): void {
    if (event.type !== 'call.ended' || !this.options.isEnabled()) return
    const now = this.now()
    this.database.prepare(`
      INSERT INTO crm_sync_jobs (
        tenant_id, call_id, status, attempts, next_attempt_at, last_error, created_at, updated_at
      ) VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?)
      ON CONFLICT(tenant_id, call_id) DO NOTHING
    `).run(this.options.callStore.tenantId, event.call.id, now, now, now)
    void this.processDue(now).catch((error) => {
      this.options.callStore.writeAudit('crm.sync.scheduler_error', event.call.id, {
        error: message(error)
      })
    })
  }

  private async processJob(job: SyncJobRow, now: number): Promise<void> {
    this.database.prepare(
      "UPDATE crm_sync_jobs SET status = 'processing', updated_at = ? WHERE tenant_id = ? AND id = ?"
    ).run(now, this.options.callStore.tenantId, job.id)
    try {
      const call = this.options.callStore.getCall(job.call_id)
      if (!call) throw new Error('Call record does not exist')
      const client = this.options.getClient()
      let contact = await client.lookupByPhone(call.peer)
      this.options.callStore.writeAudit('crm.lookup.completed', call.id, {
        found: Boolean(contact)
      })
      let recordRef: CrmRecordRef
      if (!contact) {
        const lead = await client.createLead({
          lastName: leadName(call.peer),
          company: 'Mishu',
          phone: call.peer,
          description: `Created automatically from call ${call.id}`
        })
        recordRef = { module: 'Leads', id: lead.id }
        this.options.callStore.writeAudit('crm.lead.created', call.id, {
          module: recordRef.module,
          recordId: recordRef.id
        })
      } else {
        recordRef = contact.recordRef
      }
      await client.addNote(recordRef, this.buildNote(call))
      this.options.callStore.writeAudit('crm.note.created', call.id, {
        module: recordRef.module,
        recordId: recordRef.id
      })
      const completedAt = this.now()
      this.database.prepare(`
        UPDATE crm_sync_jobs
        SET status = 'succeeded', attempts = ?, next_attempt_at = NULL,
            last_error = NULL, updated_at = ?
        WHERE tenant_id = ? AND id = ?
      `).run(job.attempts + 1, completedAt, this.options.callStore.tenantId, job.id)
      this.options.callStore.writeAudit('crm.synced', call.id, { status: 'succeeded' })
      this.options.webhookBridge.publishExternalEvent(
        'crm.synced',
        { callId: call.id, status: 'succeeded' },
        `crm.synced:${call.id}`
      )
      this.options.onSuccess?.(completedAt)
    } catch (error) {
      const attempts = job.attempts + 1
      const lastError = message(error).slice(0, 500)
      const dead = attempts >= RETRY_BACKOFF_MS.length
      this.database.prepare(`
        UPDATE crm_sync_jobs
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
      this.options.callStore.writeAudit('crm.sync.failed', job.call_id, {
        attempts,
        retrying: !dead,
        error: lastError
      })
      this.options.onError?.(lastError)
    }
  }

  private buildNote(call: CallSession): string {
    const transcript = this.options.callStore.getCallTranscript(call.id)
      .filter((entry) => entry.final)
      .slice(0, TRANSCRIPT_LIMIT)
      .map((entry) => `${entry.speaker}: ${entry.text.slice(0, 500)}`)
    const duration = call.durationMs === undefined ? 'unknown' : `${Math.round(call.durationMs / 1_000)}s`
    return [
      `Call duration: ${duration}`,
      `Outcome: ${call.endReason ?? call.status}`,
      `Campaign: ${call.campaignName ?? 'unspecified'}`,
      ...(transcript.length ? ['Transcript summary:', ...transcript] : ['Transcript summary: none'])
    ].join('\n')
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS crm_sync_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(tenant_id, call_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS crm_sync_jobs_due
        ON crm_sync_jobs (status, next_attempt_at);
      UPDATE crm_sync_jobs SET status = 'failed'
        WHERE status = 'processing';
    `)
    ensureTenantColumn(this.database, 'crm_sync_jobs')
    if (!hasUniqueOn(this.database, 'crm_sync_jobs', ['tenant_id', 'call_id'])) {
      this.database.exec('PRAGMA foreign_keys = OFF;')
      try {
        rebuildSqliteTable(
          this.database,
          'crm_sync_jobs',
          `CREATE TABLE crm_sync_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
            call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(tenant_id, call_id)
          ) STRICT;`,
          ['id', 'tenant_id', 'call_id', 'status', 'attempts', 'next_attempt_at', 'last_error', 'created_at', 'updated_at']
        )
      } finally {
        this.database.exec('PRAGMA foreign_keys = ON;')
      }
      this.database.exec('CREATE INDEX IF NOT EXISTS crm_sync_jobs_due ON crm_sync_jobs (tenant_id, status, next_attempt_at);')
    }
  }
}

function leadName(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `Phone lead ${digits.slice(-4) || 'unknown'}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
