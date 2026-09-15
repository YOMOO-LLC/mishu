import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_USER_DATA_DIR_NAME } from '../../shared/app-identity.js'
import {
  commandLineUserDataPath,
  configureUserDataPath,
  loadAppEnvironment,
  resolveMockMode,
  resolveRuntimeModeState,
  restoreExplicitMockOverride
} from './app-environment.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('app environment', () => {
  it('keeps the private userData directory name stable', () => {
    expect(APP_USER_DATA_DIR_NAME).toBe('mishu')
  })

  it('fixes userData while preserving an explicit command-line override', () => {
    const setPath = vi.fn()
    const app = { getPath: vi.fn(() => '/Library/Application Support'), setPath }
    expect(configureUserDataPath(app, ['electron'])).toBe('/Library/Application Support/mishu')
    expect(setPath).toHaveBeenLastCalledWith('userData', '/Library/Application Support/mishu')

    const override = commandLineUserDataPath(['electron', '--user-data-dir=/tmp/live-phone-test'])
    expect(override).toBe('/tmp/live-phone-test')
    expect(configureUserDataPath(app, ['electron', '--user-data-dir', '/tmp/other-live-phone'])).toBe('/tmp/other-live-phone')
  })

  it('loads packaged configuration without replacing process environment values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'live-phone-config-'))
    directories.push(directory)
    const path = join(directory, '.env')
    writeFileSync(path, 'FROM_FILE=loaded\nOVERRIDE_ME=file\n', { mode: 0o600 })
    const env: NodeJS.ProcessEnv = { OVERRIDE_ME: 'process' }
    const result = loadAppEnvironment({ isPackaged: true, userDataPath: directory, env })
    expect(result).toEqual({ configPath: path, loaded: true })
    expect(env).toMatchObject({ FROM_FILE: 'loaded', OVERRIDE_ME: 'process' })
    expect(readFileSync(path, 'utf8')).not.toContain('process')
  })

  it('warns about packaged config permissions without exposing config contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'live-phone-config-mode-'))
    directories.push(directory)
    const path = join(directory, '.env')
    writeFileSync(path, 'PRIVATE_VALUE=do-not-log\n')
    chmodSync(path, 0o644)
    const warn = vi.fn()
    loadAppEnvironment({ isPackaged: true, userDataPath: directory, env: {}, warn })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('0600')
    expect(warn.mock.calls[0]?.[0]).not.toContain('do-not-log')
  })

  it('keeps development mock-by-default and selects packaged Twilio from credentials', () => {
    expect(resolveMockMode({ env: {}, isPackaged: false })).toBe(true)
    expect(resolveMockMode({ env: {}, isPackaged: true })).toBe(true)
    const credentials = {
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_API_KEY_SID: 'SKtest',
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_TWIML_APP_SID: 'APtest'
    }
    expect(resolveMockMode({ env: credentials, isPackaged: true })).toBe(false)
    expect(resolveMockMode({ env: { ...credentials, LIVE_PHONE_USE_MOCKS: '1' }, isPackaged: true })).toBe(true)
    expect(resolveMockMode({ env: {}, isPackaged: true })).toBe(true)
    expect(() => resolveMockMode({ env: { LIVE_PHONE_USE_MOCKS: 'yes' }, isPackaged: true })).toThrow('either 1 or 0')
  })

  it('does not turn an inferred mock mode into an explicit relaunch override', () => {
    let configured = false
    const env: NodeJS.ProcessEnv = {}
    const settings = { resolveMockMode: () => !configured }
    const state = resolveRuntimeModeState({ env, isPackaged: true, settings })
    expect(state).toEqual({ mockMode: true })

    configured = true
    restoreExplicitMockOverride(env, state)
    expect(resolveRuntimeModeState({ env: { ...env }, isPackaged: true, settings }).mockMode).toBe(false)

    const explicitEnv: NodeJS.ProcessEnv = { LIVE_PHONE_USE_MOCKS: '1' }
    const explicit = resolveRuntimeModeState({ env: explicitEnv, isPackaged: true, settings })
    restoreExplicitMockOverride(explicitEnv, explicit)
    expect(resolveRuntimeModeState({ env: { ...explicitEnv }, isPackaged: true, settings }).mockMode).toBe(true)
  })
})
