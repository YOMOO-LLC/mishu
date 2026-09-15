import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TwilioSettingsService } from './twilio-settings-service.js'

const dirs: string[] = []
const sid = (prefix: string, digit: string) => `${prefix}${digit.repeat(32)}`
const complete = {
  accountSid: sid('AC', '1'), apiKeySid: sid('SK', '2'), apiKeySecret: 'top-secret-value',
  twimlAppSid: sid('AP', '3'), phoneNumber: '+13125550198', clientIdentity: 'desktop'
}
function service(env: NodeJS.ProcessEnv = {}, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'twilio-settings-')); dirs.push(directory)
  return { directory, value: new TwilioSettingsService({ userDataPath: directory, env, ...extra }) }
}
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('TwilioSettingsService', () => {
  it('persists atomically with 0600 and never returns the secret', () => {
    const { value } = service()
    const result = value.save({ ...complete, mode: 'twilio' })
    expect(statSync(value.path).mode & 0o777).toBe(0o600)
    expect(result.apiKeySecret).toEqual({ configured: true, last4: 'alue', source: 'settings', readOnly: false })
    expect(JSON.stringify(result)).not.toContain(complete.apiKeySecret)
    expect(result.accountSid.masked).toBe('AC…1111')
  })

  it('uses environment values per field and marks them read-only', () => {
    const envSecret = 'environment-secret'
    const { value } = service({ TWILIO_ACCOUNT_SID: sid('AC', '9'), TWILIO_API_KEY_SECRET: envSecret })
    value.save(complete)
    const result = value.get()
    expect(result.accountSid).toMatchObject({ masked: 'AC…9999', source: 'env', readOnly: true })
    expect(result.apiKeySid.source).toBe('settings')
    expect(JSON.stringify(result)).not.toContain(envSecret)
  })

  it('keeps an omitted or empty secret and clears only explicit null', () => {
    const { value } = service()
    value.save(complete)
    expect(value.save({ apiKeySecret: '' }).apiKeySecret.configured).toBe(true)
    expect(value.save({ mode: 'mock' }).apiKeySecret.configured).toBe(true)
    expect(value.save({ apiKeySecret: null }).apiKeySecret.configured).toBe(false)
  })

  it('validates SID and phone formats without echoing values', () => {
    const { value } = service()
    expect(() => value.save({ accountSid: 'bad-secret-looking-value' })).toThrow('accountSid')
    expect(() => value.save({ phoneNumber: '312-555-0198' })).toThrow('phoneNumber')
  })

  it('imports only approved Twilio variables', () => {
    const { value, directory } = service()
    const path = join(directory, 'input.env')
    writeFileSync(path, `TWILIO_ACCOUNT_SID=${complete.accountSid}\nTWILIO_API_KEY_SECRET=${complete.apiKeySecret}\nOTHER_SECRET=ignore-me\n`)
    const result = value.importEnv(path)
    expect(result.imported).toEqual(['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SECRET'])
    expect(readFileSync(value.path, 'utf8')).not.toContain('ignore-me')
    expect(JSON.stringify(result)).not.toContain(complete.apiKeySecret)
  })

  it('rejects files that do not contain supported Twilio settings', () => {
    const { value, directory } = service()
    const path = join(directory, 'notes.txt')
    writeFileSync(path, 'This is not an environment file.\n')
    expect(() => value.importEnv(path)).toThrow('does not contain supported TWILIO_* settings')
  })

  it('tests token signing and read-only Twilio resources through an injected client', async () => {
    const fetcher = vi.fn(async (url: string) => new Response(
      url.includes('IncomingPhoneNumbers') ? JSON.stringify({ incoming_phone_numbers: [{}] }) : '{}',
      { status: 200 }
    ))
    const signer = vi.fn(() => 'signed-secret-token')
    const { value } = service({}, { fetch: fetcher as never, signToken: signer })
    value.save(complete)
    const result = await value.test()
    expect(result).toEqual({ ok: true, checks: [
      { check: 'token', ok: true, code: 'OK' },
      { check: 'application', ok: true, code: 'OK' },
      { check: 'phoneNumber', ok: true, code: 'OK' }
    ] })
    expect(JSON.stringify(result)).not.toContain(complete.apiKeySecret)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('requires a restart for saved mode changes and refuses relaunch during a call', () => {
    const relaunch = vi.fn()
    const { value } = service({}, { relaunch, callInProgress: () => true })
    expect(value.save({ mode: 'twilio' }).restartRequired).toBe(true)
    expect(() => value.relaunch()).toThrow('call is in progress')
    expect(relaunch).not.toHaveBeenCalled()
  })
})
