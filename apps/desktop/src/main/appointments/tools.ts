import type { Appointment } from '../../shared/contracts.js'
import type { CallStore } from '../call-store.js'
import type { InCallTool, ToolExecutionContext } from '../copilot/registry.js'
import type { CalendarAdapter, CheckSlotResult } from './calendar-adapter.js'
import { normalizeTimeZone } from './config-store.js'
import type { AppointmentStore } from './store.js'

interface SlotArgs {
  startAt: string
  timeZone: string
  durationMin: number
}

interface MakeArgs extends SlotArgs {
  contactName?: string
  notes?: string
}

interface SlotToolResult extends CheckSlotResult {
  startAt: string
  endAt: string
  timeZone: string
}

type MakeResult =
  | { created: true; appointment: Appointment; idempotent: boolean }
  | { created: false; slot: SlotToolResult }

interface AppointmentToolsOptions {
  callStore: CallStore
  appointmentStore: AppointmentStore
  getCalendar(): CalendarAdapter
  now?: () => number
}

export function createAppointmentTools(options: AppointmentToolsOptions): InCallTool[] {
  const now = options.now ?? Date.now

  const checkSlot: InCallTool<SlotArgs, SlotToolResult> = {
    id: 'calendar_check_slot',
    version: 1,
    spec: {
      type: 'function',
      name: 'calendar_check_slot',
      description: 'Check whether an appointment slot is available; if not, return the next two alternatives.',
      inputSchema: slotSchema()
    },
    risk: 'read',
    timeoutMs: 5_000,
    validate: validateSlot,
    async execute(_ctx, args) {
      const endAt = endAtFor(args)
      const result = await options.getCalendar().checkSlot({ startAt: args.startAt, endAt, timeZone: args.timeZone })
      return { ...result, startAt: args.startAt, endAt, timeZone: args.timeZone }
    },
    toModelText(result) {
      return slotText(result)
    }
  }

  const make: InCallTool<MakeArgs, MakeResult> = {
    id: 'appointments_make',
    version: 1,
    spec: {
      type: 'function',
      name: 'appointments_make',
      description: 'Record an appointment intent for the current caller; number and Campaign are read from the current call and must not be supplied by the model.',
      inputSchema: {
        ...slotSchema(),
        properties: {
          ...(slotSchema().properties as Record<string, unknown>),
          contact_name: { type: 'string', maxLength: 200 },
          notes: { type: 'string', maxLength: 4000 }
        }
      }
    },
    risk: 'draft-write',
    timeoutMs: 5_000,
    validate(value) {
      const base = validateSlot(value)
      const object = objectValue(value)
      return {
        ...base,
        ...(optionalString(object.contact_name, 'contact_name', 200) ? { contactName: optionalString(object.contact_name, 'contact_name', 200) } : {}),
        ...(optionalString(object.notes, 'notes', 4_000) ? { notes: optionalString(object.notes, 'notes', 4_000) } : {})
      }
    },
    async execute(ctx, args) {
      const call = currentCall(options.callStore, ctx)
      const existing = options.appointmentStore.findActiveByPeerAndStart(call.peer, args.startAt)
      if (existing) return { created: true, appointment: existing, idempotent: true }
      if (Date.parse(args.startAt) < now()) throw new Error('Appointment start time cannot be in the past')
      const endAt = endAtFor(args)
      const checked = await options.getCalendar().checkSlot({
        startAt: args.startAt,
        endAt,
        timeZone: args.timeZone
      })
      if (!checked.available) {
        return {
          created: false,
          slot: { ...checked, startAt: args.startAt, endAt, timeZone: args.timeZone }
        }
      }
      const appointment = options.appointmentStore.create({
        callId: call.id,
        campaignId: call.campaignId as string,
        peer: call.peer,
        startAt: args.startAt,
        endAt,
        timeZone: args.timeZone,
        source: 'copilot',
        ...(args.contactName ? { contactName: args.contactName } : {}),
        ...(args.notes ? { notes: args.notes } : {})
      })
      return { created: true, appointment, idempotent: false }
    },
    toModelText(result) {
      if (!result.created) return slotText(result.slot)
      return `Noted an appointment for ${formatSlot(result.appointment.startAt, result.appointment.timeZone)}; a confirmation will be sent later.`
    }
  }

  const list: InCallTool<Record<string, never>, Appointment[]> = {
    id: 'appointments_list',
    version: 1,
    spec: {
      type: 'function',
      name: 'appointments_list',
      description: 'List upcoming appointments for the current caller.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    risk: 'read',
    timeoutMs: 2_000,
    validate(value) {
      objectValue(value ?? {})
      return {}
    },
    async execute(ctx) {
      const call = currentCall(options.callStore, ctx)
      return options.appointmentStore.listByPeer(call.peer)
        .filter((appointment) => Date.parse(appointment.endAt) >= now() && appointment.status !== 'cancelled')
        .slice(0, 10)
    },
    toModelText(appointments) {
      if (appointments.length === 0) return 'The current caller has no upcoming appointments.'
      return appointments.slice(0, 5).map((appointment) => (
        `${formatSlot(appointment.startAt, appointment.timeZone)} (${statusLabel(appointment.status)})`
      )).join('; ').slice(0, 1_000)
    }
  }

  return [checkSlot, make, list]
}

function currentCall(callStore: CallStore, ctx: ToolExecutionContext) {
  const call = callStore.getCall(ctx.callSessionId)
  if (!call) throw new Error('Current call does not exist')
  if (!call.campaignId) throw new Error('Current call has no Campaign')
  return call
}

function validateSlot(value: unknown): SlotArgs {
  const object = objectValue(value)
  const startAt = requiredIso(object.start_at)
  const timeZone = normalizeTimeZone(object.time_zone)
  const durationMin = object.duration_min === undefined ? 30 : object.duration_min
  if (!Number.isSafeInteger(durationMin) || Number(durationMin) < 5 || Number(durationMin) > 480) {
    throw new Error('duration_min must be an integer between 5 and 480')
  }
  return { startAt, timeZone, durationMin: Number(durationMin) }
}

function endAtFor(args: SlotArgs): string {
  return new Date(Date.parse(args.startAt) + args.durationMin * 60_000).toISOString()
}

function slotSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      start_at: { type: 'string', description: 'ISO 8601 start time with a timezone offset' },
      time_zone: { type: 'string', description: 'IANA time zone, for example America/Chicago' },
      duration_min: { type: 'integer', minimum: 5, maximum: 480, default: 30 }
    },
    required: ['start_at', 'time_zone'],
    additionalProperties: false
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Appointment tool arguments are invalid')
  return value as Record<string, unknown>
}

function requiredIso(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error('start_at must be an ISO 8601 datetime')
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())) throw new Error('start_at must include a timezone offset')
  return new Date(value).toISOString()
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} is invalid`)
  return value.trim()
}

function slotText(result: SlotToolResult): string {
  const requested = formatSlot(result.startAt, result.timeZone)
  if (result.available) return `${requested} is available.`
  if (result.alternatives.length === 0) return `${requested} is full, with no nearby alternatives.`
  return `${requested} is full; alternatives: ${result.alternatives.slice(0, 2)
    .map((slot) => formatSlot(slot.startAt, result.timeZone))
    .join(' or ')}.`
}

function formatSlot(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(iso)).replace(/\s/g, '')
}

function statusLabel(status: Appointment['status']): string {
  return ({ tentative: 'Tentative', confirmed: 'Confirmed', cancelled: 'Cancelled', failed: 'Confirm failed' })[status]
}
