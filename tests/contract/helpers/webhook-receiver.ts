import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CapturedDelivery {
  url: string
  statusAssigned: number
  body: string
  headers: Record<string, string>
  deliveryId: string | undefined
  event: string | undefined
  signature: string | undefined
}

export interface WebhookReceiver {
  baseUrl: string
  deliveries: CapturedDelivery[]
  failNext: number
  close: () => Promise<void>
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const deliveries: CapturedDelivery[] = []
  const receiver: WebhookReceiver = {
    baseUrl: '',
    deliveries,
    failNext: 0,
    close: async () => undefined
  }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const statusAssigned = receiver.failNext > 0 ? 500 : 200
      if (receiver.failNext > 0) receiver.failNext -= 1
      const body = Buffer.concat(chunks).toString('utf8')
      deliveries.push({
        url: request.url ?? '/',
        statusAssigned,
        body,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value ?? ''])
        ),
        deliveryId: header(request, 'x-mishu-delivery-id'),
        event: header(request, 'x-mishu-event'),
        signature: header(request, 'x-mishu-signature')
      })
      response.writeHead(statusAssigned, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: statusAssigned < 300 }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  receiver.baseUrl = `http://127.0.0.1:${address.port}`
  receiver.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  return receiver
}
