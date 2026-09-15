import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTwilioHelperServer,
  isAuthorizedTokenRequest,
  isStrongTokenSecret,
  outgoingTwiml
} from './app'

const strongSecret = 'test-only-secret-with-at-least-32-bytes'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('token authentication', () => {
  it('requires a secret of at least 32 bytes', () => {
    expect(isStrongTokenSecret(undefined)).toBe(false)
    expect(isStrongTokenSecret('x'.repeat(31))).toBe(false)
    expect(isStrongTokenSecret(strongSecret)).toBe(true)
  })

  it('accepts only an exact bearer token', () => {
    expect(isAuthorizedTokenRequest(`Bearer ${strongSecret}`, strongSecret)).toBe(true)
    expect(isAuthorizedTokenRequest(`Bearer ${strongSecret}-wrong`, strongSecret)).toBe(false)
    expect(isAuthorizedTokenRequest(strongSecret, strongSecret)).toBe(false)
    expect(isAuthorizedTokenRequest(undefined, strongSecret)).toBe(false)
  })
})

describe('Twilio helper fail-closed behavior', () => {
  async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
    const server = createTwilioHelperServer('127.0.0.1', 0)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    try {
      await run(`http://127.0.0.1:${address.port}`)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  }

  it('does not issue tokens when APP_TOKEN_SECRET is missing', async () => {
    vi.stubEnv('APP_TOKEN_SECRET', '')

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/token`)

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'Token service is not securely configured' })
    })
  })

  it('does not issue tokens when APP_TOKEN_SECRET is too short', async () => {
    vi.stubEnv('APP_TOKEN_SECRET', 'too-short')

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/token`, {
        headers: { authorization: 'Bearer too-short' }
      })

      expect(response.status).toBe(503)
    })
  })

  it('rejects local webhook requests when TWILIO_AUTH_TOKEN is missing', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '')

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/voice/incoming`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: '+15551234567' })
      })

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'Invalid Twilio signature' })
    })
  })
})

describe('outgoing TwiML', () => {
  it('waits to bridge media until the callee answers', () => {
    vi.stubEnv('TWILIO_PHONE_NUMBER', '+13125550198')

    const twiml = outgoingTwiml('+17735550100')

    expect(twiml).toContain('answerOnBridge="true"')
    expect(twiml).toContain('<Number>+17735550100</Number>')
  })
})
