import type { Appointment } from '../../shared/contracts.js'

export interface CalendarSlot {
  startAt: string
  endAt: string
}

export interface CheckSlotInput extends CalendarSlot {
  timeZone: string
}

export interface CheckSlotResult {
  available: boolean
  alternatives: CalendarSlot[]
}

export interface CalendarAdapter {
  readonly name: string
  checkSlot(input: CheckSlotInput): Promise<CheckSlotResult>
  createEvent(appointment: Appointment): Promise<{ externalRef: string }>
  cancelEvent(externalRef: string): Promise<void>
}
