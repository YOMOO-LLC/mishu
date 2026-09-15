import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AppointmentBusinessHours,
  AppointmentsConfig,
  AppointmentsSaveInput
} from '../../shared/contracts.js'

const FILE_MODE = 0o600
const DEFAULT_CONFIG: AppointmentsConfig = {
  provider: 'mock',
  autoConfirm: false,
  businessHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  timeZone: 'UTC'
}

export class AppointmentsConfigStore {
  readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'appointments', 'config.json')
  }

  load(): AppointmentsConfig {
    try {
      return normalizeConfig(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cloneDefault()
      throw error
    }
  }

  save(input: AppointmentsSaveInput): AppointmentsConfig {
    const normalized = normalizeConfig({ ...this.load(), ...input })
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: FILE_MODE })
    chmodSync(this.filePath, FILE_MODE)
    return normalized
  }
}

function cloneDefault(): AppointmentsConfig {
  return { ...DEFAULT_CONFIG, businessHours: { ...DEFAULT_CONFIG.businessHours, days: [...DEFAULT_CONFIG.businessHours.days] } }
}

function normalizeConfig(input: unknown): AppointmentsConfig {
  if (!input || typeof input !== 'object') throw new Error('Appointment config is invalid')
  const value = input as Record<string, unknown>
  const provider = value.provider === 'zoho' ? 'zoho' : 'mock'
  const timeZone = normalizeTimeZone(value.timeZone)
  return {
    provider,
    autoConfirm: value.autoConfirm === true,
    businessHours: normalizeBusinessHours(value.businessHours),
    timeZone
  }
}

function normalizeBusinessHours(input: unknown): AppointmentBusinessHours {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const days = Array.isArray(value.days)
    ? [...new Set(value.days.filter((day): day is number => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6))].sort()
    : [...DEFAULT_CONFIG.businessHours.days]
  if (days.length === 0) throw new Error('Business days cannot be empty')
  const start = normalizeClock(value.start, DEFAULT_CONFIG.businessHours.start)
  const end = normalizeClock(value.end, DEFAULT_CONFIG.businessHours.end)
  if (clockMinutes(start) >= clockMinutes(end)) throw new Error('Business end time must be later than start time')
  return { days, start, end }
}

function normalizeClock(input: unknown, fallback: string): string {
  if (input === undefined) return fallback
  if (typeof input !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input)) {
    throw new Error('Business hours must use HH:mm format')
  }
  return input
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

export function normalizeTimeZone(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 100) throw new Error('Time zone is invalid')
  const value = input.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
  } catch {
    throw new Error('Time zone must be a valid IANA time zone')
  }
  return value
}
