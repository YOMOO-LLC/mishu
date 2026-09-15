import twilio from 'twilio'
import { hasCompleteTwilioCredentials } from './app-environment.js'

export interface TwilioTokenCredentials {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  twimlAppSid: string
}

export interface CreateTwilioTokenOptions {
  credentials: TwilioTokenCredentials
  identity?: string
  ttl?: number
}

export type TwilioTokenSigner = (options: CreateTwilioTokenOptions) => string

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function twilioTokenCredentials(env: NodeJS.ProcessEnv = process.env): TwilioTokenCredentials {
  return {
    accountSid: required(env, 'TWILIO_ACCOUNT_SID'),
    apiKeySid: required(env, 'TWILIO_API_KEY_SID'),
    apiKeySecret: required(env, 'TWILIO_API_KEY_SECRET'),
    twimlAppSid: required(env, 'TWILIO_TWIML_APP_SID')
  }
}

export function createTwilioAccessToken({
  credentials,
  identity = 'mishu',
  ttl = 3_600
}: CreateTwilioTokenOptions): string {
  const AccessToken = twilio.jwt.AccessToken
  const token = new AccessToken(
    credentials.accountSid,
    credentials.apiKeySid,
    credentials.apiKeySecret,
    { identity, ttl }
  )
  token.addGrant(new AccessToken.VoiceGrant({
    incomingAllow: true,
    outgoingApplicationSid: credentials.twimlAppSid
  }))
  return token.toJwt()
}

export async function loadTwilioAccessToken({
  env = process.env,
  fetchToken = fetch,
  signToken = createTwilioAccessToken,
  credentials,
  identity
}: {
  env?: NodeJS.ProcessEnv
  fetchToken?: typeof fetch
  signToken?: TwilioTokenSigner
  credentials?: TwilioTokenCredentials
  identity?: string
} = {}): Promise<string | undefined> {
  const inlineToken = env.TWILIO_ACCESS_TOKEN?.trim()
  if (inlineToken) return inlineToken

  const tokenUrl = env.TWILIO_TOKEN_URL?.trim()
  if (tokenUrl) {
    const headers = new Headers()
    const secret = env.APP_TOKEN_SECRET?.trim()
    if (secret) headers.set('authorization', `Bearer ${secret}`)
    const response = await fetchToken(tokenUrl, { headers })
    if (!response.ok) throw new Error(`Twilio token endpoint returned ${response.status}`)
    const payload = (await response.json()) as { token?: unknown }
    if (typeof payload.token !== 'string' || !payload.token) {
      throw new Error('Twilio token endpoint did not return a token')
    }
    return payload.token
  }

  const resolvedCredentials = credentials ?? (hasCompleteTwilioCredentials(env) ? twilioTokenCredentials(env) : undefined)
  if (!resolvedCredentials) return undefined
  return signToken({
    credentials: resolvedCredentials,
    identity: identity ?? (env.TWILIO_CLIENT_IDENTITY?.trim() || 'mishu'),
    ttl: 3_600
  })
}
