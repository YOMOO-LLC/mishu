import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppointmentsConfigStore } from './config-store.js'

describe('AppointmentsConfigStore', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('loads safe defaults and persists normalized config with mode 0600', () => {
    const directory = mkdtempSync(join(tmpdir(), 'appointments-config-'))
    directories.push(directory)
    const store = new AppointmentsConfigStore(directory)
    expect(store.load()).toEqual({
      provider: 'mock', autoConfirm: false,
      businessHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
      timeZone: 'UTC'
    })
    const saved = store.save({ autoConfirm: true, timeZone: 'America/Chicago' })
    expect(saved).toMatchObject({ autoConfirm: true, timeZone: 'America/Chicago' })
    expect(statSync(store.filePath).mode & 0o777).toBe(0o600)
  })

  it('rejects invalid time zones and inverted business hours', () => {
    const directory = mkdtempSync(join(tmpdir(), 'appointments-config-'))
    directories.push(directory)
    const store = new AppointmentsConfigStore(directory)
    expect(() => store.save({ timeZone: 'Mars/Olympus' })).toThrow('IANA')
    expect(() => store.save({ businessHours: { days: [1], start: '18:00', end: '09:00' } })).toThrow('later than')
  })
})
