import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpTokenStore, isLoopbackRequest } from './auth.js'

describe('McpTokenStore', () => {
  it('persists a 32-byte token with owner-only permissions and rotates it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'live-phone-mcp-auth-'))
    const store = new McpTokenStore(directory)
    const first = readFileSync(store.tokenPath, 'utf8').trim()
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(statSync(store.tokenPath).mode & 0o777).toBe(0o600)
    expect(store.authorize(`Bearer ${first}`)).toBe(true)

    const second = store.rotate()
    expect(second).not.toBe(first)
    expect(store.authorize(`Bearer ${first}`)).toBe(false)
    expect(store.authorize(`Bearer ${second}`)).toBe(true)
  })

  it('accepts only loopback Host and Origin values', () => {
    expect(isLoopbackRequest('127.0.0.1:4321', undefined)).toBe(true)
    expect(isLoopbackRequest('localhost:4321', 'http://localhost:3000')).toBe(true)
    expect(isLoopbackRequest('evil.example', undefined)).toBe(false)
    expect(isLoopbackRequest('127.0.0.1:4321', 'https://evil.example')).toBe(false)
  })
})
