import { describe, expect, it } from 'vitest'
import type { OwnerEndpoint, OwnerEndpointKind } from '@mishu/core/handoff'
import {
  type TelephonyCapabilities,
  type TelephonyObservation,
  type TelephonyPort
} from '@mishu/core/ports'

export type TelephonyPortFactory = () => TelephonyPort | Promise<TelephonyPort>

export interface TelephonyPortContractOptions {
  capabilities?: TelephonyCapabilities
}

const TENANT = 'local'
const PEER = '+15555550100'
const ALL_OWNER_KINDS: readonly OwnerEndpointKind[] = ['client', 'pstn', 'local_takeover']

function sampleOwner(kind: OwnerEndpointKind): OwnerEndpoint {
  if (kind === 'client') return { kind: 'client', identity: 'owner' }
  if (kind === 'pstn') return { kind: 'pstn', number: '+15555550199' }
  return { kind: 'local_takeover' }
}

function undeclaredOwnerKinds(capabilities: TelephonyCapabilities | undefined): OwnerEndpointKind[] | undefined {
  if (!capabilities) return undefined
  const declared = new Set(capabilities.ownerKinds)
  return ALL_OWNER_KINDS.filter((kind) => !declared.has(kind))
}

/**
 * Behavioural TelephonyPort contract every implementation must satisfy:
 * tenantId required, commandId idempotent, ringing then connected, no events after ended.
 * Pass `capabilities` so undeclared owner kinds assert CAPABILITY_UNAVAILABLE
 * (or the case is skipped when every kind is declared).
 */
export function describeTelephonyPortContract(
  makePort: TelephonyPortFactory,
  options: TelephonyPortContractOptions = {}
): void {
  const owner = sampleOwner(options.capabilities?.ownerKinds[0] ?? 'client')
  const undeclared = undeclaredOwnerKinds(options.capabilities)

  describe('TelephonyPort contract', () => {
    it('requires tenantId on every call', async () => {
      const port = await makePort()
      expect(() => port.capabilities({ tenantId: '' })).toThrow()
      await expect(port.dial({
        tenantId: '',
        callId: 'call_1',
        commandId: 'cmd-dial',
        peer: PEER
      })).rejects.toThrow()
      await expect(port.answer({
        tenantId: '',
        callId: 'call_1',
        commandId: 'cmd-answer'
      })).rejects.toThrow()
      await expect(port.reject({
        tenantId: '',
        callId: 'call_1',
        commandId: 'cmd-reject'
      })).rejects.toThrow()
      await expect(port.hangup({
        tenantId: '',
        callId: 'call_1',
        commandId: 'cmd-hangup',
        reason: 'local_hangup'
      })).rejects.toThrow()
      await expect(port.transferToOwner({
        tenantId: '',
        callId: 'call_1',
        commandId: 'cmd-xfer',
        handoffId: 'h1',
        owner,
        timeoutSec: 20
      })).rejects.toThrow()
    })

    it('treats a repeated commandId as a no-op', async () => {
      const port = await makePort()
      const events: TelephonyObservation[] = []
      port.subscribe((observation) => events.push(observation))
      const dial = {
        tenantId: TENANT,
        callId: 'call_idem',
        commandId: 'cmd-dial-once',
        peer: PEER
      }
      await port.dial(dial)
      const afterFirst = events.length
      expect(afterFirst).toBeGreaterThan(0)
      await port.dial(dial)
      expect(events).toHaveLength(afterFirst)
    })

    it('emits ringing then connected for dial', async () => {
      const port = await makePort()
      const events: TelephonyObservation[] = []
      port.subscribe((observation) => events.push(observation))
      await port.dial({
        tenantId: TENANT,
        callId: 'call_order',
        commandId: 'cmd-dial-order',
        peer: PEER
      })
      const types = events
        .filter((event) => event.callId === 'call_order')
        .map((event) => event.type)
      const ringingAt = types.indexOf('ringing')
      const connectedAt = types.indexOf('connected')
      expect(ringingAt).toBeGreaterThanOrEqual(0)
      expect(connectedAt).toBeGreaterThan(ringingAt)
    })

    it('emits ended on hangup and drops later events for that call', async () => {
      const port = await makePort()
      const events: TelephonyObservation[] = []
      port.subscribe((observation) => events.push(observation))
      await port.dial({
        tenantId: TENANT,
        callId: 'call_end',
        commandId: 'cmd-dial-end',
        peer: PEER
      })
      await port.hangup({
        tenantId: TENANT,
        callId: 'call_end',
        commandId: 'cmd-hangup-end',
        reason: 'local_hangup'
      })
      const afterEnded = events.length
      expect(events.some((event) => event.type === 'ended' && event.callId === 'call_end')).toBe(true)
      await port.hangup({
        tenantId: TENANT,
        callId: 'call_end',
        commandId: 'cmd-hangup-again',
        reason: 'local_hangup'
      })
      expect(events).toHaveLength(afterEnded)
      const endedAt = events.findIndex((event) => event.type === 'ended' && event.callId === 'call_end')
      expect(events.slice(endedAt + 1).some((event) => event.callId === 'call_end')).toBe(false)
    })

    if (undeclared === undefined) {
      it.skip('rejects undeclared owner kinds (pass capabilities.ownerKinds to enable)')
    } else if (undeclared.length > 0) {
      it('rejects undeclared owner kinds as CAPABILITY_UNAVAILABLE', async () => {
        const port = await makePort()
        for (const kind of undeclared) {
          await expect(port.transferToOwner({
            tenantId: TENANT,
            callId: 'call_cap',
            commandId: `cmd-cap-${kind}`,
            handoffId: 'h-cap',
            owner: sampleOwner(kind),
            timeoutSec: 20
          })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
        }
      })
    }
  })
}
