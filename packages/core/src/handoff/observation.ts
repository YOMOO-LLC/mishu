import { hasBridgedHandoff, isTerminalHandoffState } from './machine.js'
import type { CompletedLegAction, HandoffLeg, HandoffMachineRecord } from './types.js'

export function classifyHandoffLeg(
  observationRef: string,
  ids: { ownerCallRef?: string; callerCallRef?: string }
): HandoffLeg {
  if (observationRef !== '' && observationRef === ids.ownerCallRef) return 'owner'
  if (observationRef !== '' && observationRef === ids.callerCallRef) return 'caller'
  return 'unknown'
}

/**
 * Owner-leg completed is never a caller hangup. Before the bridge, it is a
 * decline; after the bridge, the owner party is gone.
 */
export function interpretCompletedLeg(
  leg: HandoffLeg,
  record: Pick<HandoffMachineRecord, 'state' | 'callerMovedToConference'>
): CompletedLegAction {
  if (leg === 'caller') return 'caller_gone'
  if (leg !== 'owner') return 'ignore'
  if (hasBridgedHandoff(record)) return 'owner_gone'
  if (
    !record.callerMovedToConference
    && record.state !== 'completed'
    && record.state !== 'cancelled'
    && record.state !== 'fallback_message'
  ) {
    return 'owner_declined'
  }
  if (isTerminalHandoffState(record.state)) return 'ignore'
  return 'ignore'
}
