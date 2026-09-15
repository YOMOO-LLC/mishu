import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CAPABILITY_UNAVAILABLE_STATUS, unavailableFor } from './unavailable.js'
import { startCloudHost } from './host.js'

const hosts: Array<{ stop(): Promise<void> }> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('unavailable routes', () => {
  it('matches desktop-only endpoints', () => {
    expect(unavailableFor('POST', '/v1/app/relaunch')?.message).toMatch(/relaunch/i)
    expect(unavailableFor('POST', '/v1/settings/twilio/import')?.message).toMatch(/\.env/)
    expect(unavailableFor('POST', '/v1/realtime/sessions')?.message).toMatch(/realtime/i)
    expect(unavailableFor('GET', '/v1/calls/abc/recording/audio')?.message).toMatch(/recording/i)
    expect(unavailableFor('GET', '/v1/health')).toBeUndefined()
  })
})

describe('headless cloud host', () => {
  it('serves /v1 on loopback, writes a 0600 token file, and never puts the token in the ready line', async () => {
    const host = await startCloudHost()
    hosts.push(host)
    const token = readFileSync(host.ready.tokenFile, 'utf8').trim()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(statSync(host.ready.tokenFile).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(host.ready)).not.toContain(token)
    expect(host.ready.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(host.ready.tokenFile.startsWith(host.dataDir)).toBe(true)

    const unauthorized = await fetch(`${host.ready.baseUrl}/health`)
    expect(unauthorized.status).toBe(401)
    const denied = await unauthorized.json() as { error: { code: string } }
    expect(denied.error.code).toBe('UNAUTHORIZED')
    expect(JSON.stringify(denied)).not.toContain(token)

    const health = await fetch(`${host.ready.baseUrl}/health`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })

    const mcp = await fetch(`${host.ready.baseUrl}/settings/mcp`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(mcp.status).toBe(200)
    const mcpBody = await mcp.json() as { enabled: boolean; running: boolean; token?: string }
    expect(mcpBody).toMatchObject({ enabled: false, running: false })
    expect(mcpBody.token).toBeUndefined()
    expect(JSON.stringify(mcpBody)).not.toContain(token)

    const relaunch = await fetch(`${host.ready.baseUrl}/app/relaunch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(relaunch.status).toBe(CAPABILITY_UNAVAILABLE_STATUS)
    const relaunchBody = await relaunch.json() as { error: { code: string } }
    expect(relaunchBody.error.code).toBe('CAPABILITY_UNAVAILABLE')
    expect(JSON.stringify(relaunchBody)).not.toContain(token)
  })

  it('keeps sqlite and the token inside the data dir and deletes ephemeral data on stop', async () => {
    const host = await startCloudHost()
    const dataDir = host.dataDir
    expect(existsSync(join(dataDir, 'campaigns.sqlite3'))).toBe(true)
    expect(existsSync(join(dataDir, 'calls.sqlite3'))).toBe(true)
    expect(host.ready.tokenFile.startsWith(dataDir)).toBe(true)
    await host.stop()
    expect(existsSync(dataDir)).toBe(false)
  })

  it('does not delete a caller-supplied data dir', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mishu-cloud-keep-'))
    directories.push(dataDir)
    const host = await startCloudHost({ dataDir })
    await host.stop()
    expect(existsSync(join(dataDir, 'campaigns.sqlite3'))).toBe(true)
  })
})
