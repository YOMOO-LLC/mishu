import { describe, expect, it } from 'vitest'
import { apiOk, uniqueKey } from './helpers/http.js'
import { verifySignature } from './helpers/hmac.js'
import { poll } from './helpers/poll.js'
import { startWebhookReceiver } from './helpers/webhook-receiver.js'
import { assertNoSecretLeaks } from './helpers/secrets.js'

describe('webhooks (ADR-0001 I13, I9)', () => {
  it('I13: HMAC verifies, deliveryId is stable, and retries can be deduped', async () => {
    const receiver = await startWebhookReceiver()
    receiver.failNext = 1
    try {
      const saved = await apiOk<{
        enabled: boolean
        url: string
        events: string[]
        hasSecret: boolean
        secret?: string
      }>('/settings/webhook', {
        method: 'PUT',
        idempotencyKey: uniqueKey('webhook-save'),
        body: JSON.stringify({
          enabled: true,
          url: `${receiver.baseUrl}/hook`,
          events: ['webhook.test']
        })
      })
      let secret = saved.body.secret
      if (!secret) {
        const rotated = await apiOk<{ secret: string; config: { hasSecret: boolean } }>(
          '/settings/webhook/secret/rotate',
          { method: 'POST', body: '{}' }
        )
        secret = rotated.body.secret
      }
      expect(secret).toMatch(/^[0-9a-f]{64}$/)

      const publicConfig = await apiOk<{ secret?: string; hasSecret: boolean }>('/settings/webhook')
      expect(publicConfig.body.secret).toBeUndefined()
      expect(publicConfig.body.hasSecret).toBe(true)
      assertNoSecretLeaks(publicConfig.body, 'webhook-settings')

      const testDelivery = await apiOk<{ id: string; eventType: string; status: string }>(
        '/settings/webhook/test',
        { method: 'POST', body: '{}' }
      )
      expect(testDelivery.status).toBe(202)
      expect(typeof testDelivery.body.id).toBe('string')

      const first = await poll(
        async () => receiver.deliveries[0],
        (delivery) => Boolean(delivery),
        { timeoutMs: 10_000, label: 'first webhook delivery' }
      )
      expect(first.event).toBe('webhook.test')
      expect(first.deliveryId).toBeTruthy()
      expect(first.deliveryId).toBe(testDelivery.body.id)
      expect(verifySignature(secret, first.signature, first.body)).toBe(true)
      const payload = JSON.parse(first.body) as { id: string; event: string; createdAt: number; data: unknown }
      expect(payload.id).toBe(first.deliveryId)
      expect(payload.event).toBe('webhook.test')
      expect(typeof payload.createdAt).toBe('number')

      const second = await poll(
        async () => receiver.deliveries[1],
        (delivery) => Boolean(delivery),
        { timeoutMs: 20_000, label: 'retried webhook delivery' }
      )
      expect(second.deliveryId).toBe(first.deliveryId)
      expect(verifySignature(secret, second.signature, second.body)).toBe(true)
      expect(second.body).toBe(first.body)

      const seen = new Set(receiver.deliveries.map((delivery) => delivery.deliveryId))
      expect(seen.size).toBe(1)

      const listed = await apiOk<{ deliveries: Array<{ id: string }> }>('/settings/webhook/deliveries?limit=10')
      expect(listed.body.deliveries.some((item) => item.id === first.deliveryId)).toBe(true)
    } finally {
      await receiver.close()
    }
  })
})
