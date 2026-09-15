import { describe, expect, it, vi } from 'vitest'
import { loadTwilioAccessToken } from './twilio-token.js'

const completeCredentials = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_API_KEY_SID: 'SK00000000000000000000000000000000',
  TWILIO_API_KEY_SECRET: 'test-secret',
  TWILIO_TWIML_APP_SID: 'AP00000000000000000000000000000000'
}

describe('loadTwilioAccessToken', () => {
  it('uses an inline token first', async () => {
    const fetchToken = vi.fn()
    const signToken = vi.fn()
    await expect(loadTwilioAccessToken({
      env: { ...completeCredentials, TWILIO_ACCESS_TOKEN: ' inline-token ', TWILIO_TOKEN_URL: 'http://unused' },
      fetchToken: fetchToken as never,
      signToken
    })).resolves.toBe('inline-token')
    expect(fetchToken).not.toHaveBeenCalled()
    expect(signToken).not.toHaveBeenCalled()
  })

  it('fetches an override URL with bearer authentication', async () => {
    const fetchToken = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer helper-secret')
      return new Response(JSON.stringify({ token: 'remote-token' }))
    })
    await expect(loadTwilioAccessToken({
      env: { TWILIO_TOKEN_URL: 'http://127.0.0.1:8787/token', APP_TOKEN_SECRET: 'helper-secret' },
      fetchToken: fetchToken as never
    })).resolves.toBe('remote-token')
  })

  it('signs in the main process when credentials are complete', async () => {
    const signToken = vi.fn(() => 'signed-token')
    await expect(loadTwilioAccessToken({
      env: { ...completeCredentials, TWILIO_CLIENT_IDENTITY: 'desktop-client' }, signToken
    })).resolves.toBe('signed-token')
    expect(signToken).toHaveBeenCalledWith({
      credentials: {
        accountSid: completeCredentials.TWILIO_ACCOUNT_SID,
        apiKeySid: completeCredentials.TWILIO_API_KEY_SID,
        apiKeySecret: completeCredentials.TWILIO_API_KEY_SECRET,
        twimlAppSid: completeCredentials.TWILIO_TWIML_APP_SID
      },
      identity: 'desktop-client',
      ttl: 3_600
    })
  })
})
