import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CrmConfigStore } from './config-store'
import { persistCrmConfig } from './index'
import { ZohoSecretsStore } from './zoho/secrets'

describe('CRM config and secrets', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('writes Zoho credentials with mode 0600 and never exposes them publicly', () => {
    const directory = mkdtempSync(join(tmpdir(), 'crm-secrets-'))
    directories.push(directory)
    const secrets = new ZohoSecretsStore(directory)
    const config = new CrmConfigStore(directory)
    secrets.save({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      dataCenter: 'eu'
    })
    config.patch({ provider: 'zoho', dataCenter: 'eu', postCallSync: true })

    expect(statSync(secrets.filePath).mode & 0o777).toBe(0o600)
    expect(secrets.load()).toMatchObject({ refreshToken: 'refresh-token' })
    const publicConfig = config.publicConfig(true)
    expect(publicConfig).toMatchObject({
      provider: 'zoho',
      dataCenter: 'eu',
      hasCredentials: true,
      postCallSync: true
    })
    expect(JSON.stringify(publicConfig)).not.toContain('client-secret')
    expect(JSON.stringify(publicConfig)).not.toContain('refresh-token')
  })

  it('exchanges a grant code with injected fetch and stores only the refresh credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'crm-grant-'))
    directories.push(directory)
    const secrets = new ZohoSecretsStore(directory)
    const config = new CrmConfigStore(directory)
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      api_domain: 'https://www.zohoapis.com'
    }), { status: 200 })

    const result = await persistCrmConfig({
      provider: 'zoho',
      dataCenter: 'com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      grantCode: 'one-time-grant',
      postCallSync: true
    }, config, secrets, fetch)

    expect(result.config).toMatchObject({
      provider: 'zoho',
      connected: false,
      hasCredentials: true,
      postCallSync: true
    })
    const raw = readFileSync(secrets.filePath, 'utf8')
    expect(raw).toContain('refresh-token')
    expect(raw).not.toContain('one-time-grant')
    expect(raw).not.toContain('access-token')
  })
})
