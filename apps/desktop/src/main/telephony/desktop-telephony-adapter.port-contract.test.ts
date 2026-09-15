import { describeTelephonyPortContract } from '@mishu/adapters-mock/contract-tests'
import type { PhoneCommand, PhoneCommandResult, PhoneStatusSnapshot } from '../../shared/contracts.js'
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

/**
 * Existing mock gateway used by DesktopTelephonyAdapter unit tests.
 * Dial jumps to active so the adapter emits ringing then connected.
 */
function mockGateway(): DesktopTelephonyGateway {
  const gateway: DesktopTelephonyGateway & { status: PhoneStatusSnapshot } = {
    status: IDLE,
    getStatus: () => gateway.status,
    send: async (command: PhoneCommand): Promise<PhoneCommandResult> => {
      if (command.type === 'dial') {
        gateway.status = snapshot({
          call: { id: 'call-1', direction: 'outbound', peer: command.peer, status: 'active' }
        })
      } else if (command.type === 'answer' && gateway.status.call) {
        gateway.status = snapshot({
          call: { ...gateway.status.call, status: 'active' }
        })
      } else if ((command.type === 'reject' || command.type === 'hangup') && gateway.status.call) {
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
    }
  }
  return gateway
}

describeTelephonyPortContract(() => new DesktopTelephonyAdapter(mockGateway()), {
  capabilities: { concurrentCalls: 'single', ownerKinds: ['local_takeover'] }
})
