import { describe, expect, it } from 'vitest'
import { api, apiOk, expectError, hangupQuietly, uniqueKey } from './helpers/http.js'
import { assertNoSecretLeaks } from './helpers/secrets.js'

function envelopeKeys(body: { error: Record<string, unknown> }): string[] {
  return Object.keys(body.error).sort()
}

describe('error envelope (ADR-0001 I9)', () => {
  it('I9: 404 NOT_FOUND uses {error:{code,message}}', async () => {
    const result = await api('/campaigns/does-not-exist')
    expectError(result, 'NOT_FOUND', 404)
    expect(result.body.error).toMatchObject({ code: 'NOT_FOUND', message: expect.any(String) })
    expect(envelopeKeys(result.body)).toEqual(expect.arrayContaining(['code', 'message']))
    assertNoSecretLeaks(result.body, '404')
  })

  it('I9: validation failure uses 422 UNPROCESSABLE_ENTITY with details', async () => {
    const result = await api('/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: '', direction: 'outbound', voice: 'sol' })
    })
    expectError(result, 'UNPROCESSABLE_ENTITY', 422)
    expect(result.body.error.details).toBeDefined()
    expect(envelopeKeys(result.body)).toEqual(['code', 'details', 'message'].sort())
    assertNoSecretLeaks(result.body, '422')
  })

  it('I9: CONFLICT uses 409 and the same error envelope', async () => {
    const dial = await apiOk<{ approvalId: string }>('/calls', {
      method: 'POST',
      body: JSON.stringify({ peer: '+17735550901', idempotencyKey: uniqueKey('conflict-dial') })
    })
    expect(dial.status).toBe(202)
    expect(typeof dial.body.approvalId).toBe('string')

    const first = await apiOk(`/approvals/${dial.body.approvalId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ approved: false })
    })
    expect(first.status).toBe(200)

    const second = await api(`/approvals/${dial.body.approvalId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ approved: false })
    })
    expectError(second, 'CONFLICT', 409)
    expect(typeof second.body.error.message).toBe('string')
    expect(Object.keys(second.body.error)).toEqual(expect.arrayContaining(['code', 'message']))
    assertNoSecretLeaks(second.body, '409')
    await hangupQuietly()
  })
})
