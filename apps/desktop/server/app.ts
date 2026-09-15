import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import twilio from 'twilio'
import { APP_TWILIO_CLIENT_IDENTITY } from '../src/shared/app-identity.js'
import { createTwilioAccessToken, twilioTokenCredentials } from '../src/main/config/twilio-token.js'

const minimumTokenSecretBytes = 32

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = 'application/json'
): void {
  response.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'cache-control': 'no-store'
  })
  response.end(body)
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

export function isStrongTokenSecret(secret: string | undefined): secret is string {
  return Boolean(secret && secret.trim() === secret && Buffer.byteLength(secret, 'utf8') >= minimumTokenSecretBytes)
}

export function isAuthorizedTokenRequest(
  authorization: string | string[] | undefined,
  expectedSecret: string
): boolean {
  if (typeof authorization !== 'string') return false
  const match = /^Bearer\s+(\S+)$/i.exec(authorization)
  if (!match) return false

  const expected = Buffer.from(expectedSecret, 'utf8')
  const supplied = Buffer.from(match[1], 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function tokenResponse(identity: string): string {
  const token = createTwilioAccessToken({
    credentials: twilioTokenCredentials(process.env),
    identity,
    ttl: 3_600
  })
  return JSON.stringify({ identity, token })
}

function incomingTwiml(identity: string): string {
  const response = new twilio.twiml.VoiceResponse()
  response.dial().client(identity)
  return response.toString()
}

export function outgoingTwiml(to: string): string {
  const response = new twilio.twiml.VoiceResponse()
  const callerId = env('TWILIO_PHONE_NUMBER')
  const dial = response.dial({ callerId, answerOnBridge: true })
  if (/^\+[1-9]\d{6,14}$/.test(to)) {
    dial.number(to)
  } else if (/^[A-Za-z0-9_-]{1,121}$/.test(to)) {
    dial.client(to)
  } else {
    response.say('The destination is invalid.')
  }
  return response.toString()
}

export function validateTwilioWebhook(
  request: IncomingMessage,
  url: URL,
  form: URLSearchParams
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) return false
  const signature = request.headers['x-twilio-signature']
  if (typeof signature !== 'string') return false
  const publicBaseUrl = process.env.TWILIO_PUBLIC_BASE_URL?.replace(/\/$/, '')
  const requestUrl = publicBaseUrl
    ? `${publicBaseUrl}${url.pathname}${url.search}`
    : url.toString()
  return twilio.validateRequest(authToken, signature, requestUrl, Object.fromEntries(form))
}

export function createTwilioHelperServer(host: string, port: number) {
  const identity = process.env.TWILIO_CLIENT_IDENTITY ?? APP_TWILIO_CLIENT_IDENTITY

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`)
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, JSON.stringify({ ok: true }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/token') {
        const expectedSecret = process.env.APP_TOKEN_SECRET
        if (!isStrongTokenSecret(expectedSecret)) {
          send(response, 503, JSON.stringify({ error: 'Token service is not securely configured' }))
          return
        }
        if (!isAuthorizedTokenRequest(request.headers.authorization, expectedSecret)) {
          send(response, 401, JSON.stringify({ error: 'Unauthorized' }))
          return
        }
        send(response, 200, tokenResponse(identity))
        return
      }
      if (request.method === 'POST' && url.pathname === '/voice/incoming') {
        const form = await readForm(request)
        if (!validateTwilioWebhook(request, url, form)) {
          send(response, 403, JSON.stringify({ error: 'Invalid Twilio signature' }))
          return
        }
        send(response, 200, incomingTwiml(identity), 'application/xml')
        return
      }
      if (request.method === 'POST' && url.pathname === '/voice/outgoing') {
        const form = await readForm(request)
        if (!validateTwilioWebhook(request, url, form)) {
          send(response, 403, JSON.stringify({ error: 'Invalid Twilio signature' }))
          return
        }
        send(response, 200, outgoingTwiml(form.get('To') ?? ''), 'application/xml')
        return
      }
      send(response, 404, JSON.stringify({ error: 'Not found' }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send(response, 500, JSON.stringify({ error: message }))
    }
  })
}
