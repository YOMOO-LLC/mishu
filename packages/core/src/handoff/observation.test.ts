import { describe, expect, it } from 'vitest'
import { classifyHandoffLeg, interpretCompletedLeg } from '@mishu/core/handoff'

const OWNER = 'CA-owner'
const CALLER = 'CA-caller'
const IDS = { ownerCallRef: OWNER, callerCallRef: CALLER }

describe('handoff observations', () => {
  it('classifies owner vs caller vs unknown without vendor event names', () => {
    expect(classifyHandoffLeg(OWNER, IDS)).toBe('owner')
    expect(classifyHandoffLeg(CALLER, IDS)).toBe('caller')
    expect(classifyHandoffLeg('CA-other', IDS)).toBe('unknown')
    expect(classifyHandoffLeg('', IDS)).toBe('unknown')
  })

  it('never treats owner-leg completed as a caller hangup', () => {
    const ringing = { state: 'owner_ringing' as const, callerMovedToConference: false }
    expect(interpretCompletedLeg('owner', ringing)).toBe('owner_declined')
    expect(interpretCompletedLeg('owner', ringing)).not.toBe('caller_gone')

    const connected = { state: 'connected' as const, callerMovedToConference: true }
    expect(interpretCompletedLeg('owner', connected)).toBe('owner_gone')
    expect(interpretCompletedLeg('owner', connected)).not.toBe('caller_gone')

    const connecting = { state: 'connecting' as const, callerMovedToConference: false }
    expect(interpretCompletedLeg('owner', connecting)).toBe('owner_gone')

    expect(interpretCompletedLeg('caller', ringing)).toBe('caller_gone')
    expect(interpretCompletedLeg('unknown', ringing)).toBe('ignore')
    expect(interpretCompletedLeg('owner', { state: 'cancelled', callerMovedToConference: false })).toBe('ignore')
    expect(interpretCompletedLeg('owner', { state: 'fallback_message', callerMovedToConference: false })).toBe('ignore')
  })
})
