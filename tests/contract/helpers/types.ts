export interface EngineConnection {
  baseUrl: string
  token: string
}

export interface HttpResult<T = unknown> {
  status: number
  body: T
  raw: string
  headers: Headers
}

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export const TASK_STATUSES = [
  'queued',
  'awaiting_approval',
  'dialing',
  'in_call',
  'analyzing',
  'completed',
  'failed',
  'cancelled'
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'cancelled'])

/** Portable task state machine (ADR-0001 I9). `queued` from later states is a retry, not a leak. */
export const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(['awaiting_approval', 'dialing', 'failed', 'cancelled']),
  awaiting_approval: new Set(['dialing', 'failed', 'cancelled']),
  dialing: new Set(['in_call', 'queued', 'failed', 'cancelled']),
  in_call: new Set(['analyzing', 'queued', 'completed', 'failed', 'cancelled']),
  analyzing: new Set(['queued', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
}
