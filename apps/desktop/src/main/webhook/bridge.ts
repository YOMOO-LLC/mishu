import { randomBytes } from 'node:crypto'
import type {
  ApprovalRequest,
  Appointment,
  CallTask,
  RecordingInfo,
  WebhookDeliverySummary,
  WebhookPublicConfig,
  WebhookRotateResult,
  WebhookSaveInput
} from '../../shared/contracts.js'
import type { CallAnalyzedEventPayload } from '../analysis/types.js'
import type { CallStore, CallStoreEvent } from '../call-store.js'
import { isWebhookEventType, WebhookConfigStore, normalizeWebhookConfig, toPublicConfig } from './config-store.js'
import { maskPhoneNumber } from './mask.js'
import { WebhookOutbox } from './outbox.js'
import type { WebhookConfig, WebhookEventType, WebhookOutboxRecord } from './types.js'

const SECRET_BYTES = 32

export interface WebhookBridgeOptions {
  store: CallStore
  configStore: WebhookConfigStore
  fetch?: typeof fetch
}

function idempotencyKey(event: WebhookEventType, callId: string, entryId?: string): string {
  return entryId ? `${event}:${callId}:${entryId}` : `${event}:${callId}`
}

export class WebhookBridge {
  readonly outbox: WebhookOutbox
  private readonly configStore: WebhookConfigStore

  constructor(options: WebhookBridgeOptions) {
    this.configStore = options.configStore
    this.outbox = new WebhookOutbox({
      database: options.store.getDatabase(),
      tenantId: options.store.tenantId,
      getConfig: () => this.configStore.load(),
      fetch: options.fetch
    })
    options.store.onEvent((event) => this.handleStoreEvent(event))
  }

  getPublicConfig(): WebhookPublicConfig {
    const config = this.configStore.load()
    return {
      enabled: config?.enabled ?? false,
      url: config?.url ?? '',
      events: config ? [...config.events] : [],
      hasSecret: Boolean(config?.secret)
    }
  }

  saveConfig(input: WebhookSaveInput): WebhookPublicConfig & { secret?: string } {
    const existing = this.configStore.load()
    let secret = typeof input.secret === 'string' && input.secret ? input.secret : existing?.secret
    const generated = !secret
    if (!secret) secret = randomBytes(SECRET_BYTES).toString('hex')
    const events = Array.isArray(input.events)
      ? input.events.filter(isWebhookEventType)
      : existing?.events ?? []
    const next = normalizeWebhookConfig({
      url: typeof input.url === 'string' ? input.url : existing?.url ?? '',
      secret,
      enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? false,
      events
    })
    this.configStore.save(next)
    const publicConfig = this.toPublicWithSecretFlag(next)
    return generated ? { ...publicConfig, secret } : publicConfig
  }

  rotateSecret(): WebhookRotateResult {
    const existing = this.configStore.load()
    if (!existing?.url) throw new Error('Save a Webhook URL before generating a secret')
    const secret = randomBytes(SECRET_BYTES).toString('hex')
    const next = normalizeWebhookConfig({
      url: existing.url,
      secret,
      enabled: existing.enabled,
      events: existing.events
    })
    this.configStore.save(next)
    return { config: this.toPublicWithSecretFlag(next), secret }
  }

  async sendTest(): Promise<WebhookDeliverySummary> {
    const config = this.configStore.load()
    if (!config?.enabled) throw new Error('Webhook is not enabled')
    const id = this.outbox.enqueue({
      event: 'webhook.test',
      idempotencyKey: `webhook.test:${Date.now()}`,
      data: { note: 'manual test', sentAt: Date.now() }
    }).id
    await this.outbox.deliverDue()
    const record = this.outbox.getStatus(id)
    if (!record) throw new Error('Test event was not enqueued')
    return toDeliverySummary(record)
  }

  listDeliveries(limit = 20): WebhookDeliverySummary[] {
    return this.outbox.list(limit).map(toDeliverySummary)
  }

  publishExternalEvent(
    event: Extract<WebhookEventType, 'crm.synced'>,
    data: { callId: string; status: 'succeeded' },
    idempotencyKey: string
  ): void {
    const config = this.configStore.load()
    if (!config || !config.enabled) return
    this.enqueueIfSubscribed(config, event, idempotencyKey, {
      callId: data.callId,
      status: data.status
    })
  }

  publishAppointmentEvent(
    event: Extract<WebhookEventType, 'appointment.created' | 'appointment.confirmed' | 'appointment.failed'>,
    appointment: Appointment,
    error?: string
  ): void {
    const config = this.configStore.load()
    if (!config || !config.enabled) return
    this.enqueueIfSubscribed(config, event, `${event}:${appointment.id}`, {
      appointmentId: appointment.id,
      ...(appointment.callId ? { callId: appointment.callId } : {}),
      campaignId: appointment.campaignId,
      peer: maskPhoneNumber(appointment.peer),
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      timeZone: appointment.timeZone,
      status: appointment.status,
      source: appointment.source,
      ...(appointment.externalRef ? { externalRef: appointment.externalRef } : {}),
      ...(error ? { error: error.slice(0, 500) } : {})
    })
  }

  publishApprovalRequested(request: ApprovalRequest): void {
    const config = this.configStore.load()
    if (!config || !config.enabled) return
    this.enqueueIfSubscribed(config, 'approval.requested', `approval.requested:${request.id}`, {
      approvalId: request.id,
      kind: request.kind,
      title: request.title,
      summary: request.summary,
      details: maskApprovalDetails(request.details),
      requestedBy: request.requestedBy,
      expiresAt: request.expiresAt
    })
  }

  publishCallAnalyzed(event: CallAnalyzedEventPayload): void {
    const config = this.configStore.load()
    if (!config || !config.enabled) return
    const masked = maskPhoneValues(event) as CallAnalyzedEventPayload
    this.enqueueIfSubscribed(config, 'call.analyzed', `call.analyzed:${event.resultId}`, {
      ...masked
    })
  }

  publishTaskEvent(
    event: Extract<WebhookEventType, 'task.queued' | 'task.started' | 'task.completed' | 'task.failed' | 'task.cancelled'>,
    task: CallTask
  ): void {
    const config = this.configStore.load()
    if (!config || !config.enabled) return
    const suffix = event === 'task.started' ? `:${task.attempts}` : ''
    this.enqueueIfSubscribed(config, event, `${event}:${task.id}${suffix}`, {
      taskId: task.id,
      status: task.status,
      ...(task.outcome ? { outcome: task.outcome } : {}),
      ...(task.result !== undefined ? { result: maskPhoneValues(task.result) } : {}),
      ...(task.callId ? { callId: task.callId } : {})
    })
  }

  startScheduler(intervalMs: number): void {
    this.outbox.startScheduler(intervalMs)
  }

  stopScheduler(): void {
    this.outbox.stopScheduler()
  }

  close(): void {
    this.outbox.close()
  }

  private handleStoreEvent(event: CallStoreEvent): void {
    const config = this.configStore.load()
    if (!config || !config.enabled) return
    switch (event.type) {
      case 'call.started':
        this.enqueueIfSubscribed(config, 'call.started', idempotencyKey('call.started', event.call.id), {
          callId: event.call.id,
          direction: event.call.direction,
          peer: maskPhoneNumber(event.call.peer),
          status: event.call.status,
          ...(event.call.startedAt !== undefined ? { startedAt: event.call.startedAt } : {})
        })
        return
      case 'call.ended':
        this.enqueueIfSubscribed(config, 'call.ended', idempotencyKey('call.ended', event.call.id), {
          callId: event.call.id,
          direction: event.call.direction,
          peer: maskPhoneNumber(event.call.peer),
          status: event.call.status,
          ...(event.call.startedAt !== undefined ? { startedAt: event.call.startedAt } : {}),
          ...(event.call.endedAt !== undefined ? { endedAt: event.call.endedAt } : {}),
          ...(event.call.durationMs !== undefined ? { durationMs: event.call.durationMs } : {}),
          ...(event.call.endReason !== undefined ? { endReason: event.call.endReason } : {}),
          ...(event.call.campaignName !== undefined ? { campaignName: event.call.campaignName } : {})
        })
        return
      case 'transcript.final':
        this.enqueueIfSubscribed(
          config,
          'call.transcript.final',
          idempotencyKey('call.transcript.final', event.callId, event.entry.id),
          {
            callId: event.callId,
            entryId: event.entry.id,
            speaker: event.entry.speaker,
            text: event.entry.text,
            timestamp: event.entry.timestamp
          }
        )
        return
      case 'recording.ready':
        this.enqueueIfSubscribed(
          config,
          'recording.ready',
          idempotencyKey('recording.ready', event.callId),
          this.recordingPayload(event.recording)
        )
        return
      case 'guardrail.triggered':
        this.enqueueIfSubscribed(
          config,
          'guardrail.triggered',
          idempotencyKey('guardrail.triggered', event.callId, event.guardrail.kind),
          {
            callId: event.callId,
            kind: event.guardrail.kind,
            at: event.guardrail.at,
            ...(event.guardrail.details ? { details: event.guardrail.details } : {})
          }
        )
        return
    }
  }

  private enqueueIfSubscribed(
    config: WebhookConfig,
    event: WebhookEventType,
    key: string,
    data: Record<string, unknown>
  ): void {
    if (!config.events.includes(event)) return
    this.outbox.enqueue({ event, data, idempotencyKey: key })
  }

  private recordingPayload(recording: RecordingInfo): Record<string, unknown> {
    return {
      callId: recording.callId,
      playbackUrl: recording.playbackUrl,
      ...(recording.bytes !== undefined ? { bytes: recording.bytes } : {}),
      ...(recording.sha256 !== undefined ? { sha256: recording.sha256 } : {}),
      ...(recording.durationMs !== undefined ? { durationMs: recording.durationMs } : {}),
      ...(recording.mime !== undefined ? { mime: recording.mime } : {}),
      status: recording.status
    }
  }

  private toPublicWithSecretFlag(config: WebhookConfig): WebhookPublicConfig {
    return { ...toPublicConfig(config), hasSecret: Boolean(config.secret) }
  }
}

function maskApprovalDetails(details: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...details }
  if (typeof masked.peer === 'string') masked.peer = maskPhoneNumber(masked.peer)
  return masked
}

function maskPhoneValues(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\+[1-9]\d{6,14}/g, (phone) => maskPhoneNumber(phone))
  }
  if (Array.isArray(value)) return value.map(maskPhoneValues)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskPhoneValues(item)]))
  }
  return value
}

function toDeliverySummary(record: WebhookOutboxRecord): WebhookDeliverySummary {
  return {
    id: record.id,
    eventType: record.eventType,
    status: record.status,
    attempts: record.attempts,
    createdAt: record.createdAt,
    ...(record.lastStatusCode !== null ? { lastStatusCode: record.lastStatusCode } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {})
  }
}
