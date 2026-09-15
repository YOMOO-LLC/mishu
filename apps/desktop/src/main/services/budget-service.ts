import type { CallBudget, CallBudgetSaveInput, CallTask, CallingHours } from '../../shared/contracts.js'
import type { CallStore } from '../call-store.js'
import { ServiceError } from './service-error.js'

export interface BudgetDecision {
  within: boolean
  reasons: string[]
  usage: { calls: number; minutes: number }
}

export class BudgetService {
  constructor(
    private readonly store: CallStore,
    private readonly now: () => number = Date.now
  ) {}

  get(): CallBudget {
    return this.store.getCallBudget()
  }

  save(input: CallBudgetSaveInput): CallBudget {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ServiceError('INVALID_ARGUMENT', 'Budget input must be an object')
    }
    const current = this.get()
    const next: CallBudget = {
      enabled: input.enabled ?? current.enabled,
      dailyMaxCalls: input.dailyMaxCalls ?? current.dailyMaxCalls,
      dailyMaxMinutes: input.dailyMaxMinutes ?? current.dailyMaxMinutes,
      allowedPrefixes: input.allowedPrefixes ?? current.allowedPrefixes,
      allowedNumbers: input.allowedNumbers ?? current.allowedNumbers,
      allowedHours: input.allowedHours ?? current.allowedHours,
      killSwitch: input.killSwitch ?? current.killSwitch
    }
    validateBudget(next)
    return this.store.saveCallBudget({
      ...next,
      allowedPrefixes: [...new Set(next.allowedPrefixes)],
      allowedNumbers: [...new Set(next.allowedNumbers)]
    })
  }

  isWithinBudget(task: Pick<CallTask, 'to'>, at = new Date(this.now())): boolean {
    return this.evaluate(task, at).within
  }

  evaluate(task: Pick<CallTask, 'to'>, at = new Date(this.now())): BudgetDecision {
    const budget = this.get()
    const usage = this.store.getDailyCallUsage(startOfUtcDay(at.getTime()))
    const reasons: string[] = []
    if (!budget.enabled) reasons.push('budget_disabled')
    if (budget.killSwitch) reasons.push('kill_switch')
    if (budget.dailyMaxCalls <= usage.calls) reasons.push('daily_call_limit')
    if (budget.dailyMaxMinutes <= usage.minutes) reasons.push('daily_minute_limit')
    const allowedNumber = budget.allowedNumbers.includes(task.to)
      || budget.allowedPrefixes.some((prefix) => task.to.startsWith(prefix))
    if (!allowedNumber) reasons.push('number_not_allowed')
    if (!isWithinHours(budget.allowedHours, at)) reasons.push('outside_allowed_hours')
    return { within: reasons.length === 0, reasons, usage }
  }
}

function validateBudget(budget: CallBudget): void {
  if (typeof budget.enabled !== 'boolean' || typeof budget.killSwitch !== 'boolean') {
    throw new ServiceError('INVALID_ARGUMENT', 'enabled and killSwitch must be booleans')
  }
  if (!Number.isInteger(budget.dailyMaxCalls) || budget.dailyMaxCalls < 0 || budget.dailyMaxCalls > 10_000) {
    throw new ServiceError('INVALID_ARGUMENT', 'dailyMaxCalls must be an integer from 0 to 10000')
  }
  if (!Number.isFinite(budget.dailyMaxMinutes) || budget.dailyMaxMinutes < 0 || budget.dailyMaxMinutes > 100_000) {
    throw new ServiceError('INVALID_ARGUMENT', 'dailyMaxMinutes must be from 0 to 100000')
  }
  if (!Array.isArray(budget.allowedPrefixes) || budget.allowedPrefixes.some((value) => typeof value !== 'string' || !/^\+[1-9]\d{0,14}$/.test(value))) {
    throw new ServiceError('INVALID_ARGUMENT', 'allowedPrefixes must contain E.164 prefixes')
  }
  if (!Array.isArray(budget.allowedNumbers) || budget.allowedNumbers.some((value) => typeof value !== 'string' || !/^\+[1-9]\d{7,14}$/.test(value))) {
    throw new ServiceError('INVALID_ARGUMENT', 'allowedNumbers must contain E.164 numbers')
  }
  validateHours(budget.allowedHours)
}

function validateHours(hours: CallingHours): void {
  if (!hours || typeof hours !== 'object' || typeof hours.timeZone !== 'string' || !Array.isArray(hours.windows)) {
    throw new ServiceError('INVALID_ARGUMENT', 'allowedHours must use the CallingHours shape')
  }
  try { void new Intl.DateTimeFormat('en-US', { timeZone: hours.timeZone }) }
  catch { throw new ServiceError('INVALID_ARGUMENT', 'allowedHours.timeZone is invalid') }
  for (const window of hours.windows) {
    if (!Array.isArray(window.days) || window.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new ServiceError('INVALID_ARGUMENT', 'allowedHours windows require days from 0 to 6')
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(window.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.end)) {
      throw new ServiceError('INVALID_ARGUMENT', 'allowedHours windows require HH:mm start and end')
    }
  }
}

function isWithinHours(hours: CallingHours, at: Date): boolean {
  if (hours.windows.length === 0) return true
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: hours.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(at)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf((values.weekday ?? '').toLowerCase())
  const minute = Number(values.hour) * 60 + Number(values.minute)
  return hours.windows.some((window) => {
    if (!window.days.includes(weekday)) return false
    const start = toMinute(window.start)
    const end = toMinute(window.end)
    if (start === end) return false
    return start < end ? minute >= start && minute < end : minute >= start || minute < end
  })
}

function toMinute(value: string): number {
  const [hour = 0, minute = 0] = value.split(':').map(Number)
  return hour * 60 + minute
}

function startOfUtcDay(at: number): number {
  const date = new Date(at)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}
