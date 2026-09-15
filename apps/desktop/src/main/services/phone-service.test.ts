import { describe, expect, it, vi } from 'vitest'
import { ApprovalService } from './approval-service.js'
import { PhoneService } from './phone-service.js'
import { ServiceError } from './service-error.js'
import { DesktopTelephonyAdapter } from '../telephony/desktop-telephony-adapter.js'
import type { PhoneCommand, PhoneCommandResult, PhoneStatusSnapshot } from '../../shared/contracts.js'

const IDLE: PhoneStatusSnapshot = {
  runtimeMode: 'mock',
  phoneConnection: 'ready',
  codexConnection: { status: 'ready' },
  controlMode: 'ai',
  updatedAt: 1
}

describe('PhoneService telephony port', () => {
  it('rejects a second dial with CALL_IN_PROGRESS through DesktopTelephonyAdapter', () => {
    const status: PhoneStatusSnapshot = {
      ...IDLE,
      call: { id: 'call-1', direction: 'outbound', peer: '+13125550198', status: 'active' }
    }
    const gateway = {
      getStatus: () => status,
      send: vi.fn(async (): Promise<PhoneCommandResult> => ({ requestId: 'r', ok: true, status }))
    }
    const phone = new PhoneService(
      new DesktopTelephonyAdapter(gateway),
      { workspace: () => ({ selectedCampaignId: 'c1', campaigns: [{ id: 'c1', name: 'Out' }] }) } as never,
      new ApprovalService({ timeoutMs: 1_000 })
    )
    expect(() => phone.startDial({
      peer: '+14155550142',
      idempotencyKey: 'two',
      actor: 'http'
    })).toThrow(ServiceError)
    try {
      phone.startDial({ peer: '+14155550142', idempotencyKey: 'two', actor: 'http' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'CALL_IN_PROGRESS' })
    }
  })

  it('dials through the adapter after a headless approval', async () => {
    const status = { ...IDLE }
    const gateway = {
      getStatus: () => status,
      send: vi.fn(async (command: PhoneCommand): Promise<PhoneCommandResult> => {
        if (command.type === 'dial') {
          status.call = { id: 'call-2', direction: 'outbound', peer: command.peer, status: 'active' }
        }
        return { requestId: 'r', ok: true, status }
      })
    }
    const approvals = new ApprovalService({ timeoutMs: 1_000 })
    const phone = new PhoneService(
      new DesktopTelephonyAdapter(gateway),
      {
        workspace: () => ({
          selectedCampaignId: 'c1',
          campaigns: [{ id: 'c1', name: 'Out' }]
        })
      } as never,
      approvals
    )
    const pending = phone.startDial({
      peer: '+13125550198',
      campaignId: 'c1',
      goal: 'Book a demo',
      idempotencyKey: 'dial-1',
      actor: 'mcp'
    })
    approvals.decide({ id: pending.approvalId, approved: true, decidedAt: Date.now() })
    await expect(pending.completion).resolves.toMatchObject({
      call: { peer: '+13125550198', status: 'active' }
    })
    expect(gateway.send).toHaveBeenCalledWith(
      { type: 'dial', peer: '+13125550198', campaignId: 'c1', goal: 'Book a demo' },
      { actor: 'mcp' }
    )
  })

  it('maps adapter failures to ServiceError codes', async () => {
    const gateway = {
      getStatus: () => IDLE,
      send: vi.fn(async (): Promise<PhoneCommandResult> => ({
        requestId: 'r', ok: false, code: 'NO_ACTIVE_CALL', message: 'No active call'
      }))
    }
    const phone = new PhoneService(
      new DesktopTelephonyAdapter(gateway),
      { workspace: () => ({ campaigns: [], selectedCampaignId: undefined }) } as never,
      new ApprovalService({ timeoutMs: 50 })
    )
    await expect(phone.hangup('http')).rejects.toBeInstanceOf(ServiceError)
    await expect(phone.hangup('http')).rejects.toMatchObject({ code: 'NO_ACTIVE_CALL' })
  })
})
