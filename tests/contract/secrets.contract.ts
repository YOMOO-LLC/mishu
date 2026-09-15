import { describe, expect, it } from 'vitest'
import { apiOk, loadEngine } from './helpers/http.js'
import { assertNoSecretLeaks } from './helpers/secrets.js'

describe('secret redaction (ADR-0001 I4)', () => {
  it('I4: health, status, runtime, mcp, openai, and openapi omit keys, tokens, and raw numbers', async () => {
    const token = loadEngine().token
    const paths = [
      '/health',
      '/status',
      '/settings/mcp',
      '/settings/openai',
      '/settings/webhook',
      '/openapi.json',
      '/campaigns',
      '/contacts',
      '/calls',
      '/tasks'
    ]
    for (const path of paths) {
      const result = await apiOk(path)
      expect(result.status).toBe(200)
      expect(result.raw).not.toContain(token)
      assertNoSecretLeaks(result.body, path)
    }
    const runtime = await apiOk('/runtime')
    expect(runtime.raw).not.toContain(token)
    expect(runtime.raw).not.toMatch(/\bsk-[a-zA-Z0-9_-]{10,}\b/)

    const twilio = await apiOk<{ apiKeySecret?: { configured?: boolean; value?: string } }>('/settings/twilio')
    expect(twilio.raw).not.toContain(token)
    expect(twilio.body.apiKeySecret?.value ?? '').not.toMatch(/^[a-zA-Z0-9]{16,}$/)
  })
})
