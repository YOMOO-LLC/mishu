import { describe, expect, it } from 'vitest'
import {
  canApplyOwnerJoined,
  ownerAcceptsOnAnswered,
  ownerAcceptsOnJoined,
  ownerEndpointTo,
  ownerRequiresGatherConfirm,
  parseOwnerEndpoint
} from '@mishu/core/handoff'

describe('OwnerEndpoint', () => {
  it('parses client, pstn, and local_takeover without changing invalid input', () => {
    expect(parseOwnerEndpoint('client:mishu')).toEqual({
      kind: 'client',
      identity: 'mishu'
    })
    expect(parseOwnerEndpoint('+15551238888')).toEqual({ kind: 'pstn', number: '+15551238888' })
    expect(parseOwnerEndpoint('local_takeover')).toEqual({ kind: 'local_takeover' })
    expect(parseOwnerEndpoint('client:')).toBeUndefined()
    expect(parseOwnerEndpoint('15551238888')).toBeUndefined()
    expect(parseOwnerEndpoint('sip:desk')).toBeUndefined()
  })

  it('round-trips endpoint encodings', () => {
    expect(ownerEndpointTo({ kind: 'client', identity: 'desk-1' })).toBe('client:desk-1')
    expect(ownerEndpointTo({ kind: 'pstn', number: '+15551230000' })).toBe('+15551230000')
    expect(ownerEndpointTo({ kind: 'local_takeover' })).toBe('local_takeover')
  })

  it('requires PSTN Gather confirm and treats client answered as accept', () => {
    expect(ownerRequiresGatherConfirm('pstn')).toBe(true)
    expect(ownerAcceptsOnAnswered('pstn')).toBe(false)
    expect(ownerAcceptsOnJoined('pstn')).toBe(false)
    expect(canApplyOwnerJoined('pstn', 'owner_ringing')).toBe(false)
    expect(canApplyOwnerJoined('pstn', 'accepted')).toBe(true)

    expect(ownerRequiresGatherConfirm('client')).toBe(false)
    expect(ownerAcceptsOnAnswered('client')).toBe(true)
    expect(ownerAcceptsOnJoined('client')).toBe(true)
    expect(canApplyOwnerJoined('client', 'owner_ringing')).toBe(true)

    expect(ownerAcceptsOnAnswered('local_takeover')).toBe(true)
    expect(ownerRequiresGatherConfirm('local_takeover')).toBe(false)
  })
})
