import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeService } from './runtime-service.js'

const original = { ...process.env }

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in original)) delete process.env[name]
  }
  Object.assign(process.env, original)
})

describe('RuntimeService', () => {
  it('returns safe packaged diagnostics without exposing a token in mock mode', async () => {
    process.env.LIVE_PHONE_USE_MOCKS = '1'
    process.env.LIVE_PHONE_CONFIG_PATH = '/tmp/user-data/.env'
    process.env.LIVE_PHONE_CODEX_ERROR = 'Codex CLI was not found'
    process.env.TWILIO_ACCOUNT_SID = ''
    process.env.TWILIO_API_KEY_SID = ''
    process.env.TWILIO_API_KEY_SECRET = ''
    process.env.TWILIO_TWIML_APP_SID = ''
    const loadToken = vi.fn(async () => 'should-not-load')
    const config = await new RuntimeService(loadToken, true).getConfig()
    expect(config).toMatchObject({
      mockMode: true,
      configPath: '/tmp/user-data/.env',
      codexError: 'Codex CLI was not found'
    })
    expect(config.runtimeNotice).toContain('Settings')
    expect(config).not.toHaveProperty('twilioToken')
    expect(loadToken).not.toHaveBeenCalled()
  })

  it('loads a Twilio token only in Twilio mode', async () => {
    process.env.LIVE_PHONE_USE_MOCKS = '0'
    process.env.LIVE_PHONE_CODEX_COMMAND = '/opt/homebrew/bin/codex'
    const config = await new RuntimeService(async () => 'token', false).getConfig()
    expect(config).toMatchObject({
      mockMode: false,
      twilioToken: 'token',
      codexCommand: '/opt/homebrew/bin/codex'
    })
  })
})
