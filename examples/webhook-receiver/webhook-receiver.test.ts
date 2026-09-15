import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { startCloudHost } from '../../apps/cloud/src/host.js'
import { startWebhookReceiver } from './server.js'
import { buildSignatureHeader, verifySignature } from './verify.js'

const EXAMPLE_SECRET = 'ab'.repeat(32)

const hosts: Array<{ stop(): Promise<void> }> = []
const receivers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()))
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
})

async function poll<T>(
  read: () => Promise<T> | T,
  match: (value: T) => boolean,
  label: string,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (match(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${label} timed out; last value: ${JSON.stringify(last)}`)
}

describe('examples/webhook-receiver', () => {
  it('verifies the documented t=,v1= header locally', () => {
    const body = '{"event":"webhook.test"}'
    const header = buildSignatureHeader(EXAMPLE_SECRET, body, Date.now())
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(verifySignature(EXAMPLE_SECRET, header, body)).toBe(true)
    expect(verifySignature(EXAMPLE_SECRET, header, `${body}tampered`)).toBe(false)
  })

  it('accepts a signed webhook.test from the headless reference host', async () => {
    const host = await startCloudHost({ port: 0 })
    hosts.push(host)
    const token = readFileSync(host.ready.tokenFile, 'utf8').trim()
    const receiver = await startWebhookReceiver({ secret: EXAMPLE_SECRET, port: 0 })
    receivers.push(receiver)

    const saved = await fetch(`${host.ready.baseUrl}/settings/webhook`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'example-webhook-save'
      },
      body: JSON.stringify({
        enabled: true,
        url: `${receiver.baseUrl}/hook`,
        events: ['webhook.test'],
        secret: EXAMPLE_SECRET
      })
    })
    expect(saved.ok).toBe(true)

    const testDelivery = await fetch(`${host.ready.baseUrl}/settings/webhook/test`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'example-webhook-test'
      },
      body: '{}'
    })
    expect(testDelivery.status).toBe(202)

    const delivery = await poll(
      () => receiver.deliveries[0],
      (item) => Boolean(item),
      'webhook.test delivery'
    )
    expect(delivery.verified).toBe(true)
    expect(delivery.status).toBe(200)
    expect(delivery.event).toBe('webhook.test')
    expect(verifySignature(EXAMPLE_SECRET, delivery.signature, delivery.body)).toBe(true)

    const tampered = await fetch(`${receiver.baseUrl}/hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Mishu-Signature': delivery.signature ?? '',
        'X-Mishu-Event': 'webhook.test'
      },
      body: `${delivery.body}tampered`
    })
    expect(tampered.status).toBe(401)
  }, 30_000)
})
