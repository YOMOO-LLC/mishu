import { describe, expect, it } from 'vitest'
import {
  applyFallbackIntent,
  casHandoffTransition,
  claimCallerMove,
  completeCallerMove,
  hasBridgedHandoff,
  initialHandoffMachine,
  isActiveHandoffProgress,
  isTerminalHandoffState,
  moveSkipReason,
  resolveLiveHandoffState,
  shouldFireHandoffDeadline,
  transitionHandoff,
  type HandoffMachineRecord
} from '@mishu/core/handoff'

function record(overrides: Partial<HandoffMachineRecord> = {}): HandoffMachineRecord {
  return {
    tenantId: 'local',
    handoffId: 'h1',
    ...initialHandoffMachine(),
    ...overrides
  }
}

describe('handoff machine', () => {
  it('compare-and-sets on from-state and increments version', () => {
    const handoff = record()
    expect(transitionHandoff(handoff, 'requested', 'owner_ringing')).toBe(true)
    expect(handoff).toMatchObject({ state: 'owner_ringing', version: 2 })
    expect(transitionHandoff(handoff, 'requested', 'accepted')).toBe(false)
    expect(handoff.state).toBe('owner_ringing')
    expect(handoff.version).toBe(2)
  })

  it('rejects a stale version even when from-state still matches', () => {
    const handoff = record({ state: 'accepted', version: 4 })
    expect(casHandoffTransition(handoff, 3, 'accepted', 'connecting')).toBe(false)
    expect(handoff).toMatchObject({ state: 'accepted', version: 4 })
    expect(casHandoffTransition(handoff, 4, 'accepted', 'connecting')).toBe(true)
    expect(handoff).toMatchObject({ state: 'connecting', version: 5 })
  })

  it('lets only one accepted → connecting writer win', () => {
    const handoff = record({ state: 'accepted', version: 3 })
    const first = claimCallerMove(handoff)
    const second = claimCallerMove(handoff)
    expect(first).toEqual({ claimed: true, version: 4 })
    expect(second).toEqual({ claimed: false, reason: 'already_moving' })
    expect(handoff.state).toBe('connecting')
    expect(moveSkipReason(handoff)).toBe('already_moving')
  })

  it('records already_connected for a second answered or join after the caller moved', () => {
    const handoff = record({ state: 'accepted', version: 2 })
    expect(claimCallerMove(handoff).claimed).toBe(true)
    expect(completeCallerMove(handoff, { ownerJoinedObserved: true })).toBe(true)
    const duplicate = claimCallerMove(handoff)
    expect(duplicate).toEqual({ claimed: false, reason: 'already_connected' })
    expect(moveSkipReason(handoff)).toBe('already_connected')
    expect(handoff.state).toBe('connected')
  })

  it('does not treat accepted as connected without an owner-leg joined observation', () => {
    const handoff = record({ state: 'accepted', version: 2 })
    expect(handoff.state).not.toBe('connected')
    expect(completeCallerMove(handoff, { ownerJoinedObserved: true })).toBe(false)
    expect(claimCallerMove(handoff).claimed).toBe(true)
    expect(completeCallerMove(handoff, { ownerJoinedObserved: false })).toBe(false)
    expect(handoff).toMatchObject({ state: 'connecting', callerMovedToConference: false })
    expect(completeCallerMove(handoff, { ownerJoinedObserved: true })).toBe(true)
    expect(handoff).toMatchObject({ state: 'connected', callerMovedToConference: true, version: 4 })
  })

  it('ignores a caller-move claim before accept', () => {
    const handoff = record({ state: 'owner_ringing', version: 2 })
    expect(claimCallerMove(handoff)).toEqual({ claimed: false, reason: 'not_accepted' })
    expect(handoff.state).toBe('owner_ringing')
  })

  it('falls back to voicemail while keeping the caller on the original leg', () => {
    const declined = record({ state: 'owner_ringing', version: 2, cause: 'declined' })
    expect(applyFallbackIntent(declined)).toBe(true)
    expect(declined).toMatchObject({
      state: 'fallback_message',
      fallbackMessage: true,
      callerMovedToConference: false,
      version: 3
    })

    const timedOut = record({ state: 'requested', version: 1 })
    expect(shouldFireHandoffDeadline(timedOut.state)).toBe(true)
    expect(transitionHandoff(timedOut, 'requested', 'timed_out', 'timed_out')).toBe(true)
    expect(applyFallbackIntent(timedOut)).toBe(true)
    expect(timedOut.callerMovedToConference).toBe(false)
    expect(timedOut.state).toBe('fallback_message')

    const failed = record({ state: 'connecting', version: 5, callerMovedToConference: false })
    expect(transitionHandoff(failed, 'connecting', 'failed', 'failed')).toBe(true)
    expect(applyFallbackIntent(failed)).toBe(true)
    expect(failed.callerMovedToConference).toBe(false)
  })

  it('does not overwrite cancelled or completed with fallback', () => {
    const cancelled = record({ state: 'cancelled', version: 3, cause: 'cancelled' })
    expect(applyFallbackIntent(cancelled)).toBe(false)
    expect(cancelled.state).toBe('cancelled')
    const completed = record({ state: 'completed', version: 8, cause: 'completed', callerMovedToConference: true })
    expect(applyFallbackIntent(completed)).toBe(false)
    expect(completed).toMatchObject({ state: 'completed', callerMovedToConference: true })
  })

  it('classifies terminal, progress, bridge, and deadline predicates', () => {
    expect(isTerminalHandoffState('completed')).toBe(true)
    expect(isTerminalHandoffState('fallback_message')).toBe(true)
    expect(isTerminalHandoffState('cancelled')).toBe(true)
    expect(isTerminalHandoffState('accepted')).toBe(false)
    expect(isActiveHandoffProgress('accepted')).toBe(true)
    expect(isActiveHandoffProgress('connecting')).toBe(true)
    expect(shouldFireHandoffDeadline('accepted')).toBe(false)
    expect(shouldFireHandoffDeadline('owner_ringing')).toBe(true)
    expect(hasBridgedHandoff(record({ state: 'connecting' }))).toBe(true)
    expect(hasBridgedHandoff(record({ state: 'owner_ringing' }))).toBe(false)
  })

  it('maps ADR owner_notified onto live requested without emitting a new live state', () => {
    expect(resolveLiveHandoffState('owner_notified')).toBe('requested')
    expect(resolveLiveHandoffState('requested')).toBe('requested')
    expect(initialHandoffMachine().state).toBe('requested')
  })
})
