import { describe, expect, it, vi } from 'vitest'
import { exchangeGrantCode, ZohoSelfClientAuth } from './auth'

describe('ZohoSelfClientAuth', () => {
  it('refreshes once and caches the access token before expiry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access-one',
      expires_in: 3600,
      api_domain: 'https://www.zohoapis.eu'
    }), { status: 200 }))
    const auth = new ZohoSelfClientAuth({
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      dataCenter: 'eu'
    }, { fetch, now: () => 1_000 })

    await expect(auth.accessToken()).resolves.toEqual({
      value: 'access-one',
      apiDomain: 'https://www.zohoapis.eu'
    })
    await auth.accessToken()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('https://accounts.zoho.eu/oauth/v2/token')
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain('grant_type=refresh_token')
  })

  it('exchanges a Self Client grant code for a refresh token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'short-lived',
      refresh_token: 'long-lived',
      api_domain: 'https://www.zohoapis.com'
    }), { status: 200 }))

    const secrets = await exchangeGrantCode({
      clientId: 'client',
      clientSecret: 'secret',
      grantCode: 'one-time-code',
      dataCenter: 'com'
    }, fetch)

    expect(secrets).toEqual({
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'long-lived',
      dataCenter: 'com'
    })
    const body = String(fetch.mock.calls[0]?.[1]?.body)
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('code=one-time-code')
  })
})
