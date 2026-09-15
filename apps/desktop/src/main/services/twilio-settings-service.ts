import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from 'dotenv'
import type {
  TwilioCheckResult,
  TwilioFieldSource,
  TwilioSettingsPublic,
  TwilioSettingsSaveInput,
  TwilioTestResult
} from '../../shared/contracts.js'
import { createTwilioAccessToken, type TwilioTokenCredentials } from '../config/twilio-token.js'
import { ServiceError } from './service-error.js'

export type TwilioMode = 'auto' | 'twilio' | 'mock'

interface StoredTwilioSettings {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  twimlAppSid: string
  phoneNumber: string
  clientIdentity: string
  mode: TwilioMode
}

export interface EffectiveTwilioSettings extends StoredTwilioSettings {
  sources: Record<keyof Omit<StoredTwilioSettings, 'mode'>, TwilioFieldSource>
}

export interface TwilioSettingsServiceOptions {
  userDataPath: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  signToken?: typeof createTwilioAccessToken
  isPackaged?: boolean
  apiBaseUrl?: string
  audit?(action: string, details: Record<string, unknown>): void
  relaunch?(): void
  callInProgress?(): boolean
}

const ENV_FIELDS = {
  accountSid: 'TWILIO_ACCOUNT_SID',
  apiKeySid: 'TWILIO_API_KEY_SID',
  apiKeySecret: 'TWILIO_API_KEY_SECRET',
  twimlAppSid: 'TWILIO_TWIML_APP_SID',
  phoneNumber: 'TWILIO_PHONE_NUMBER',
  clientIdentity: 'TWILIO_CLIENT_IDENTITY'
} as const

const DEFAULTS: StoredTwilioSettings = {
  accountSid: '',
  apiKeySid: '',
  apiKeySecret: '',
  twimlAppSid: '',
  phoneNumber: '',
  clientIdentity: 'mishu',
  mode: 'auto'
}

export class TwilioSettingsService {
  readonly path: string
  private value: StoredTwilioSettings
  private readonly env: NodeJS.ProcessEnv
  private readonly fetcher: typeof fetch
  private readonly signToken: typeof createTwilioAccessToken
  private readonly audit?: TwilioSettingsServiceOptions['audit']
  private readonly relaunchApp?: TwilioSettingsServiceOptions['relaunch']
  private readonly callInProgress: () => boolean
  private readonly mockOverride?: string
  private readonly currentMockMode: boolean
  private readonly apiBaseUrl: string

  constructor(options: TwilioSettingsServiceOptions) {
    this.path = join(options.userDataPath, 'twilio-settings.json')
    this.env = options.env ?? process.env
    this.fetcher = options.fetch ?? fetch
    this.signToken = options.signToken ?? createTwilioAccessToken
    this.audit = options.audit
    this.relaunchApp = options.relaunch
    this.callInProgress = options.callInProgress ?? (() => false)
    this.mockOverride = this.env.LIVE_PHONE_USE_MOCKS?.trim() || undefined
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.twilio.com').replace(/\/$/, '')
    this.value = this.load()
    this.currentMockMode = this.resolveMockMode()
  }

  effective(): EffectiveTwilioSettings {
    const sources = {} as EffectiveTwilioSettings['sources']
    const values = {} as Omit<StoredTwilioSettings, 'mode'>
    for (const field of Object.keys(ENV_FIELDS) as Array<keyof typeof ENV_FIELDS>) {
      const fromEnv = this.env[ENV_FIELDS[field]]?.trim()
      values[field] = fromEnv || this.value[field]
      sources[field] = fromEnv ? 'env' : this.value[field] ? 'settings' : 'unset'
    }
    return { ...values, mode: this.value.mode, sources }
  }

  get(): TwilioSettingsPublic {
    const effective = this.effective()
    const desiredMockMode = this.resolveMockMode()
    const currentMockMode = this.currentMockMode
    return {
      accountSid: maskedField(effective.accountSid, effective.sources.accountSid, 'AC'),
      apiKeySid: maskedField(effective.apiKeySid, effective.sources.apiKeySid, 'SK'),
      apiKeySecret: secretField(effective.apiKeySecret, effective.sources.apiKeySecret),
      twimlAppSid: maskedField(effective.twimlAppSid, effective.sources.twimlAppSid, 'AP'),
      phoneNumber: {
        configured: Boolean(effective.phoneNumber),
        value: effective.phoneNumber,
        source: effective.sources.phoneNumber,
        readOnly: effective.sources.phoneNumber === 'env'
      },
      clientIdentity: {
        configured: Boolean(effective.clientIdentity),
        value: effective.clientIdentity,
        source: effective.sources.clientIdentity,
        readOnly: effective.sources.clientIdentity === 'env'
      },
      mode: effective.mode,
      effectiveMode: desiredMockMode ? 'mock' : 'twilio',
      configured: hasCompleteCredentials(effective),
      restartRequired: desiredMockMode !== currentMockMode
    }
  }

  save(input: TwilioSettingsSaveInput): TwilioSettingsPublic {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ServiceError('INVALID_ARGUMENT', 'Twilio settings input must be an object')
    }
    const next = { ...this.value }
    const changed: string[] = []
    for (const field of ['accountSid', 'apiKeySid', 'twimlAppSid', 'phoneNumber', 'clientIdentity'] as const) {
      if (input[field] === undefined) continue
      if (input[field] !== null && typeof input[field] !== 'string') invalid(field)
      next[field] = typeof input[field] === 'string' ? input[field]!.trim() : ''
      changed.push(field)
    }
    if (input.apiKeySecret !== undefined && input.apiKeySecret !== '') {
      if (input.apiKeySecret !== null && typeof input.apiKeySecret !== 'string') invalid('apiKeySecret')
      next.apiKeySecret = input.apiKeySecret === null ? '' : input.apiKeySecret.trim()
      changed.push('apiKeySecret')
    }
    if (input.mode !== undefined) {
      if (!['auto', 'twilio', 'mock'].includes(input.mode)) invalid('mode')
      next.mode = input.mode
      changed.push('mode')
    }
    if (!next.clientIdentity) next.clientIdentity = DEFAULTS.clientIdentity
    validate(next)
    this.persist(next)
    this.value = next
    this.audit?.('settings.twilio.updated', {
      fields: changed,
      sources: Object.fromEntries(changed.map((field) => [field, field === 'mode' ? 'settings' : this.effective().sources[field as keyof EffectiveTwilioSettings['sources']]]))
    })
    return this.get()
  }

  importEnv(filePath: string): { imported: string[]; settings: TwilioSettingsPublic } {
    if (typeof filePath !== 'string' || !filePath.trim()) invalid('path')
    let parsed: Record<string, string>
    try {
      parsed = parse(readFileSync(filePath, 'utf8'))
    } catch {
      throw new ServiceError('INVALID_ARGUMENT', 'Could not read the selected .env file')
    }
    const input: TwilioSettingsSaveInput = {}
    const imported: string[] = []
    for (const [field, name] of Object.entries(ENV_FIELDS) as Array<[keyof typeof ENV_FIELDS, string]>) {
      const value = parsed[name]?.trim()
      if (value === undefined) continue
      input[field] = value
      imported.push(name)
    }
    if (imported.length === 0) {
      throw new ServiceError('INVALID_ARGUMENT', 'The selected file does not contain supported TWILIO_* settings')
    }
    const settings = this.save(input)
    this.audit?.('settings.twilio.imported', { fields: imported })
    return { imported, settings }
  }

  credentials(): TwilioTokenCredentials | undefined {
    const effective = this.effective()
    if (!hasCompleteCredentials(effective)) return undefined
    return {
      accountSid: effective.accountSid,
      apiKeySid: effective.apiKeySid,
      apiKeySecret: effective.apiKeySecret,
      twimlAppSid: effective.twimlAppSid
    }
  }

  identity(): string { return this.effective().clientIdentity || DEFAULTS.clientIdentity }
  phoneNumber(): string | undefined { return this.effective().phoneNumber || undefined }

  resolveMockMode(): boolean {
    const explicit = this.mockOverride
    if (explicit) {
      if (explicit === '1') return true
      if (explicit === '0') return false
      throw new ServiceError('INVALID_ARGUMENT', 'LIVE_PHONE_USE_MOCKS must be either 1 or 0')
    }
    if (this.value.mode === 'mock') return true
    if (this.value.mode === 'twilio') return false
    return !hasCompleteCredentials(this.effective())
  }

  async test(): Promise<TwilioTestResult> {
    const effective = this.effective()
    const checks: TwilioCheckResult[] = []
    let credentials: TwilioTokenCredentials
    try {
      validate(effective)
      const resolved = this.credentials()
      if (!resolved) throw new ServiceError('INVALID_ARGUMENT', 'Complete Twilio credentials are required')
      credentials = resolved
      this.signToken({ credentials, identity: this.identity(), ttl: 3_600 })
      checks.push({ check: 'token', ok: true, code: 'OK' })
    } catch (error) {
      checks.push({ check: 'token', ok: false, code: serviceCode(error) })
      const result = { ok: false, checks }
      this.audit?.('settings.twilio.tested', { results: checks.map(({ check, code, ok }) => ({ check, code, ok })) })
      return result
    }

    const authorization = `Basic ${Buffer.from(`${credentials.apiKeySid}:${credentials.apiKeySecret}`).toString('base64')}`
    checks.push(await this.twilioGet(
      `${this.apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/Applications/${encodeURIComponent(credentials.twimlAppSid)}.json`,
      authorization,
      'application'
    ))
    if (effective.phoneNumber) {
      checks.push(await this.twilioGet(
        `${this.apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(effective.phoneNumber)}`,
        authorization,
        'phoneNumber',
        true
      ))
    }
    const result = { ok: checks.every(({ ok }) => ok), checks }
    this.audit?.('settings.twilio.tested', { results: checks.map(({ check, code, ok }) => ({ check, code, ok })) })
    return result
  }

  relaunch(): { accepted: true } {
    if (this.callInProgress()) throw new ServiceError('CALL_IN_PROGRESS', 'Cannot relaunch while a call is in progress')
    this.audit?.('app.relaunch', {})
    this.relaunchApp?.()
    return { accepted: true }
  }

  private async twilioGet(url: string, authorization: string, check: TwilioCheckResult['check'], requireItem = false): Promise<TwilioCheckResult> {
    try {
      const response = await this.fetcher(url, { method: 'GET', headers: { authorization } })
      if (!response.ok) return { check, ok: false, code: `HTTP_${response.status}` }
      if (requireItem) {
        const body = await response.json() as { incoming_phone_numbers?: unknown[] }
        if (!Array.isArray(body.incoming_phone_numbers) || body.incoming_phone_numbers.length === 0) {
          return { check, ok: false, code: 'NOT_FOUND' }
        }
      }
      return { check, ok: true, code: 'OK' }
    } catch {
      return { check, ok: false, code: 'NETWORK_ERROR' }
    }
  }

  private load(): StoredTwilioSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredTwilioSettings>
      const value: StoredTwilioSettings = {
        accountSid: stringValue(parsed.accountSid),
        apiKeySid: stringValue(parsed.apiKeySid),
        apiKeySecret: stringValue(parsed.apiKeySecret),
        twimlAppSid: stringValue(parsed.twimlAppSid),
        phoneNumber: stringValue(parsed.phoneNumber),
        clientIdentity: stringValue(parsed.clientIdentity) || DEFAULTS.clientIdentity,
        mode: ['auto', 'twilio', 'mock'].includes(parsed.mode ?? '') ? parsed.mode as TwilioMode : 'auto'
      }
      validate(value)
      chmodSync(this.path, 0o600)
      return value
    } catch {
      return { ...DEFAULTS }
    }
  }

  private persist(value: StoredTwilioSettings): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}

export function hasCompleteCredentials(value: Pick<StoredTwilioSettings, 'accountSid' | 'apiKeySid' | 'apiKeySecret' | 'twimlAppSid'>): boolean {
  return Boolean(value.accountSid && value.apiKeySid && value.apiKeySecret && value.twimlAppSid)
}

function validate(value: StoredTwilioSettings | EffectiveTwilioSettings): void {
  validateSid(value.accountSid, 'accountSid', 'AC')
  validateSid(value.apiKeySid, 'apiKeySid', 'SK')
  validateSid(value.twimlAppSid, 'twimlAppSid', 'AP')
  if (value.phoneNumber && !/^\+[1-9]\d{7,14}$/.test(value.phoneNumber)) invalid('phoneNumber')
  if (value.clientIdentity.length > 121) invalid('clientIdentity')
}

function validateSid(value: string, field: string, prefix: string): void {
  if (value && !new RegExp(`^${prefix}[0-9a-fA-F]{32}$`).test(value)) invalid(field)
}

function invalid(field: string): never {
  throw new ServiceError('INVALID_ARGUMENT', `Invalid Twilio field: ${field}`)
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function last4(value: string): string | undefined { return value ? value.slice(-4) : undefined }
function maskedField(value: string, source: TwilioFieldSource, prefix: string) {
  return { configured: Boolean(value), last4: last4(value), masked: value ? `${prefix}…${value.slice(-4)}` : undefined, source, readOnly: source === 'env' }
}
function secretField(value: string, source: TwilioFieldSource) {
  return { configured: Boolean(value), last4: last4(value), source, readOnly: source === 'env' }
}
function serviceCode(error: unknown): string {
  return error instanceof ServiceError ? error.code : 'TOKEN_SIGN_FAILED'
}
