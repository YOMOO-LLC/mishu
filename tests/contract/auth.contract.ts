import { describe, expect, it } from 'vitest'
import { api, expectError, loadEngine } from './helpers/http.js'
import { assertNoSecretLeaks } from './helpers/secrets.js'

describe('auth (ADR-0001 I3, I9)', () => {
  it('I9: missing bearer token returns 401 UNAUTHORIZED envelope', async () => {
    const result = await api('/health', { token: null })
    expectError(result, 'UNAUTHORIZED', 401)
    expect(result.body.error.message.length).toBeGreaterThan(0)
    assertNoSecretLeaks(result.body, 'missing-token')
  })

  it('I9: wrong bearer token returns 401 UNAUTHORIZED envelope', async () => {
    const result = await api('/health', { token: '0'.repeat(64) })
    expectError(result, 'UNAUTHORIZED', 401)
    assertNoSecretLeaks(result.body, 'wrong-token')
  })

  it('I9: valid token reaches /health', async () => {
    const result = await api<{ status: string }>('/health')
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ status: 'ok' })
    expect(JSON.stringify(result.body)).not.toContain(loadEngine().token)
  })
})
