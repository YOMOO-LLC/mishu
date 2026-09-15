import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  WEBHOOK_EVENT_TYPES,
  type WebhookConfig,
  type WebhookEventType,
  type WebhookPublicConfig
} from './types.js'

const CONFIG_FILE_NAME = 'webhook-config.json'
const CONFIG_FILE_MODE = 0o600
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function validateWebhookUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol === 'http:') return LOCAL_HOSTS.has(parsed.hostname)
  return false
}

export function normalizeWebhookConfig(input: WebhookConfig): WebhookConfig {
  if (!input || typeof input !== 'object') throw new Error('Webhook config is invalid')
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!validateWebhookUrl(url)) {
    throw new Error('Webhook URL is invalid (https:// or localhost http:// only)')
  }
  const secret = typeof input.secret === 'string' ? input.secret : ''
  if (!secret) throw new Error('Webhook secret cannot be empty')
  const events = Array.isArray(input.events) ? input.events : []
  for (const event of events) {
    if (!WEBHOOK_EVENT_TYPES.includes(event)) throw new Error('Webhook event type is invalid')
  }
  return { url, secret, enabled: input.enabled === true, events: [...events] }
}

export function toPublicConfig(config: WebhookConfig): WebhookPublicConfig {
  const normalized = normalizeWebhookConfig(config)
  return { url: normalized.url, enabled: normalized.enabled, events: [...normalized.events] }
}

export class WebhookConfigStore {
  private readonly filePath: string

  constructor(directory: string) {
    this.filePath = join(directory, CONFIG_FILE_NAME)
  }

  load(): WebhookConfig | undefined {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    return normalizeWebhookConfig(JSON.parse(raw) as WebhookConfig)
  }

  save(config: WebhookConfig): void {
    const normalized = normalizeWebhookConfig(config)
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: CONFIG_FILE_MODE })
    chmodSync(this.filePath, CONFIG_FILE_MODE)
  }
}

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && WEBHOOK_EVENT_TYPES.includes(value as WebhookEventType)
}