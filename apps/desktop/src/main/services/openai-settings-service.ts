import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { OpenAiSettingsPublic, OpenAiSettingsSaveInput, OpenAiTestResult } from '../../shared/contracts.js'
import { ServiceError } from './service-error.js'

export interface OpenAiSettingsOptions {
  userDataPath: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  apiBaseUrl?: string
  callInProgress?(): boolean
}

export class OpenAiSettingsService {
  private key = ''
  private readonly path: string
  private readonly env: NodeJS.ProcessEnv
  constructor(private readonly options: OpenAiSettingsOptions) {
    this.path = join(options.userDataPath, 'openai-settings.json')
    this.env = options.env ?? process.env
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof value.apiKey === 'string') this.key = value.apiKey
      chmodSync(this.path, 0o600)
    } catch { /* No saved key. */ }
  }
  get(): OpenAiSettingsPublic {
    const key = this.apiKey()
    const source = this.env.OPENAI_API_KEY?.trim() ? 'env' : this.key ? 'settings' : 'unset'
    return { apiKey: { configured: Boolean(key), ...(key ? { last4: key.slice(-4) } : {}), source, readOnly: source === 'env' } }
  }
  save(input: OpenAiSettingsSaveInput): OpenAiSettingsPublic {
    if (this.options.callInProgress?.()) throw new ServiceError('CALL_IN_PROGRESS', 'Cannot change OpenAI settings during a call')
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'apiKey')) {
      throw new ServiceError('INVALID_ARGUMENT', 'Invalid OpenAI settings')
    }
    if (input.apiKey !== undefined && input.apiKey !== null && (typeof input.apiKey !== 'string' || input.apiKey.length > 1024 || /\s/.test(input.apiKey))) {
      throw new ServiceError('INVALID_ARGUMENT', 'Invalid OpenAI key')
    }
    const key = input.apiKey === undefined ? this.key : input.apiKey ?? ''
    try {
      mkdirSync(this.options.userDataPath, { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify({ apiKey: key }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path)
      chmodSync(this.path, 0o600)
      this.key = key
    } catch { throw new ServiceError('INTERNAL_ERROR', 'Could not save OpenAI settings') }
    return this.get()
  }
  /** Main-process only: never serialize this value or forward it over IPC. */
  apiKey(): string { return this.env.OPENAI_API_KEY?.trim() || this.key }
  headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey()}`,
      ...(this.env.OPENAI_PROJECT_ID ? { 'OpenAI-Project': this.env.OPENAI_PROJECT_ID } : {}),
      ...(this.env.OPENAI_ORG_ID ? { 'OpenAI-Organization': this.env.OPENAI_ORG_ID } : {})
    }
  }
  async test(): Promise<OpenAiTestResult> {
    if (!this.apiKey()) return { ok: false, code: 'NOT_CONFIGURED' }
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.options.apiBaseUrl ?? 'https://api.openai.com'}/v1/models/gpt-live-1`, {
        headers: this.headers(), signal: AbortSignal.timeout(10_000), redirect: 'error'
      })
      return { ok: response.ok, code: response.ok ? 'OK' : `HTTP_${response.status}` }
    } catch { return { ok: false, code: 'NETWORK_ERROR' } }
  }
}
