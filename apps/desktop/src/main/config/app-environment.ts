import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'dotenv'
import { APP_USER_DATA_DIR_NAME } from '../../shared/app-identity.js'

const TWILIO_CREDENTIAL_NAMES = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_TWIML_APP_SID'
] as const

export interface ElectronPathAdapter {
  getPath(name: 'appData'): string
  setPath(name: 'userData', path: string): void
}

export interface LoadAppEnvironmentOptions {
  isPackaged: boolean
  userDataPath: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
}

export interface LoadedAppEnvironment {
  configPath: string
  loaded: boolean
}

export interface RuntimeModeState {
  mockMode: boolean
  explicitMockOverride?: '0' | '1'
}

export function commandLineUserDataPath(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument?.startsWith('--user-data-dir=')) {
      const value = argument.slice('--user-data-dir='.length).trim()
      if (value) return resolve(value)
    }
    if (argument === '--user-data-dir') {
      const value = argv[index + 1]?.trim()
      if (value) return resolve(value)
    }
  }
  return undefined
}

export function configureUserDataPath(
  electronApp: ElectronPathAdapter,
  argv: string[] = process.argv
): string {
  const path = commandLineUserDataPath(argv)
    ?? join(electronApp.getPath('appData'), APP_USER_DATA_DIR_NAME)
  electronApp.setPath('userData', path)
  return path
}

export function loadAppEnvironment({
  isPackaged,
  userDataPath,
  cwd = process.cwd(),
  env = process.env,
  warn = console.warn
}: LoadAppEnvironmentOptions): LoadedAppEnvironment {
  const configPath = isPackaged ? join(userDataPath, '.env') : resolve(cwd, '.env')
  if (env.LIVE_PHONE_SKIP_ENV_FILE === '1') return { configPath, loaded: false }
  if (!existsSync(configPath)) return { configPath, loaded: false }

  if (isPackaged && (statSync(configPath).mode & 0o077) !== 0) {
    warn(`[config] ${configPath} permissions are broader than 0600; run chmod 600 on this file`)
  }

  const parsed = parse(readFileSync(configPath))
  for (const [name, value] of Object.entries(parsed)) {
    if (env[name] === undefined) env[name] = value
  }
  return { configPath, loaded: true }
}

export function hasCompleteTwilioCredentials(
  env: NodeJS.ProcessEnv = process.env,
  settings?: { accountSid: string; apiKeySid: string; apiKeySecret: string; twimlAppSid: string }
): boolean {
  if (settings) return Boolean(settings.accountSid && settings.apiKeySid && settings.apiKeySecret && settings.twimlAppSid)
  return TWILIO_CREDENTIAL_NAMES.every((name) => Boolean(env[name]?.trim()))
}

export function resolveMockMode({
  env = process.env,
  isPackaged,
  settings
}: {
  env?: NodeJS.ProcessEnv
  isPackaged: boolean
  settings?: { resolveMockMode(): boolean }
}): boolean {
  const explicit = env.LIVE_PHONE_USE_MOCKS?.trim()
  if (explicit !== undefined && explicit !== '') {
    if (explicit === '1') return true
    if (explicit === '0') return false
    throw new Error('LIVE_PHONE_USE_MOCKS must be either 1 or 0')
  }
  if (settings) return settings.resolveMockMode()
  if (!isPackaged) return true
  return !hasCompleteTwilioCredentials(env)
}

export function resolveRuntimeModeState(options: {
  env?: NodeJS.ProcessEnv
  isPackaged: boolean
  settings?: { resolveMockMode(): boolean }
}): RuntimeModeState {
  const env = options.env ?? process.env
  const explicit = env.LIVE_PHONE_USE_MOCKS?.trim()
  const mockMode = resolveMockMode({ ...options, env })
  return {
    mockMode,
    ...(explicit === '0' || explicit === '1' ? { explicitMockOverride: explicit } : {})
  }
}

/** Keep only the user's startup override; a derived mode must never survive relaunch. */
export function restoreExplicitMockOverride(
  env: NodeJS.ProcessEnv,
  state: RuntimeModeState
): void {
  if (state.explicitMockOverride) env.LIVE_PHONE_USE_MOCKS = state.explicitMockOverride
  else delete env.LIVE_PHONE_USE_MOCKS
}
