import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WEBHOOK_SEND_LEGACY_HEADERS } from '../../shared/app-identity.js'
import { LOCAL_TENANT_ID, normalizeTenantId } from '../tenant.js'
import { ensureTenantColumn, hasUniqueOn, rebuildSqliteTable } from '../sqlite-tenant.js'
import { buildSignatureHeader } from './signer.js'
import {
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_DEFAULT_USER_AGENT,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_RETRY_BACKOFF_MS,
  buildWebhookDeliveryHeaders,
  type WebhookConfig,
  type WebhookDeliveryStatus,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookOutboxRecord
} from './types.js'

interface OutboxRow {
  id: string
  tenant_id: string
  event_type: WebhookEventType
  payload_json: string
  created_at: number
  attempts: number
  next_attempt_at: number | null
  status: WebhookDeliveryStatus
  last_status_code: number | null
  last_error: string | null
  delivered_at: number | null
  idempotency_key: string | null
}

export interface WebhookOutboxOptions {
  database: DatabaseSync
  tenantId?: string
  getConfig?: () => WebhookConfig | undefined
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string
  sendLegacyHeaders?: boolean
}

export interface EnqueueInput {
  event: WebhookEventType
  data?: unknown
  idempotencyKey?: string
  createdAt?: number
}

export interface EnqueueResult {
  id: string
  alreadyExisted: boolean
}

export interface DeliverDueResult {
  delivered: number
  failed: number
  dead: number
  skipped: number
}

export class WebhookOutbox {
  readonly tenantId: string
  private readonly database: DatabaseSync
  private readonly getConfig: () => WebhookConfig | undefined
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly userAgent: string
  private readonly sendLegacyHeaders: boolean
  private scheduler: NodeJS.Timeout | null = null
  private delivering = false

  constructor(options: WebhookOutboxOptions) {
    this.database = options.database
    this.tenantId = normalizeTenantId(options.tenantId ?? LOCAL_TENANT_ID)
    this.getConfig = options.getConfig ?? (() => undefined)
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS
    this.userAgent = options.userAgent ?? WEBHOOK_DEFAULT_USER_AGENT
    this.sendLegacyHeaders = options.sendLegacyHeaders ?? WEBHOOK_SEND_LEGACY_HEADERS
    this.migrate()
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    const event = normalizeEventType(input.event)
    const createdAt = normalizeTimestamp(input.createdAt)
    if (input.idempotencyKey !== undefined) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey)
      if (existing) return { id: existing.id, alreadyExisted: true }
    }
    const id = randomUUID()
    const payload: WebhookEvent = { event, id, createdAt, tenantId: this.tenantId, data: input.data ?? null }
    try {
      this.database.prepare(`
        INSERT INTO webhook_outbox (
          id, tenant_id, event_type, payload_json, created_at, attempts, next_attempt_at,
          status, last_status_code, last_error, delivered_at, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', NULL, NULL, NULL, ?)
      `).run(id, this.tenantId, event, JSON.stringify(payload), createdAt, createdAt, input.idempotencyKey ?? null)
    } catch (error) {
      if (input.idempotencyKey !== undefined && isUniqueViolation(error)) {
        const existing = this.findByIdempotencyKey(input.idempotencyKey)
        if (existing) return { id: existing.id, alreadyExisted: true }
      }
      throw error
    }
    return { id, alreadyExisted: false }
  }

  async deliverDue(now = Date.now()): Promise<DeliverDueResult> {
    const result: DeliverDueResult = { delivered: 0, failed: 0, dead: 0, skipped: 0 }
    if (this.delivering) return result
    this.delivering = true
    try {
      const config = this.getConfig()
      if (!config || !config.enabled) return result
      const rows = this.database.prepare(`
        SELECT * FROM webhook_outbox
        WHERE tenant_id = ?
          AND status IN ('pending', 'failed', 'delivering')
          AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
        ORDER BY created_at ASC
      `).all(this.tenantId, now) as unknown as OutboxRow[]
      for (const row of rows) {
        if (!config.events.includes(row.event_type)) {
          result.skipped += 1
          continue
        }
        const outcome = await this.deliverOne(row, config, now)
        result[outcome] += 1
      }
      return result
    } finally {
      this.delivering = false
    }
  }

  getStatus(id: string): WebhookOutboxRecord | undefined {
    const row = this.database.prepare('SELECT * FROM webhook_outbox WHERE tenant_id = ? AND id = ?').get(this.tenantId, id) as
      | OutboxRow
      | undefined
    return row ? toRecord(row) : undefined
  }

  list(limit = 50): WebhookOutboxRecord[] {
    const rows = this.database.prepare(
      'SELECT * FROM webhook_outbox WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(this.tenantId, limit) as unknown as OutboxRow[]
    return rows.map(toRecord)
  }

  startScheduler(intervalMs: number): void {
    if (this.scheduler) return
    this.scheduler = setInterval(() => {
      void this.deliverDue().catch(() => undefined)
    }, Math.max(100, Math.floor(intervalMs)))
    this.scheduler.unref?.()
  }

  stopScheduler(): void {
    if (this.scheduler) {
      clearInterval(this.scheduler)
      this.scheduler = null
    }
  }

  close(): void {
    this.stopScheduler()
  }

  private async deliverOne(
    row: OutboxRow,
    config: WebhookConfig,
    now: number
  ): Promise<'delivered' | 'failed' | 'dead'> {
    const body = row.payload_json
    const timestamp = Date.now()
    const headers = buildWebhookDeliveryHeaders({
      signature: buildSignatureHeader(config.secret, body, timestamp),
      event: row.event_type,
      deliveryId: row.id,
      userAgent: this.userAgent,
      sendLegacyHeaders: this.sendLegacyHeaders
    })
    this.database.prepare(`UPDATE webhook_outbox SET status = 'delivering' WHERE tenant_id = ? AND id = ?`).run(this.tenantId, row.id)
    let statusCode: number | null = null
    let errorMessage: string | null = null
    try {
      const response = await this.fetchImpl(config.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      statusCode = response.status
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    const attempts = row.attempts + 1
    if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
      this.database.prepare(`
        UPDATE webhook_outbox
        SET status = 'delivered', attempts = ?, last_status_code = ?, last_error = NULL,
            delivered_at = ?, next_attempt_at = NULL
        WHERE tenant_id = ? AND id = ?
      `).run(attempts, statusCode, now, this.tenantId, row.id)
      return 'delivered'
    }

    const lastError = statusCode !== null ? `HTTP ${statusCode}` : (errorMessage ?? 'delivery failed')
    if (attempts >= MAX_WEBHOOK_ATTEMPTS) {
      this.database.prepare(`
        UPDATE webhook_outbox
        SET status = 'dead', attempts = ?, last_status_code = ?, last_error = ?,
            next_attempt_at = NULL
        WHERE tenant_id = ? AND id = ?
      `).run(attempts, statusCode, lastError, this.tenantId, row.id)
      return 'dead'
    }

    const backoffMs = WEBHOOK_RETRY_BACKOFF_MS[attempts - 1]
    this.database.prepare(`
      UPDATE webhook_outbox
      SET status = 'failed', attempts = ?, last_status_code = ?, last_error = ?,
          next_attempt_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(attempts, statusCode, lastError, now + backoffMs, this.tenantId, row.id)
    return 'failed'
  }

  private findByIdempotencyKey(key: string): OutboxRow | undefined {
    return this.database.prepare(
      'SELECT * FROM webhook_outbox WHERE tenant_id = ? AND idempotency_key = ?'
    ).get(this.tenantId, key) as OutboxRow | undefined
  }

  private migrate(): void {
    const eventTypes = WEBHOOK_EVENT_TYPES.map((t) => `'${t}'`).join(', ')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS webhook_schema_version (
        version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS webhook_outbox (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
        event_type TEXT NOT NULL CHECK (event_type IN (${eventTypes})),
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')),
        last_status_code INTEGER,
        last_error TEXT,
        delivered_at INTEGER,
        idempotency_key TEXT,
        UNIQUE(tenant_id, idempotency_key)
      ) STRICT;
    `)
    const row = this.database.prepare(
      'SELECT MAX(version) AS version FROM webhook_schema_version'
    ).get() as { version: number | null } | undefined
    if (row?.version === null || row?.version === undefined) {
      this.database.prepare('INSERT INTO webhook_schema_version (version) VALUES (?)').run(3)
      return
    }
    if (row.version < 2) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE webhook_outbox RENAME TO webhook_outbox_v1;
        CREATE TABLE webhook_outbox (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL CHECK (event_type IN (${eventTypes})),
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER,
          status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')),
          last_status_code INTEGER,
          last_error TEXT,
          delivered_at INTEGER,
          idempotency_key TEXT UNIQUE
        ) STRICT;
        INSERT INTO webhook_outbox (
          id, event_type, payload_json, created_at, attempts, next_attempt_at,
          status, last_status_code, last_error, delivered_at, idempotency_key
        ) SELECT
          id, event_type, payload_json, created_at, attempts, next_attempt_at,
          status, last_status_code, last_error, delivered_at, idempotency_key
        FROM webhook_outbox_v1;
        DROP TABLE webhook_outbox_v1;
        INSERT INTO webhook_schema_version (version) VALUES (2);
        COMMIT;
      `)
    }
    const versionRow = this.database.prepare(
      'SELECT MAX(version) AS version FROM webhook_schema_version'
    ).get() as { version: number | null }
    if ((versionRow.version ?? 0) < 3) {
      ensureTenantColumn(this.database, 'webhook_outbox')
      if (!hasUniqueOn(this.database, 'webhook_outbox', ['tenant_id', 'idempotency_key'])) {
        this.database.exec('PRAGMA foreign_keys = OFF;')
        try {
          rebuildSqliteTable(
            this.database,
            'webhook_outbox',
            `CREATE TABLE webhook_outbox (
              id TEXT PRIMARY KEY,
              tenant_id TEXT NOT NULL DEFAULT '${LOCAL_TENANT_ID}',
              event_type TEXT NOT NULL CHECK (event_type IN (${eventTypes})),
              payload_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              next_attempt_at INTEGER,
              status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')),
              last_status_code INTEGER,
              last_error TEXT,
              delivered_at INTEGER,
              idempotency_key TEXT,
              UNIQUE(tenant_id, idempotency_key)
            ) STRICT;`,
            [
              'id',
              'tenant_id',
              'event_type',
              'payload_json',
              'created_at',
              'attempts',
              'next_attempt_at',
              'status',
              'last_status_code',
              'last_error',
              'delivered_at',
              'idempotency_key'
            ]
          )
        } finally {
          this.database.exec('PRAGMA foreign_keys = ON;')
        }
      }
      this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS webhook_outbox_tenant_id ON webhook_outbox (tenant_id, id);`)
      this.database.prepare('INSERT INTO webhook_schema_version (version) VALUES (?)').run(3)
    }
  }
}

function normalizeEventType(event: unknown): WebhookEventType {
  if (typeof event !== 'string' || !WEBHOOK_EVENT_TYPES.includes(event as WebhookEventType)) {
    throw new Error('Webhook event type is invalid')
  }
  return event as WebhookEventType
}

function normalizeTimestamp(createdAt: unknown): number {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return Date.now()
  return Math.max(0, Math.floor(createdAt))
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}

function toRecord(row: OutboxRow): WebhookOutboxRecord {
  let payload: WebhookEvent
  try {
    payload = JSON.parse(row.payload_json) as WebhookEvent
  } catch {
    payload = {
      event: row.event_type,
      id: row.id,
      createdAt: row.created_at,
      tenantId: row.tenant_id ?? LOCAL_TENANT_ID,
      data: null
    }
  }
  if (!payload.tenantId) payload = { ...payload, tenantId: row.tenant_id ?? LOCAL_TENANT_ID }
  return {
    id: row.id,
    eventType: row.event_type,
    payload,
    createdAt: row.created_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    status: row.status,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
    idempotencyKey: row.idempotency_key
  }
}
