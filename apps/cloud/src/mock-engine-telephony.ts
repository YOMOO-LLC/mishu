import { randomUUID } from 'node:crypto'
import { TelephonyError, type TelephonyObservation } from '@mishu/core/ports'
import type { MockTelephony } from '@mishu/adapters-mock'
import type { Clock, IdGen } from '@mishu/core/clock'
import type {
  CallDirection,
  CallLifecycleReport,
  PhoneCall,
  PhoneCommand,
  PhoneCommandErrorCode,
  PhoneCommandResult,
  PhoneStatusSnapshot
} from '../../desktop/src/shared/contracts.js'
import type { CallStore } from '../../desktop/src/main/call-store.js'
import type { CampaignStore } from '../../desktop/src/main/campaign-store.js'
import type { EngineTelephony } from '../../desktop/src/main/telephony/engine-telephony.js'

const PHONE_ERROR_CODES = new Set<PhoneCommandErrorCode>([
  'APP_NOT_READY',
  'CALL_IN_PROGRESS',
  'NO_ACTIVE_CALL',
  'INVALID_NUMBER',
  'GUARDRAIL_BLOCKED',
  'MOCK_ONLY',
  'TIMEOUT',
  'RENDERER_ERROR'
])

export interface CloudEngineTelephonyOptions {
  mock: MockTelephony
  tenantId: string
  callStore: CallStore
  campaignStore: CampaignStore
  clock: Clock
  idGen: IdGen
}

interface TrackedCall {
  peer: string
  direction: CallDirection
  campaignId?: string
  startedAt: number
}

/**
 * Maps MockTelephony (TelephonyPort) onto EngineTelephony so PhoneService
 * and TaskRunner keep using PhoneCommand execute/getStatus.
 */
export class CloudEngineTelephony implements EngineTelephony {
  readonly mock: MockTelephony
  private readonly tenantId: string
  private readonly callStore: CallStore
  private readonly campaignStore: CampaignStore
  private readonly clock: Clock
  private readonly idGen: IdGen
  private readonly tracked = new Map<string, TrackedCall>()
  private readonly unsubscribe: () => void
  private snapshot: PhoneStatusSnapshot

  constructor(options: CloudEngineTelephonyOptions) {
    this.mock = options.mock
    this.tenantId = options.tenantId
    this.callStore = options.callStore
    this.campaignStore = options.campaignStore
    this.clock = options.clock
    this.idGen = options.idGen
    this.snapshot = idleSnapshot(this.clock.now())
    this.unsubscribe = this.mock.subscribe((observation) => this.onObservation(observation))
  }

  capabilities(input: { tenantId: string }) {
    return this.mock.capabilities(input)
  }

  dial(input: Parameters<EngineTelephony['dial']>[0]) {
    return this.mock.dial(input)
  }

  answer(input: Parameters<EngineTelephony['answer']>[0]) {
    return this.mock.answer(input)
  }

  reject(input: Parameters<EngineTelephony['reject']>[0]) {
    return this.mock.reject(input)
  }

  hangup(input: Parameters<EngineTelephony['hangup']>[0]) {
    return this.mock.hangup(input)
  }

  transferToOwner(input: Parameters<EngineTelephony['transferToOwner']>[0]) {
    return this.mock.transferToOwner(input)
  }

  subscribe(listener: Parameters<EngineTelephony['subscribe']>[0]) {
    return this.mock.subscribe(listener)
  }

  getStatus(): PhoneStatusSnapshot {
    return this.snapshot
  }

  async execute(
    command: PhoneCommand,
    _options: { actor: string; timeoutMs?: number }
  ): Promise<PhoneCommandResult> {
    const requestId = randomUUID()
    try {
      await this.dispatch(command)
      return { requestId, ok: true, status: this.snapshot }
    } catch (error) {
      return { requestId, ok: false, code: commandErrorCode(error), message: commandErrorMessage(error) }
    }
  }

  dispose(): void {
    this.unsubscribe()
  }

  private async dispatch(command: PhoneCommand): Promise<void> {
    switch (command.type) {
      case 'dial': {
        if (this.hasLiveCall()) {
          throw new TelephonyError('CALL_IN_PROGRESS', 'A call is already in progress')
        }
        const callId = this.idGen.id()
        this.tracked.set(callId, {
          peer: command.peer,
          direction: 'outbound',
          ...(command.campaignId ? { campaignId: command.campaignId } : {}),
          startedAt: this.clock.now()
        })
        await this.mock.dial({
          tenantId: this.tenantId,
          callId,
          commandId: this.idGen.id(),
          peer: command.peer
        })
        // Yield a macrotask so TaskRunner can publish `dialing` before `in_call`.
        await wait(this.clock, 80)
        return
      }
      case 'hangup': {
        const callId = this.requireLiveCallId()
        await this.mock.hangup({
          tenantId: this.tenantId,
          callId,
          commandId: this.idGen.id(),
          reason: 'local_hangup'
        })
        return
      }
      case 'answer': {
        const callId = this.requireLiveCallId()
        await this.mock.answer({
          tenantId: this.tenantId,
          callId,
          commandId: this.idGen.id()
        })
        return
      }
      case 'reject': {
        const callId = this.requireLiveCallId()
        await this.mock.reject({
          tenantId: this.tenantId,
          callId,
          commandId: this.idGen.id()
        })
        return
      }
      case 'simulateIncoming': {
        if (this.hasLiveCall()) {
          throw new TelephonyError('CALL_IN_PROGRESS', 'A call is already in progress')
        }
        const peer = command.peer?.trim() || '+15555550100'
        const callId = this.idGen.id()
        this.tracked.set(callId, {
          peer,
          direction: 'inbound',
          startedAt: this.clock.now()
        })
        this.mock.simulateInbound({
          tenantId: this.tenantId,
          peer,
          callId,
          commandId: this.idGen.id()
        })
        return
      }
      case 'simulateRemoteHangup': {
        const callId = this.requireLiveCallId()
        await this.mock.hangup({
          tenantId: this.tenantId,
          callId,
          commandId: this.idGen.id(),
          reason: 'remote_hangup'
        })
        return
      }
      case 'setControlMode': {
        this.snapshot = { ...this.snapshot, controlMode: command.mode, updatedAt: this.clock.now() }
        return
      }
      case 'getStatus':
        return
      case 'simulateRealtimeStartFailure':
        throw new TelephonyError('CAPABILITY_UNAVAILABLE', 'Realtime start failure simulation is unavailable on the headless host')
      default: {
        const _never: never = command
        throw new TelephonyError('INVALID_ARGUMENT', `Unsupported phone command: ${JSON.stringify(_never)}`)
      }
    }
  }

  private onObservation(observation: TelephonyObservation): void {
    if (observation.type === 'owner_ringing' || observation.type === 'owner_joined' || observation.type === 'owner_failed') {
      return
    }
    const meta = this.tracked.get(observation.callId)
    if (!meta) return
    const status = phoneStatusFor(observation, meta.direction)
    const call: PhoneCall = {
      id: observation.callId,
      direction: meta.direction,
      peer: meta.peer,
      status,
      startedAt: meta.startedAt
    }
    this.snapshot = {
      ...this.snapshot,
      call,
      updatedAt: this.clock.now()
    }
    this.report(call, observation.type === 'ended' ? (observation.reason === 'rejected' ? 'rejected' : 'local_hangup') : undefined)
    if (status === 'ended' || status === 'error') {
      this.tracked.delete(observation.callId)
    }
  }

  private report(call: PhoneCall, endReason?: CallLifecycleReport['endReason']): void {
    const meta = this.tracked.get(call.id)
    const workspace = this.campaignStore.getWorkspace()
    const campaignId = meta?.campaignId ?? workspace.selectedCampaignId
    const campaign = this.campaignStore.getCampaign(campaignId)
    this.callStore.report({
      call,
      runtimeMode: 'mock',
      ...(campaign ? { campaign } : {}),
      ...(endReason ? { endReason } : {})
    })
  }

  private hasLiveCall(): boolean {
    const call = this.snapshot.call
    return Boolean(call && call.status !== 'ended' && call.status !== 'error')
  }

  private requireLiveCallId(): string {
    const call = this.snapshot.call
    if (!call || call.status === 'ended' || call.status === 'error') {
      throw new TelephonyError('NO_ACTIVE_CALL', 'There is no active call')
    }
    return call.id
  }
}

function idleSnapshot(updatedAt: number): PhoneStatusSnapshot {
  return {
    runtimeMode: 'mock',
    phoneConnection: 'ready',
    codexConnection: { status: 'ready' },
    controlMode: 'ai',
    updatedAt
  }
}

function wait(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms)
  })
}

function phoneStatusFor(observation: TelephonyObservation, direction: CallDirection): PhoneCall['status'] {
  if (observation.type === 'ended') return 'ended'
  if (observation.type === 'connected') return 'active'
  return direction === 'inbound' ? 'ringing' : 'dialing'
}

function commandErrorCode(error: unknown): PhoneCommandErrorCode {
  if (error instanceof TelephonyError && PHONE_ERROR_CODES.has(error.code as PhoneCommandErrorCode)) {
    return error.code as PhoneCommandErrorCode
  }
  if (error instanceof TelephonyError && error.code === 'CAPABILITY_UNAVAILABLE') return 'MOCK_ONLY'
  return 'RENDERER_ERROR'
}

function commandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Phone command failed'
}
