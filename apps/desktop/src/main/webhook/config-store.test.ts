import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isWebhookEventType, normalizeWebhookConfig, toPublicConfig, validateWebhookUrl, WebhookConfigStore } from './config-store'
import type { WebhookConfig } from './types'

const validConfig: WebhookConfig = {
  url: 'https://hooks.example.com/events',
  secret: 'super-secret-value',
  enabled: true,
  events: ['call.ended']
}

describe('validateWebhookUrl', () => {
  it('accepts https and loopback http', () => {
    expect(validateWebhookUrl('https://example.com/hook')).toBe(true)
    expect(validateWebhookUrl('http://127.0.0.1:9000/hook')).toBe(true)
    expect(validateWebhookUrl('http://localhost:9000/hook')).toBe(true)
  })

  it('rejects remote http and other schemes', () => {
    expect(validateWebhookUrl('http://example.com/hook')).toBe(false)
    expect(validateWebhookUrl('ftp://example.com/hook')).toBe(false)
    expect(validateWebhookUrl('not a url')).toBe(false)
    expect(validateWebhookUrl('')).toBe(false)
  })
})

describe('WebhookConfigStore', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function makeTempDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'webhook-config-'))
    directories.push(directory)
    return directory
  }

  it('writes webhook-config.json with mode 0600', () => {
    const directory = makeTempDir()
    const store = new WebhookConfigStore(directory)
    store.save(validConfig)

    const filePath = join(directory, 'webhook-config.json')
    expect(readFileSync(filePath, 'utf8')).toContain('"super-secret-value"')
    const mode = statSync(filePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('round-trips through load()', () => {
    const directory = makeTempDir()
    const store = new WebhookConfigStore(directory)
    store.save(validConfig)
    expect(store.load()).toEqual(validConfig)
  })

  it('returns undefined when the config file is missing', () => {
    const store = new WebhookConfigStore(makeTempDir())
    expect(store.load()).toBeUndefined()
  })

  it('rejects a non-local http url on save', () => {
    const store = new WebhookConfigStore(makeTempDir())
    expect(() => store.save({ ...validConfig, url: 'http://example.com/hook' })).toThrow()
  })

  it('rejects invalid event types', () => {
    const store = new WebhookConfigStore(makeTempDir())
    expect(() =>
      store.save({ ...validConfig, events: ['not-an-event' as never] })
    ).toThrow()
  })

  it('toPublicConfig never includes the secret', () => {
    const publicConfig = toPublicConfig(validConfig)
    expect(publicConfig).toEqual({
      url: validConfig.url,
      enabled: true,
      events: ['call.ended']
    })
    expect(JSON.stringify(publicConfig)).not.toContain('super-secret-value')
  })

  it('normalizeWebhookConfig validates the shape', () => {
    expect(isWebhookEventType('call.started')).toBe(true)
    expect(isWebhookEventType('unknown')).toBe(false)
    expect(() => normalizeWebhookConfig({} as WebhookConfig)).toThrow()
    expect(() => normalizeWebhookConfig({ ...validConfig, secret: '' })).toThrow()
  })
})