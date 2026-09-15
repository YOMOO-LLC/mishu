import type { AppointmentsConfig, AppointmentsSaveInput } from '../../shared/contracts.js'
import type { CalendarAdapter } from '../appointments/calendar-adapter.js'
import { AppointmentsConfigStore } from '../appointments/config-store.js'
import { MockCalendarAdapter } from '../appointments/mock-calendar.js'

export class AppointmentService {
  private calendarValue: CalendarAdapter

  constructor(private readonly store: AppointmentsConfigStore) {
    this.calendarValue = this.createCalendar()
  }

  get(): AppointmentsConfig { return this.store.load() }

  save(input: AppointmentsSaveInput): AppointmentsConfig {
    const saved = this.store.save(input)
    this.calendarValue = this.createCalendar()
    return saved
  }

  calendar(): CalendarAdapter { return this.calendarValue }

  private createCalendar(): CalendarAdapter {
    if (this.store.load().provider === 'zoho') return new UnavailableZohoCalendarAdapter()
    return new MockCalendarAdapter(() => this.store.load())
  }
}

class UnavailableZohoCalendarAdapter implements CalendarAdapter {
  readonly name = 'zoho'
  private unavailable(): never { throw new Error('Zoho Calendar adapter is not configured yet') }
  async checkSlot(): Promise<never> { return this.unavailable() }
  async createEvent(): Promise<never> { return this.unavailable() }
  async cancelEvent(): Promise<never> { return this.unavailable() }
}
