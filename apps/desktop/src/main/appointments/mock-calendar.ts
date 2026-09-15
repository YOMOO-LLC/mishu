import { randomUUID } from 'node:crypto'
import type { Appointment, AppointmentBusinessHours } from '../../shared/contracts.js'
import type { CalendarAdapter, CalendarSlot, CheckSlotInput, CheckSlotResult } from './calendar-adapter.js'
import { normalizeTimeZone } from './config-store.js'

export interface MockCalendarConfig {
  businessHours: AppointmentBusinessHours
  timeZone: string
}

interface OccupiedSlot extends CalendarSlot {
  externalRef: string
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
}

export class MockCalendarAdapter implements CalendarAdapter {
  readonly name = 'mock'
  private readonly occupied = new Map<string, OccupiedSlot>()

  constructor(private readonly getConfig: () => MockCalendarConfig = () => ({
    businessHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
    timeZone: 'UTC'
  })) {}

  async checkSlot(input: CheckSlotInput): Promise<CheckSlotResult> {
    const slot = normalizeSlot(input)
    if (this.isAvailable(slot)) return { available: true, alternatives: [] }
    return { available: false, alternatives: this.findAlternatives(slot) }
  }

  async createEvent(appointment: Appointment): Promise<{ externalRef: string }> {
    const slot = normalizeSlot({
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      timeZone: appointment.timeZone
    })
    if (!this.isAvailable(slot)) throw new Error('That appointment time is already taken')
    const externalRef = `mock-calendar-${randomUUID()}`
    this.occupied.set(externalRef, { externalRef, startAt: slot.startAt, endAt: slot.endAt })
    return { externalRef }
  }

  async cancelEvent(externalRef: string): Promise<void> {
    this.occupied.delete(externalRef)
  }

  private isAvailable(slot: CalendarSlot): boolean {
    if (!this.withinBusinessHours(slot)) return false
    const start = Date.parse(slot.startAt)
    const end = Date.parse(slot.endAt)
    return [...this.occupied.values()].every((occupied) => (
      end <= Date.parse(occupied.startAt) || start >= Date.parse(occupied.endAt)
    ))
  }

  private withinBusinessHours(slot: CalendarSlot): boolean {
    const config = this.getConfig()
    const timeZone = normalizeTimeZone(config.timeZone)
    const start = zonedParts(slot.startAt, timeZone)
    const end = zonedParts(slot.endAt, timeZone)
    if (start.date !== end.date || !config.businessHours.days.includes(start.weekday)) return false
    return start.minutes >= clockMinutes(config.businessHours.start) &&
      end.minutes <= clockMinutes(config.businessHours.end) &&
      end.minutes > start.minutes
  }

  private findAlternatives(requested: CalendarSlot): CalendarSlot[] {
    const duration = Date.parse(requested.endAt) - Date.parse(requested.startAt)
    const alternatives: CalendarSlot[] = []
    let cursor = ceilToHalfHour(Date.parse(requested.startAt) + 1)
    const deadline = cursor + 14 * 24 * 60 * 60 * 1_000
    while (cursor <= deadline && alternatives.length < 2) {
      const candidate = {
        startAt: new Date(cursor).toISOString(),
        endAt: new Date(cursor + duration).toISOString()
      }
      if (this.isAvailable(candidate)) alternatives.push(candidate)
      cursor += 30 * 60 * 1_000
    }
    return alternatives
  }
}

function normalizeSlot(input: CheckSlotInput): CheckSlotInput {
  normalizeTimeZone(input.timeZone)
  const start = Date.parse(input.startAt)
  const end = Date.parse(input.endAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Calendar time range is invalid')
  return {
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    timeZone: input.timeZone
  }
}

function zonedParts(iso: string, timeZone: string): { date: string; weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(iso))
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? ''
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAYS[get('weekday')] ?? -1,
    minutes: hour * 60 + minute
  }
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function ceilToHalfHour(timestamp: number): number {
  const step = 30 * 60 * 1_000
  return Math.ceil(timestamp / step) * step
}
