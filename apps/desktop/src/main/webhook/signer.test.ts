import { describe, expect, it } from 'vitest'
import { buildSignatureHeader, parseSignatureHeader, signPayload, verifySignature } from './signer'

const SECRET = 'test-webhook-secret'

describe('webhook signer', () => {
  it('produces the documented t= and v1= header format', () => {
    const header = buildSignatureHeader(SECRET, '{"event":"call.started"}', 1_700_000_000_000)
    expect(header).toMatch(/^t=1700000000000,v1=[0-9a-f]{64}$/)
    expect(parseSignatureHeader(header)).toEqual({
      t: 1_700_000_000_000,
      v1: signPayload(SECRET, '{"event":"call.started"}', 1_700_000_000_000)
    })
  })

  it('verifies a fresh, unmodified body', () => {
    const body = '{"event":"call.started","id":"x"}'
    const header = buildSignatureHeader(SECRET, body, Date.now())
    expect(verifySignature(SECRET, header, body, 60_000)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const body = '{"event":"call.started","id":"x"}'
    const header = buildSignatureHeader(SECRET, body, Date.now())
    expect(verifySignature(SECRET, header, body + 'tampered', 60_000)).toBe(false)
  })

  it('rejects an expired timestamp beyond tolerance', () => {
    const body = '{"event":"call.started"}'
    const header = buildSignatureHeader(SECRET, body, Date.now() - 120_000)
    expect(verifySignature(SECRET, header, body, 60_000)).toBe(false)
  })

  it('rejects a signature produced with a different secret', () => {
    const body = '{"event":"call.started"}'
    const header = buildSignatureHeader('other-secret', body, Date.now())
    expect(verifySignature(SECRET, header, body, 60_000)).toBe(false)
  })

  it('rejects malformed or missing headers', () => {
    const body = '{"event":"call.started"}'
    expect(verifySignature(SECRET, undefined, body, 60_000)).toBe(false)
    expect(verifySignature(SECRET, 'garbage', body, 60_000)).toBe(false)
    expect(parseSignatureHeader(undefined)).toBeNull()
    expect(parseSignatureHeader('v1=nothex')).toBeNull()
  })
})