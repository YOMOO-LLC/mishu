import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenAiSettingsService } from './openai-settings-service.js'
import { VoiceSettingsService } from './voice-settings-service.js'
import { codexProcessEnvironment } from '../codex/app-server-client.js'
const dirs: string[] = []
function directory(): string { const path = mkdtempSync(join(tmpdir(), 'openai-test-')); dirs.push(path); return path }
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })
it('stores 0600, masks, reloads, clears and prioritizes env without exporting keys', async () => {
  const userDataPath = directory()
  const key = 'fake-openai-secret-1234'
  const service = new OpenAiSettingsService({ userDataPath, env: {} })
  const outputs: unknown[] = [service.save({ apiKey: key }), service.get()]
  expect(statSync(join(userDataPath, 'openai-settings.json')).mode & 0o777).toBe(0o600)
  const reload = new OpenAiSettingsService({ userDataPath, env: {} })
  expect(reload.get().apiKey.last4).toBe('1234')
  const env = new OpenAiSettingsService({ userDataPath, env: { OPENAI_API_KEY: 'environment-fake-5678' } })
  expect(env.get().apiKey).toMatchObject({ last4: '5678', readOnly: true, source: 'env' })
  outputs.push(env.get(), reload.save({ apiKey: null }))
  expect(reload.get().apiKey.configured).toBe(false)
  expect(JSON.stringify(outputs)).not.toContain(key)
  expect(JSON.stringify(outputs)).not.toContain('environment-fake-5678')
  expect(codexProcessEnvironment({ OPENAI_API_KEY: key }, { OPENAI_API_KEY: key })).not.toHaveProperty('OPENAI_API_KEY')
})
it('tests only a read-only model endpoint and sanitizes thrown errors', async () => {
  const key = 'fake-sensitive-key-3333'
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => { throw new Error(key) })
  const service = new OpenAiSettingsService({ userDataPath: directory(), env: { OPENAI_API_KEY: key }, fetch: fetcher })
  expect(await service.test()).toEqual({ ok: false, code: 'NETWORK_ERROR' })
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models/gpt-live-1')
  expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined()
})
it('applies provider defaults, persists settings and rejects changes during calls', () => {
  const path = directory()
  let active = false
  const voice = new VoiceSettingsService(path, () => active)
  expect(voice.get().startPolicy).toBe('on_dial')
  expect(voice.save({ provider: 'gpt-live-api' }).startPolicy).toBe('on_answer')
  expect(new VoiceSettingsService(path).get()).toEqual(voice.get())
  expect(voice.save({ startPolicy: 'on_dial' }).startPolicy).toBe('on_dial')
  active = true
  expect(() => voice.save({ provider: 'codex' })).toThrow('during a call')
  expect(() => new OpenAiSettingsService({ userDataPath: path, env: {}, callInProgress: () => active }).save({ apiKey: 'fake' })).toThrow('during a call')
})
