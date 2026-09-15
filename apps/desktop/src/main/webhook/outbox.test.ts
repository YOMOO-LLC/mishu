import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WebhookOutbox } from './outbox'
import { verifySignature } from './signer'
import type { WebhookConfig } from './types'

const SECRET = 'test-webhook-secret'

interface FakeEndpoint {
  baseUrl: string
  requests: Array<{ headers: Record<string, string | string[] | undefined>; body: string; signatureValid: boolean }>
  close: () => Promise<void>
}

async function startFakeEndpoint(statuses: number[]): Promise<FakeEndpoint> {
  const requests: FakeEndpoint['requests'] = []
  let index = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const signature = request.headers['x-mishu-signature']
      requests.push({
        headers: request.headers,
        body,
        signatureValid: verifySignature(SECRET, typeof signature === 'string' ? signature : undefined, body, 60_000)
      })
      const status = index < statuses.length ? statuses[index] : 200
      index += 1
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: status >= 200 && status < 300 }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

function makeConfig(url: string, events: WebhookConfig['events'] = ['call.started']): WebhookConfig {
  return { url, secret: SECRET, enabled: true, events }
}

describe('WebhookOutbox', () => {
  let database: DatabaseSync
  let outbox: WebhookOutbox
  const endpoints: FakeEndpoint[] = []

  afterEach(async () => {
    outbox?.close()
    database?.close()
    await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()))
  })

  function createOutbox(config?: WebhookConfig): WebhookOutbox {
    database = new DatabaseSync(':memory:')
    outbox = new WebhookOutbox({
      database,
      getConfig: () => config,
      timeoutMs: 3_000
    })
    return outbox
  }

  it('delivers a signed payload to a local endpoint and records success', async () => {
    const endpoint = await startFakeEndpoint([200])
    endpoints.push(endpoint)
    createOutbox(makeConfig(endpoint.baseUrl))

    const { id } = outbox.enqueue({
      event: 'call.started',
      data: { callId: 'call-1', peer: '+13125550198' }
    })
    const result = await outbox.deliverDue()

    expect(result.delivered).toBe(1)
    expect(endpoint.requests).toHaveLength(1)
    const request = endpoint.requests[0]
    expect(request.signatureValid).toBe(true)
    expect(request.headers['x-mishu-event']).toBe('call.started')
    expect(request.headers['x-mishu-delivery-id']).toBe(id)
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.body).toContain('"event":"call.started"')
    expect(request.body).toContain(`"id":"${id}"`)

    const record = outbox.getStatus(id)
    expect(record?.status).toBe('delivered')
    expect(record?.attempts).toBe(1)
    expect(record?.deliveredAt).not.toBeNull()
    expect(record?.nextAttemptAt).toBeNull()
  })

  it('retries with the fixed backoff sequence 1s, 5s, then delivers on the 3rd attempt', async () => {
    const endpoint = await startFakeEndpoint([500, 500])
    endpoints.push(endpoint)
    createOutbox(makeConfig(endpoint.baseUrl))

    const t0 = 1_700_000_000_000
    const { id } = outbox.enqueue({ event: 'call.started', createdAt: t0 })
    const first = await outbox.deliverDue(t0)
    expect(first.failed).toBe(1)
    let record = outbox.getStatus(id)
    expect(record?.status).toBe('failed')
    expect(record?.attempts).toBe(1)
    expect(record?.nextAttemptAt).toBe(t0 + 1_000)

    const second = await outbox.deliverDue(t0 + 1_000)
    expect(second.failed).toBe(1)
    record = outbox.getStatus(id)
    expect(record?.attempts).toBe(2)
    expect(record?.nextAttemptAt).toBe(t0 + 1_000 + 5_000)

    const third = await outbox.deliverDue(t0 + 1_000 + 5_000)
    expect(third.delivered).toBe(1)
    record = outbox.getStatus(id)
    expect(record?.status).toBe('delivered')
    expect(record?.attempts).toBe(3)
    expect(record?.nextAttemptAt).toBeNull()
    expect(endpoint.requests).toHaveLength(3)
  })

  it('marks a message dead after exhausting 8 attempts and stops delivering', async () => {
    const endpoint = await startFakeEndpoint(Array(8).fill(500))
    endpoints.push(endpoint)
    createOutbox(makeConfig(endpoint.baseUrl))

    let now = 1_700_000_000_000
    const { id } = outbox.enqueue({ event: 'call.started', createdAt: now })
    for (let i = 0; i < 8; i += 1) {
      const result = await outbox.deliverDue(now)
      const record = outbox.getStatus(id)
      const expected = i < 7 ? 'failed' : 'dead'
      expect(result.failed + result.dead).toBe(1)
      expect(record?.attempts).toBe(i + 1)
      expect(record?.status).toBe(expected)
      now = record?.nextAttemptAt ?? now
    }

    const requestsBefore = endpoint.requests.length
    const result = await outbox.deliverDue(now + 1_000_000)
    expect(result.dead).toBe(0)
    expect(result.failed).toBe(0)
    expect(endpoint.requests.length).toBe(requestsBefore)
    expect(outbox.getStatus(id)?.status).toBe('dead')
  })

  it('deduplicates enqueue by idempotencyKey', () => {
    createOutbox(makeConfig('https://example.invalid/hook'))

    const first = outbox.enqueue({ event: 'call.started', idempotencyKey: 'dup-1' })
    const second = outbox.enqueue({ event: 'call.started', idempotencyKey: 'dup-1' })

    expect(second.id).toBe(first.id)
    expect(second.alreadyExisted).toBe(true)
    expect(outbox.list()).toHaveLength(1)
  })

  it('enqueues distinct events when idempotencyKey differs', () => {
    createOutbox(makeConfig('https://example.invalid/hook'))

    const first = outbox.enqueue({ event: 'call.started', idempotencyKey: 'a' })
    const second = outbox.enqueue({ event: 'call.ended', idempotencyKey: 'b' })

    expect(first.id).not.toBe(second.id)
    expect(outbox.list()).toHaveLength(2)
  })

  it('does not deliver events not subscribed in config', async () => {
    const endpoint = await startFakeEndpoint([200])
    endpoints.push(endpoint)
    createOutbox(makeConfig(endpoint.baseUrl, ['call.ended']))

    outbox.enqueue({ event: 'call.started' })
    const result = await outbox.deliverDue()

    expect(result.skipped).toBe(1)
    expect(endpoint.requests).toHaveLength(0)
  })

  it('records a network failure as a failed attempt with a stored error', async () => {
    createOutbox(makeConfig('http://127.0.0.1:1/closed-port'))
    const { id } = outbox.enqueue({ event: 'call.started' })

    const result = await outbox.deliverDue()

    expect(result.failed).toBe(1)
    const record = outbox.getStatus(id)
    expect(record?.status).toBe('failed')
    expect(record?.lastStatusCode).toBeNull()
    expect(record?.lastError).toBeTruthy()
  })

  it('startScheduler delivers due events without a manual tick', async () => {
    const endpoint = await startFakeEndpoint([200])
    endpoints.push(endpoint)
    createOutbox(makeConfig(endpoint.baseUrl))

    outbox.enqueue({ event: 'call.started' })
    outbox.startScheduler(20)
    await new Promise((resolve) => setTimeout(resolve, 300))
    outbox.stopScheduler()

    expect(endpoint.requests.length).toBeGreaterThanOrEqual(1)
  })

  it('rejects an invalid event type on enqueue', () => {
    createOutbox(makeConfig('https://example.invalid/hook'))
    expect(() => outbox.enqueue({ event: 'not-an-event' as never })).toThrow()
  })

  it('migrates a v1 outbox without losing rows and accepts crm.synced', () => {
    database = new DatabaseSync(':memory:')
    database.exec(`
      CREATE TABLE webhook_schema_version (version INTEGER NOT NULL) STRICT;
      INSERT INTO webhook_schema_version (version) VALUES (1);
      CREATE TABLE webhook_outbox (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (event_type IN ('call.started', 'call.ended')),
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')),
        last_status_code INTEGER,
        last_error TEXT,
        delivered_at INTEGER,
        idempotency_key TEXT UNIQUE
      ) STRICT;
      INSERT INTO webhook_outbox VALUES (
        'legacy', 'call.started', '{"event":"call.started"}', 1, 0, 1,
        'pending', NULL, NULL, NULL, 'legacy-key'
      );
    `)
    outbox = new WebhookOutbox({ database })

    outbox.enqueue({ event: 'crm.synced', idempotencyKey: 'crm-key' })

    expect(outbox.list().map(({ id }) => id)).toContain('legacy')
    expect(outbox.list().some(({ eventType }) => eventType === 'crm.synced')).toBe(true)
  })

  it('migrates a v2 outbox onto tenant-scoped idempotency keys', () => {
    database = new DatabaseSync(':memory:')
    database.exec(`
      CREATE TABLE webhook_schema_version (version INTEGER NOT NULL) STRICT;
      INSERT INTO webhook_schema_version (version) VALUES (2);
      CREATE TABLE webhook_outbox (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (event_type IN ('call.started', 'call.ended', 'crm.synced')),
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')),
        last_status_code INTEGER,
        last_error TEXT,
        delivered_at INTEGER,
        idempotency_key TEXT UNIQUE
      ) STRICT;
      INSERT INTO webhook_outbox VALUES (
        'legacy', 'call.started', '{"event":"call.started"}', 1, 0, 1,
        'pending', NULL, NULL, NULL, 'legacy-key'
      );
    `)
    outbox = new WebhookOutbox({ database })
    const duplicate = outbox.enqueue({ event: 'call.started', idempotencyKey: 'legacy-key' })
    expect(duplicate.alreadyExisted).toBe(true)
    expect(duplicate.id).toBe('legacy')
    const row = database.prepare('SELECT tenant_id FROM webhook_outbox WHERE id = ?').get('legacy') as { tenant_id: string }
    expect(row.tenant_id).toBe('local')
    expect(outbox.list()[0]?.payload.tenantId).toBe('local')
    new WebhookOutbox({ database })
  })
})
