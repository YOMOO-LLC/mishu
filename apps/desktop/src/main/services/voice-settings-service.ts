import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LIVE_API_VOICES, type VoiceSettings } from '../../shared/contracts.js'
import { ServiceError } from './service-error.js'

export class VoiceSettingsService {
  private value: VoiceSettings = { provider: 'codex', apiVoice: 'marin', startPolicy: 'on_dial' }
  private readonly path: string
  constructor(private readonly userDataPath: string, private readonly callInProgress: () => boolean = () => false, private readonly changed?: (settings: VoiceSettings) => void) {
    this.path = join(userDataPath, 'voice-settings.json')
    try { this.value = validate(JSON.parse(readFileSync(this.path, 'utf8'))) } catch { /* Defaults. */ }
  }
  get(): VoiceSettings { return { ...this.value } }
  save(input: Partial<VoiceSettings>): VoiceSettings {
    if (this.callInProgress()) throw new ServiceError('CALL_IN_PROGRESS', 'Cannot change voice settings during a call')
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['provider', 'apiVoice', 'startPolicy'].includes(key))) {
      throw new ServiceError('INVALID_ARGUMENT', 'Invalid voice settings')
    }
    const next = validate({ ...this.value, ...input,
      ...(input.provider && input.provider !== this.value.provider && input.startPolicy === undefined
        ? { startPolicy: input.provider === 'codex' ? 'on_dial' : 'on_answer' } : {}) })
    mkdirSync(this.userDataPath, { recursive: true })
    const temp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.path)
    this.value = next
    this.changed?.(this.get())
    return this.get()
  }
}
function validate(value: VoiceSettings): VoiceSettings {
  if (!value || !['codex', 'gpt-live-api'].includes(value.provider) || !LIVE_API_VOICES.includes(value.apiVoice)
    || !['on_dial', 'on_answer'].includes(value.startPolicy)) throw new ServiceError('INVALID_ARGUMENT', 'Invalid voice settings')
  return { provider: value.provider, apiVoice: value.apiVoice, startPolicy: value.startPolicy }
}
