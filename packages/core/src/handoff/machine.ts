import { ADR_HANDOFF_LIVE_ALIASES } from './types.js'
import type {
  CallerMoveClaim,
  HandoffCause,
  HandoffMachineRecord,
  HandoffState,
  MoveSkipReason
} from './types.js'

const TERMINAL_STATES: ReadonlySet<HandoffState> = new Set([
  'completed',
  'fallback_message',
  'cancelled'
])

const ACTIVE_PROGRESS: ReadonlySet<HandoffState> = new Set([
  'accepted',
  'connecting',
  'connected',
  'completed'
])

export function resolveLiveHandoffState(state: HandoffState): HandoffState {
  if (state === 'owner_notified') return ADR_HANDOFF_LIVE_ALIASES.owner_notified
  return state
}

export function isTerminalHandoffState(state: HandoffState): boolean {
  return TERMINAL_STATES.has(state)
}

export function isActiveHandoffProgress(state: HandoffState): boolean {
  return ACTIVE_PROGRESS.has(state)
}

export function shouldFireHandoffDeadline(state: HandoffState): boolean {
  return !isTerminalHandoffState(state) && !isActiveHandoffProgress(state)
}

export function hasBridgedHandoff(record: Pick<HandoffMachineRecord, 'state' | 'callerMovedToConference'>): boolean {
  return record.callerMovedToConference
    || record.state === 'connecting'
    || record.state === 'connected'
    || record.state === 'completed'
}

export function moveSkipReason(record: Pick<HandoffMachineRecord, 'state'>): MoveSkipReason {
  return record.state === 'connecting' ? 'already_moving' : 'already_connected'
}

/**
 * State compare-and-set. Version increments only on a winning write.
 * Does not consult Date; callers that need time pass `now` at the adapter.
 */
export function transitionHandoff<T extends HandoffMachineRecord>(
  record: T,
  from: HandoffState,
  to: HandoffState,
  cause?: HandoffCause
): boolean {
  if (record.state !== from) return false
  record.state = to
  record.version += 1
  if (cause) record.cause = cause
  return true
}

/** Compare-and-set on `(version, from)` so a stale writer cannot win. */
export function casHandoffTransition<T extends HandoffMachineRecord>(
  record: T,
  expectedVersion: number,
  from: HandoffState,
  to: HandoffState,
  cause?: HandoffCause
): boolean {
  if (record.version !== expectedVersion) return false
  return transitionHandoff(record, from, to, cause)
}

/**
 * Only the accepted → connecting winner may instruct the adapter to move the
 * caller. Repeat answered/join observations map to already_moving or
 * already_connected.
 */
export function claimCallerMove<T extends HandoffMachineRecord>(record: T): CallerMoveClaim {
  if (record.state === 'connecting') return { claimed: false, reason: 'already_moving' }
  if (record.state === 'connected' || record.state === 'completed' || record.callerMovedToConference) {
    return { claimed: false, reason: 'already_connected' }
  }
  const expectedVersion = record.version
  if (!casHandoffTransition(record, expectedVersion, 'accepted', 'connecting')) {
    return { claimed: false, reason: 'not_accepted' }
  }
  return { claimed: true, version: record.version }
}

/**
 * `accepted` is owner intent. `connected` is only legal after the adapter
 * observed owner-leg joined and the CAS winner finished the caller move.
 */
export function completeCallerMove<T extends HandoffMachineRecord>(
  record: T,
  observation: { ownerJoinedObserved: boolean }
): boolean {
  if (!observation.ownerJoinedObserved) return false
  if (record.state !== 'connecting') return false
  record.callerMovedToConference = true
  return transitionHandoff(record, 'connecting', 'connected')
}

/**
 * Fallback-message intent: keep the caller on the original leg, mark voicemail
 * fallback, and leave owner-leg cleanup to the adapter.
 */
export function applyFallbackIntent<T extends HandoffMachineRecord>(record: T): boolean {
  if (record.state === 'cancelled' || record.state === 'completed') return false
  record.state = 'fallback_message'
  record.fallbackMessage = true
  record.callerMovedToConference = false
  record.version += 1
  return true
}

export function initialHandoffMachine(): Pick<HandoffMachineRecord, 'version' | 'state' | 'callerMovedToConference'> {
  return { version: 1, state: 'requested', callerMovedToConference: false }
}
