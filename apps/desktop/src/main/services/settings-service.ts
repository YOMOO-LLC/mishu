import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GeneralSettings, GeneralSettingsSaveInput } from '../../shared/contracts.js'
import { ServiceError } from './service-error.js'

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  minimizeToTray: true,
  launchAtLogin: false,
  startHidden: false
}

export interface GeneralSettingsServiceOptions {
  userDataPath: string
  platform?: NodeJS.Platform
  setLoginItemSettings?(settings: { openAtLogin: boolean }): void
}

export class GeneralSettingsService {
  readonly path: string
  private readonly platform: NodeJS.Platform
  private readonly setLoginItemSettings?: GeneralSettingsServiceOptions['setLoginItemSettings']
  private value: GeneralSettings

  constructor(options: GeneralSettingsServiceOptions) {
    this.path = join(options.userDataPath, 'general-settings.json')
    this.platform = options.platform ?? process.platform
    this.setLoginItemSettings = options.setLoginItemSettings
    this.value = this.load()
  }

  get(): GeneralSettings {
    return { ...this.value }
  }

  save(input: GeneralSettingsSaveInput): GeneralSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ServiceError('INVALID_ARGUMENT', 'General settings input must be an object')
    }
    validateBoolean(input.minimizeToTray, 'minimizeToTray')
    validateBoolean(input.launchAtLogin, 'launchAtLogin')
    validateBoolean(input.startHidden, 'startHidden')
    const next: GeneralSettings = {
      minimizeToTray: input.minimizeToTray ?? this.value.minimizeToTray,
      launchAtLogin: input.launchAtLogin ?? this.value.launchAtLogin,
      startHidden: input.startHidden ?? this.value.startHidden
    }
    if (next.launchAtLogin !== this.value.launchAtLogin && this.supportsLaunchAtLogin()) {
      this.setLoginItemSettings?.({ openAtLogin: next.launchAtLogin })
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.value = next
    return this.get()
  }

  private load(): GeneralSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<GeneralSettings>
      return {
        minimizeToTray: typeof parsed.minimizeToTray === 'boolean'
          ? parsed.minimizeToTray
          : DEFAULT_GENERAL_SETTINGS.minimizeToTray,
        launchAtLogin: typeof parsed.launchAtLogin === 'boolean'
          ? parsed.launchAtLogin
          : DEFAULT_GENERAL_SETTINGS.launchAtLogin,
        startHidden: typeof parsed.startHidden === 'boolean'
          ? parsed.startHidden
          : DEFAULT_GENERAL_SETTINGS.startHidden
      }
    } catch {
      return { ...DEFAULT_GENERAL_SETTINGS }
    }
  }

  private supportsLaunchAtLogin(): boolean {
    return this.platform === 'darwin' || this.platform === 'win32'
  }
}

export class SettingsService {
  readonly general: GeneralSettingsService

  constructor(options: GeneralSettingsServiceOptions) {
    this.general = new GeneralSettingsService(options)
  }
}

function validateBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new ServiceError('INVALID_ARGUMENT', `${name} must be a boolean`)
  }
}
