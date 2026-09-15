import { describe, expect, it } from 'vitest'
import { FakeClock } from '@mishu/adapters-mock/clock'
import { describeTelephonyPortContract } from '@mishu/adapters-mock/contract-tests'
import { MockTelephony } from '@mishu/adapters-mock/telephony'
import { TelephonyError, type TelephonyObservation } from '@mishu/core/ports'

describeTelephonyPortContract(
  () => new MockTelephony({ clock: new FakeClock(0) }),
  { capabilities: { concurrentCalls: 'many', ownerKinds: ['client', 'pstn'] } }
)

describe('MockTelephony', () => {
  const tenantId = 'local'

  it('answers and rejects simulated inbound calls', async () => {
    const port = new MockTelephony()
    const events: TelephonyObservation[] = []
    port.subscribe((observation) => events.push(observation))
    const { callId } = port.simulateInbound({ tenantId, peer: '+15555550100' })
    expect(events.map((event) => event.type)).toEqual(['ringing'])
    await port.answer({ tenantId, callId, commandId: 'cmd-answer' })
    expect(events.map((event) => event.type)).toEqual(['ringing', 'connected'])

    const rejected = new MockTelephony()
    const rejectEvents: TelephonyObservation[] = []
    rejected.subscribe((observation) => rejectEvents.push(observation))
    const inbound = rejected.simulateInbound({ tenantId, peer: '+15555550101', callId: 'in-2' })
    await rejected.reject({ tenantId, callId: inbound.callId, commandId: 'cmd-reject' })
    expect(rejectEvents.at(-1)).toMatchObject({ type: 'ended', reason: 'rejected' })
  })

  it('connects dial after a clock delay', async () => {
    const clock = new FakeClock(0)
    const port = new MockTelephony({ clock, connectDelayMs: 250 })
    const events: TelephonyObservation[] = []
    port.subscribe((observation) => events.push(observation))
    await port.dial({
      tenantId,
      callId: 'out-1',
      commandId: 'cmd-dial',
      peer: '+15555550100'
    })
    expect(events.map((event) => event.type)).toEqual(['ringing'])
    clock.advance(250)
    expect(events.map((event) => event.type)).toEqual(['ringing', 'connected'])
  })

  it('reports many concurrent calls and rejects local_takeover like cloud', async () => {
    const port = new MockTelephony()
    expect(port.capabilities({ tenantId })).toEqual({
      concurrentCalls: 'many',
      ownerKinds: ['client', 'pstn']
    })
    await port.dial({
      tenantId,
      callId: 'out-2',
      commandId: 'cmd-dial',
      peer: '+15555550100'
    })
    await expect(port.transferToOwner({
      tenantId,
      callId: 'out-2',
      commandId: 'cmd-local',
      handoffId: 'h-local',
      owner: { kind: 'local_takeover' },
      timeoutSec: 20
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' } satisfies Partial<TelephonyError>)
  })

  it('joins client and pstn owners, or times out to owner_failed without hanging up', async () => {
    const joined = new MockTelephony({ ownerOutcome: 'joined' })
    const joinEvents: TelephonyObservation[] = []
    joined.subscribe((observation) => joinEvents.push(observation))
    await joined.dial({
      tenantId,
      callId: 'join-1',
      commandId: 'cmd-dial',
      peer: '+15555550100'
    })
    await joined.transferToOwner({
      tenantId,
      callId: 'join-1',
      commandId: 'cmd-xfer',
      handoffId: 'h-join',
      owner: { kind: 'client', identity: 'owner' },
      timeoutSec: 20
    })
    expect(joinEvents.map((event) => event.type)).toEqual([
      'ringing',
      'connected',
      'owner_ringing',
      'owner_joined'
    ])

    const clock = new FakeClock(0)
    const timed = new MockTelephony({ clock, ownerOutcome: 'timeout' })
    const timeoutEvents: TelephonyObservation[] = []
    timed.subscribe((observation) => timeoutEvents.push(observation))
    await timed.dial({
      tenantId,
      callId: 'to-1',
      commandId: 'cmd-dial',
      peer: '+15555550100'
    })
    await timed.transferToOwner({
      tenantId,
      callId: 'to-1',
      commandId: 'cmd-xfer',
      handoffId: 'h-to',
      owner: { kind: 'pstn', number: '+15555550199' },
      timeoutSec: 20
    })
    expect(timeoutEvents.map((event) => event.type)).toEqual(['ringing', 'connected', 'owner_ringing'])
    clock.advance(20_000)
    expect(timeoutEvents.at(-1)).toMatchObject({ type: 'owner_failed', reason: 'timed_out' })
    expect(timeoutEvents.some((event) => event.type === 'ended')).toBe(false)
  })
})
