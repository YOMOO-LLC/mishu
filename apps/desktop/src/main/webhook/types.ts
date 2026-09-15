export const WEBHOOK_EVENT_TYPES = [
  'call.started',
  'call.ended',
  'call.transcript.final',
  'recording.ready',
  'guardrail.triggered',
  'call.summary',
  'call.analyzed',
  'task.queued',
  'task.started',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'crm.synced',
  'appointment.created',
  'appointment.confirmed',
  'appointment.failed',
  'approval.requested',
  'webhook.test'
] as const

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivering', 'delivered', 'failed', 'dead'] as const

export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number]

export interface WebhookEvent<T = unknown> {
  event: WebhookEventType
  id: string
  createdAt: number
  tenantId: string
  data: T
}

export interface WebhookConfig {
  url: string
  secret: string
  enabled: boolean
  events: WebhookEventType[]
}

export interface WebhookPublicConfig {
  url: string
  enabled: boolean
  events: WebhookEventType[]
}

export interface WebhookOutboxRecord {
  id: string
  eventType: WebhookEventType
  payload: WebhookEvent
  createdAt: number
  attempts: number
  nextAttemptAt: number | null
  status: WebhookDeliveryStatus
  lastStatusCode: number | null
  lastError: string | null
  deliveredAt: number | null
  idempotencyKey: string | null
}

export const WEBHOOK_RETRY_BACKOFF_MS = [
  1_000,
  5_000,
  30_000,
  120_000,
  300_000,
  300_000,
  300_000,
  300_000
] as const

export const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_RETRY_BACKOFF_MS.length

export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000

export const WEBHOOK_SIGNATURE_HEADER = 'X-Mishu-Signature'
export const WEBHOOK_EVENT_HEADER = 'X-Mishu-Event'
export const WEBHOOK_DELIVERY_ID_HEADER = 'X-Mishu-Delivery-Id'
export const WEBHOOK_LEGACY_SIGNATURE_HEADER = 'X-Mishu-Signature'
export const WEBHOOK_LEGACY_EVENT_HEADER = 'X-Mishu-Event'
export const WEBHOOK_LEGACY_DELIVERY_ID_HEADER = 'X-Mishu-Delivery-Id'
export const WEBHOOK_CONTENT_TYPE = 'application/json'
export const WEBHOOK_DEFAULT_USER_AGENT = 'mishu/0.1.0'

export interface WebhookDeliveryHeaderInput {
  signature: string
  event: string
  deliveryId: string
  userAgent: string
  sendLegacyHeaders: boolean
}

export function buildWebhookDeliveryHeaders(input: WebhookDeliveryHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': WEBHOOK_CONTENT_TYPE,
    'user-agent': input.userAgent,
    [WEBHOOK_SIGNATURE_HEADER]: input.signature,
    [WEBHOOK_EVENT_HEADER]: input.event,
    [WEBHOOK_DELIVERY_ID_HEADER]: input.deliveryId
  }
  if (input.sendLegacyHeaders) {
    headers[WEBHOOK_LEGACY_SIGNATURE_HEADER] = input.signature
    headers[WEBHOOK_LEGACY_EVENT_HEADER] = input.event
    headers[WEBHOOK_LEGACY_DELIVERY_ID_HEADER] = input.deliveryId
  }
  return headers
}
