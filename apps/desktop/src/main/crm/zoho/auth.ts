import { normalizeZohoDataCenter, type ZohoDataCenter, zohoHosts } from './hosts.js'
import type { ZohoSecrets } from './secrets.js'

const EXPIRY_SKEW_MS = 60_000

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  api_domain?: unknown
  error?: unknown
}

export interface ZohoAccessToken {
  value: string
  apiDomain: string
}

export interface ZohoAuthOptions {
  fetch?: typeof fetch
  now?: () => number
}

export class ZohoSelfClientAuth {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private cached?: ZohoAccessToken & { expiresAt: number }
  private refreshing?: Promise<ZohoAccessToken>

  constructor(private readonly secrets: ZohoSecrets, options: ZohoAuthOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  async accessToken(): Promise<ZohoAccessToken> {
    if (this.cached && this.cached.expiresAt - EXPIRY_SKEW_MS > this.now()) {
      return { value: this.cached.value, apiDomain: this.cached.apiDomain }
    }
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async refresh(): Promise<ZohoAccessToken> {
    const payload = await requestToken(this.fetchImpl, this.secrets.dataCenter, {
      grant_type: 'refresh_token',
      client_id: this.secrets.clientId,
      client_secret: this.secrets.clientSecret,
      refresh_token: this.secrets.refreshToken
    })
    const accessToken = requiredToken(payload.access_token, 'access_token')
    const expiresIn = typeof payload.expires_in === 'number' && payload.expires_in > 0
      ? payload.expires_in
      : 3_600
    const apiDomain = normalizeApiDomain(payload.api_domain, this.secrets.dataCenter)
    this.cached = { value: accessToken, apiDomain, expiresAt: this.now() + expiresIn * 1_000 }
    return { value: accessToken, apiDomain }
  }
}

export async function exchangeGrantCode(
  input: { clientId: string; clientSecret: string; grantCode: string; dataCenter: ZohoDataCenter },
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<ZohoSecrets> {
  const dataCenter = normalizeZohoDataCenter(input.dataCenter)
  const payload = await requestToken(fetchImpl, dataCenter, {
    grant_type: 'authorization_code',
    client_id: input.clientId.trim(),
    client_secret: input.clientSecret.trim(),
    code: input.grantCode.trim()
  })
  return {
    clientId: requiredToken(input.clientId, 'clientId'),
    clientSecret: requiredToken(input.clientSecret, 'clientSecret'),
    refreshToken: requiredToken(payload.refresh_token, 'refresh_token'),
    dataCenter
  }
}

async function requestToken(
  fetchImpl: typeof fetch,
  dataCenter: ZohoDataCenter,
  fields: Record<string, string>
): Promise<TokenResponse> {
  const response = await fetchImpl(`${zohoHosts(dataCenter).accounts}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  })
  const payload = await readJson(response)
  if (!response.ok || payload.error) {
    throw new Error(`Zoho OAuth failed (HTTP ${response.status})`)
  }
  return payload
}

async function readJson(response: Response): Promise<TokenResponse> {
  try {
    return await response.json() as TokenResponse
  } catch {
    return {}
  }
}

function requiredToken(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Zoho did not return ${name}`)
  return value.trim()
}

function normalizeApiDomain(value: unknown, dataCenter: ZohoDataCenter): string {
  if (typeof value !== 'string' || !value.trim()) return zohoHosts(dataCenter).api
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:') throw new Error('Zoho API host is invalid')
  return parsed.origin
}
