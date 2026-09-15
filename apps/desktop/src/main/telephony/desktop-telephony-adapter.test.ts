import { describe, expect, it, vi } from 'vitest'
import { TelephonyError, type TelephonyObservation, type TelephonyPort } from '@mishu/core/ports'
import type { PhoneCommand, PhoneCommandResult, PhoneStatusSnapshot } from '../../shared/contracts.js'
import { PhoneService, statusHasActiveCall } from '../services/phone-service.js'
import { DesktopTelephonyAdapter, type DesktopTelephonyGateway } from './desktop-telephony-adapter.js'

const IDLE: PhoneStatusSnapshot = {
  runtimeMode: 'mock',
  phoneConnection: 'ready',
  codexConnection: { status: 'ready' },
  controlMode: 'ai',
  updatedAt: 1
}

function snapshot(overrides: Partial<PhoneStatusSnapshot> = {}): PhoneStatusSnapshot {
  return { ...IDLE, ...overrides }
}

function mockGateway(initial = IDLE): DesktopTelephonyGateway & {
  status: PhoneStatusSnapshot
  send: ReturnType<typeof vi.fn>
} {
  const gateway = {
    status: initial,
    getStatus: () => gateway.status,
    send: vi.fn(async (command: PhoneCommand): Promise<PhoneCommandResult> => {
      if (command.type === 'dial') {
        gateway.status = snapshot({
          call: { id: 'call-1', direction: 'outbound', peer: command.peer, status: 'active' }
        })
      } else if (command.type === 'answer' && gateway.status.call) {
        gateway.status = snapshot({
          call: { ...gateway.status.call, status: 'active' }
        })
      } else if (command.type === 'reject' && gateway.status.call) {
        gateway.status = snapshot({
          call: { ...gateway.status.call, status: 'ended' }
        })
      } else if (command.type === 'hangup' && gateway.status.call) {
        gateway.status = snapshot({
          call: { ...gateway.status.call, status: 'ended' }
        })
      } else if (command.type === 'setControlMode') {
        gateway.status = snapshot({
          ...gateway.status,
          controlMode: command.mode
        })
      }
      return { requestId: 'r1', ok: true, status: gateway.status }
    })
  }
  return gateway
}

function collect(port: TelephonyPort): TelephonyObservation[] {
  const events: TelephonyObservation[] = []
  port.subscribe((observation) => events.push(observation))
  return events
}

describe('DesktopTelephonyAdapter', () => {
  it('satisfies TelephonyPort at the type level', () => {
    const adapter: TelephonyPort = new DesktopTelephonyAdapter(mockGateway())
    expect(adapter.capabilities({ tenantId: 'local' })).toEqual({
      concurrentCalls: 'single',
      ownerKinds: ['local_takeover']
    })
  })

  it('dials through the mock gateway and emits ringing then connected', async () => {
    const gateway = mockGateway()
    const adapter = new DesktopTelephonyAdapter(gateway)
    const events = collect(adapter)
    await adapter.dial({
      tenantId: 'local',
      callId: 'call-1',
      commandId: 'cmd-dial',
      peer: '+13125550198'
    })
    expect(gateway.send).toHaveBeenCalledWith(
      { type: 'dial', peer: '+13125550198' },
      { actor: 'http' }
    )
    expect(events.map((event) => event.type)).toEqual(['ringing', 'connected'])
  })

  it('replays the same commandId without sending again', async () => {
    const gateway = mockGateway()
    const adapter = new DesktopTelephonyAdapter(gateway)
    const input = { tenantId: 'local', callId: 'call-1', commandId: 'same', peer: '+13125550198' }
    await adapter.dial(input)
    await adapter.dial(input)
    expect(gateway.send).toHaveBeenCalledTimes(1)
  })

  it('reports CALL_IN_PROGRESS when the desktop already has a live call', async () => {
    const gateway = mockGateway(snapshot({
      call: { id: 'other', direction: 'outbound', peer: '+13125550100', status: 'active' }
    }))
    const adapter = new DesktopTelephonyAdapter(gateway)
    await expect(adapter.dial({
      tenantId: 'local',
      callId: 'call-2',
      commandId: 'cmd-2',
      peer: '+13125550198'
    })).rejects.toMatchObject({ code: 'CALL_IN_PROGRESS' })
    expect(gateway.send).not.toHaveBeenCalled()
  })

  it('maps local_takeover to setControlMode human and owner_joined', async () => {
    const gateway = mockGateway(snapshot({
      call: { id: 'call-1', direction: 'outbound', peer: '+13125550198', status: 'active' }
    }))
    const adapter = new DesktopTelephonyAdapter(gateway)
    const events = collect(adapter)
    await adapter.transferToOwner({
      tenantId: 'local',
      callId: 'call-1',
      commandId: 'cmd-handoff',
      handoffId: 'h1',
      owner: { kind: 'local_takeover' },
      timeoutSec: 20
    })
    expect(gateway.send).toHaveBeenCalledWith(
      { type: 'setControlMode', mode: 'human' },
      { actor: 'http' }
    )
    expect(events.map((event) => event.type)).toEqual(['owner_ringing', 'owner_joined'])
    expect(events[1]).toMatchObject({ handoffId: 'h1', callId: 'call-1' })
  })

  it('rejects pstn and client owner kinds as capability-unavailable', async () => {
    const adapter = new DesktopTelephonyAdapter(mockGateway())
    await expect(adapter.transferToOwner({
      tenantId: 'local',
      callId: 'call-1',
      commandId: 'cmd-pstn',
      handoffId: 'h2',
      owner: { kind: 'pstn', number: '+15551238888' },
      timeoutSec: 20
    })).rejects.toBeInstanceOf(TelephonyError)
    await expect(adapter.transferToOwner({
      tenantId: 'local',
      callId: 'call-1',
      commandId: 'cmd-pstn',
      handoffId: 'h2',
      owner: { kind: 'pstn', number: '+15551238888' },
      timeoutSec: 20
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })

  it('answers, hangs up, and emits ended', async () => {
    const gateway = mockGateway(snapshot({
      call: { id: 'call-1', direction: 'inbound', peer: '+13125550198', status: 'ringing' }
    }))
    const adapter = new DesktopTelephonyAdapter(gateway)
    const events = collect(adapter)
    await adapter.answer({ tenantId: 'local', callId: 'call-1', commandId: 'cmd-answer' })
    await adapter.hangup({ tenantId: 'local', callId: 'call-1', commandId: 'cmd-hangup', reason: 'local_hangup' })
    expect(gateway.send).toHaveBeenNthCalledWith(1, { type: 'answer' }, { actor: 'http' })
    expect(gateway.send).toHaveBeenNthCalledWith(2, { type: 'hangup' }, { actor: 'http' })
    expect(events.map((event) => event.type)).toEqual(['connected', 'ended'])
    expect(events[1]).toMatchObject({ reason: 'local_hangup' })
  })

  it('uses PhoneService against a mock gateway for hangup after a live status', async () => {
    const gateway = mockGateway(snapshot({
      call: { id: 'call-1', direction: 'outbound', peer: '+13125550198', status: 'active' }
    }))
    const phone = new PhoneService(
      gateway as never,
      { workspace: () => ({ campaigns: [], selectedCampaignId: undefined }) } as never,
      { create: vi.fn() } as never
    )
    expect(statusHasActiveCall(phone.status())).toBe(true)
    const adapter = new DesktopTelephonyAdapter(gateway)
    await adapter.hangup({ tenantId: 'local', callId: 'call-1', commandId: 'cmd-h', reason: 'hangup' })
    await expect(phone.hangup('http')).resolves.toMatchObject({
      call: expect.objectContaining({ status: 'ended' })
    })
  })

  it('preserves the caller actor when PhoneService executes through the adapter', async () => {
    const gateway = mockGateway(snapshot({
      call: { id: 'call-1', direction: 'outbound', peer: '+13125550198', status: 'active' }
    }))
    const adapter = new DesktopTelephonyAdapter(gateway)
    const phone = new PhoneService(
      adapter,
      { workspace: () => ({ campaigns: [], selectedCampaignId: undefined }) } as never,
      { create: vi.fn() } as never
    )
    await phone.hangup('copilot')
    expect(gateway.send).toHaveBeenCalledWith({ type: 'hangup' }, { actor: 'copilot' })
    expect(adapter.getStatus().call?.status).toBe('ended')
  })

  it('emits the port callId when the gateway uses a different id', async () => {
    const gateway = mockGateway()
    const adapter = new DesktopTelephonyAdapter(gateway)
    const events = collect(adapter)
    await adapter.dial({
      tenantId: 'local',
      callId: 'port-call',
      commandId: 'cmd-dial',
      peer: '+13125550198'
    })
    expect(events.every((event) => event.callId === 'port-call')).toBe(true)
    expect(events.map((event) => event.type)).toEqual(['ringing', 'connected'])
  })

  it('treats hangup after ended as a no-op', async () => {
    const gateway = mockGateway()
    const adapter = new DesktopTelephonyAdapter(gateway)
    const events = collect(adapter)
    await adapter.dial({
      tenantId: 'local',
      callId: 'call-1',
      commandId: 'cmd-dial',
      peer: '+13125550198'
    })
    await adapter.hangup({
      tenantId: 'local',
      callId: 'call-1',
      commandId: 'cmd-hangup',
      reason: 'local_hangup'
    })
    const afterEnded = events.length
    await adapter.hangup({
      tenantId: 'local',
      callId: 'call-1',
      commandId: 'cmd-hangup-again',
      reason: 'local_hangup'
    })
    expect(events).toHaveLength(afterEnded)
    expect(() => adapter.capabilities({ tenantId: '' })).toThrow()
  })
})
