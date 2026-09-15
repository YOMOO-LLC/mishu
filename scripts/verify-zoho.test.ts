import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runVerifyZoho } from './verify-zoho.mjs'

function sink() {
  let value = ''
  return { stream: { write(chunk: string) { value += chunk; return true } }, read: () => value }
}

describe('verify-zoho script', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('prints the setup TODO and exits 2 when credentials are absent', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'zoho-missing-'))
    directories.push(userDataPath)
    const stdout = sink()
    const stderr = sink()

    await expect(runVerifyZoho([], { userDataPath, stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(2)
    expect(stdout.read()).toContain('Zoho setup TODO')
    expect(stdout.read()).toContain('Self Client')
    expect(stderr.read()).toBe('')
  })

  it('uses injected fetch and returns the connection failure code without exposing secrets', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'zoho-failure-'))
    directories.push(userDataPath)
    const secretsPath = join(userDataPath, 'crm', 'zoho-secrets.json')
    mkdirSync(dirname(secretsPath), { recursive: true })
    writeFileSync(secretsPath, JSON.stringify({
      clientId: 'private-client', clientSecret: 'private-secret',
      refreshToken: 'private-refresh', dataCenter: 'com'
    }))
    const stdout = sink()
    const stderr = sink()
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('injected network failure for private-secret')
    }

    await expect(runVerifyZoho(['--phone', '+1 415 555 0142'], {
      userDataPath, stdout: stdout.stream, stderr: stderr.stream, fetchImpl
    })).resolves.toBe(3)
    expect(stderr.read()).toContain('FAILED (exit 3)')
    expect(stderr.read()).not.toContain('private-secret')
    expect(`${stdout.read()}${stderr.read()}`).not.toContain('+14155550142')
  })
})
