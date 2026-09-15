import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySignature } from './verify.js'

export const SIGNATURE_HEADER = 'x-mishu-signature'
export const EVENT_HEADER = 'x-mishu-event'
export const DELIVERY_ID_HEADER = 'x-mishu-delivery-id'

export interface CapturedRequest {
  url: string
  body: string
  signature: string | undefined
  event: string | undefined
  deliveryId: string | undefined
  verified: boolean
  status: number
}

export interface WebhookReceiverHandle {
  baseUrl: string
  port: number
  secret: string
  deliveries: CapturedRequest[]
  close(): Promise<void>
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export async function startWebhookReceiver(options: {
  secret: string
  port?: number
} = { secret: 'example-webhook-secret' }): Promise<WebhookReceiverHandle> {
  const secret = options.secret
  const deliveries: CapturedRequest[] = []

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const signature = header(request, SIGNATURE_HEADER)
      const verified = verifySignature(secret, signature, body)
      const status = verified ? 200 : 401
      deliveries.push({
        url: request.url ?? '/',
        body,
        signature,
        event: header(request, EVENT_HEADER),
        deliveryId: header(request, DELIVERY_ID_HEADER),
        verified,
        status
      })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: verified }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    secret,
    deliveries,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeIdleConnections?.()
      })
  }
}

async function main(): Promise<void> {
  const secret = process.env.WEBHOOK_SECRET
  if (!secret) {
    process.stderr.write('Set WEBHOOK_SECRET to the hex secret from POST /v1/settings/webhook (never commit it).\n')
    process.exitCode = 1
    return
  }
  const port = process.env.PORT ? Number(process.env.PORT) : 0
  const receiver = await startWebhookReceiver({ secret, port })
  process.stdout.write(`${JSON.stringify({ ready: true, baseUrl: receiver.baseUrl })}\n`)
  const stop = (): void => {
    void receiver.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

const thisFile = fileURLToPath(import.meta.url)
const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && thisFile === entry) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
