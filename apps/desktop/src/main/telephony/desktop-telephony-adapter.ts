import {
  TelephonyError,
  type TelephonyCapabilities,
  type TelephonyCommandInput,
  type TelephonyDialInput,
  type TelephonyHangupInput,
  type TelephonyListener,
  type TelephonyObservation,
  type TelephonyTransferInput
} from '@mishu/core/ports'
import { normalizeTenantId } from '@mishu/core/tenant'
import type {
  PhoneCommand,
  PhoneCommandErrorCode,
  PhoneCommandResult,
  PhoneStatusSnapshot
} from '../../shared/contracts.js'
import { statusHasActiveCall } from '../services/phone-service.js'
import type { EngineTelephony } from './engine-telephony.js'

export interface DesktopTelephonyGateway {
  send(
    command: PhoneCommand,
    options: { actor: string; timeoutMs?: number }
  ): Promise<PhoneCommandResult>
  getStatus(): PhoneStatusSnapshot
}

export function asEngineTelephony(
  value: EngineTelephony | DesktopTelephonyGateway
): EngineTelephony {
  if (isEngineTelephony(value)) return value
  return new DesktopTelephonyAdapter(value)
}

function isEngineTelephony(value: EngineTelephony | DesktopTelephonyGateway): value is EngineTelephony {
  return typeof (value as EngineTelephony).execute === 'function'
    && typeof (value as EngineTelephony).capabilities === 'function'
}

const DESKTOP_CAPABILITIES: TelephonyCapabilities = {
  concurrentCalls: 'single',
  ownerKinds: ['local_takeover']
}

const DESKTOP_ACTOR = 'http'

/**
 * Main-process TelephonyPort adapter. PhoneService and /v1 call control
 * go through this port; the desktop host still owns PhoneCommandGateway.
 */
export class DesktopTelephonyAdapter implements EngineTelephony {
  private readonly listeners = new Set<TelephonyListener>()
  private readonly seenCommands = new Set<string>()
  private readonly handoffByCall = new Map<string, string>()
  /** Port callId -> gateway PhoneCall.id */
  private readonly gatewayByPortId = new Map<string, string>()
  /** Gateway PhoneCall.id -> port callId */
  private readonly portByGatewayId = new Map<string, string>()
  private lastSnapshot?: PhoneStatusSnapshot

  constructor(private readonly gateway: DesktopTelephonyGateway) {}

  getStatus(): PhoneStatusSnapshot {
    return this.gateway.getStatus()
  }

  execute(
    command: PhoneCommand,
    options: { actor: string; timeoutMs?: number }
  ): Promise<PhoneCommandResult> {
    return this.gateway.send(command, options)
  }

  send(
    command: PhoneCommand,
    options: { actor: string; timeoutMs?: number }
  ): Promise<PhoneCommandResult> {
    return this.execute(command, options)
  }

  capabilities(input: { tenantId: string }): TelephonyCapabilities {
    normalizeTenantId(input.tenantId)
    return DESKTOP_CAPABILITIES
  }

  async dial(input: TelephonyDialInput): Promise<void> {
    normalizeTenantId(input.tenantId)
    await this.runOnce(input, async () => {
      this.captureStatus()
      const status = this.gateway.getStatus()
      if (statusHasActiveCall(status) && !this.sameLiveCall(input.callId, status)) {
        throw new TelephonyError('CALL_IN_PROGRESS', 'A call is already in progress')
      }
      const result = await this.gateway.send(
        { type: 'dial', peer: input.peer },
        { actor: DESKTOP_ACTOR }
      )
      this.finish(input, result, input.callId)
    })
  }

  async answer(input: TelephonyCommandInput): Promise<void> {
    normalizeTenantId(input.tenantId)
    await this.runOnce(input, async () => {
      this.captureStatus()
      const result = await this.gateway.send({ type: 'answer' }, { actor: DESKTOP_ACTOR })
      this.finish(input, result, input.callId)
    })
  }

  async reject(input: TelephonyCommandInput): Promise<void> {
    normalizeTenantId(input.tenantId)
    await this.runOnce(input, async () => {
      this.captureStatus()
      const result = await this.gateway.send({ type: 'reject' }, { actor: DESKTOP_ACTOR })
      this.finish(input, result, input.callId, { endedReason: 'rejected' })
    })
  }

  async hangup(input: TelephonyHangupInput): Promise<void> {
    normalizeTenantId(input.tenantId)
    await this.runOnce(input, async () => {
      this.captureStatus()
      if (!this.isLiveCall(input.callId, this.gateway.getStatus())) return
      const result = await this.gateway.send({ type: 'hangup' }, { actor: DESKTOP_ACTOR })
      this.finish(input, result, input.callId, { endedReason: input.reason })
    })
  }

  async transferToOwner(input: TelephonyTransferInput): Promise<void> {
    normalizeTenantId(input.tenantId)
    await this.runOnce(input, async () => {
      this.captureStatus()
      if (input.owner.kind !== 'local_takeover') {
        throw new TelephonyError(
          'CAPABILITY_UNAVAILABLE',
          `Desktop telephony only supports local_takeover, not ${input.owner.kind}`
        )
      }
      this.handoffByCall.set(callKey(input.tenantId, input.callId), input.handoffId)
      const result = await this.gateway.send(
        { type: 'setControlMode', mode: 'human' },
        { actor: DESKTOP_ACTOR }
      )
      this.finish(input, result, input.callId, { handoffId: input.handoffId })
    })
  }

  subscribe(listener: TelephonyListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Wave 3 can push renderer snapshots here; unit tests drive it through commands.
   * Inbound calls the port did not initiate are assigned a port callId equal to
   * the gateway PhoneCall.id (the renderer minted that id).
   */
  observeSnapshot(
    snapshot: PhoneStatusSnapshot,
    context: { tenantId: string; callId?: string; commandId?: string; endedReason?: string; handoffId?: string } = {
      tenantId: 'local'
    }
  ): void {
    const previous = this.lastSnapshot
    this.lastSnapshot = snapshot
    for (const observation of observationsFromSnapshot(
      previous,
      snapshot,
      context,
      this.handoffByCall,
      (gatewayCallId, contextCallId) => this.resolvePortCallId(gatewayCallId, contextCallId)
    )) {
      this.emit(observation)
    }
  }

  private bindCallIds(portCallId: string, gatewayCallId: string | undefined): void {
    if (!gatewayCallId) return
    this.gatewayByPortId.set(portCallId, gatewayCallId)
    this.portByGatewayId.set(gatewayCallId, portCallId)
  }

  private resolvePortCallId(gatewayCallId: string | undefined, contextCallId?: string): string | undefined {
    if (contextCallId) {
      this.bindCallIds(contextCallId, gatewayCallId)
      return contextCallId
    }
    if (!gatewayCallId) return undefined
    const mapped = this.portByGatewayId.get(gatewayCallId)
    if (mapped) return mapped
    this.bindCallIds(gatewayCallId, gatewayCallId)
    return gatewayCallId
  }

  private sameLiveCall(portCallId: string, status: PhoneStatusSnapshot): boolean {
    const live = status.call
    if (!live) return false
    const gatewayId = this.gatewayByPortId.get(portCallId)
    return live.id === portCallId || (gatewayId !== undefined && live.id === gatewayId)
  }

  private isLiveCall(portCallId: string, status: PhoneStatusSnapshot): boolean {
    const live = status.call
    if (!live || live.status === 'ended' || live.status === 'error') return false
    return this.sameLiveCall(portCallId, status)
  }

  private captureStatus(): void {
    try {
      this.lastSnapshot = this.gateway.getStatus()
    } catch {
      this.lastSnapshot = undefined
    }
  }

  private async runOnce(input: TelephonyCommandInput, run: () => Promise<void>): Promise<void> {
    const key = `${input.tenantId}:${input.commandId}`
    if (this.seenCommands.has(key)) return
    this.seenCommands.add(key)
    try {
      await run()
    } catch (error) {
      this.seenCommands.delete(key)
      throw error
    }
  }

  private finish(
    input: TelephonyCommandInput,
    result: PhoneCommandResult,
    callId: string,
    extra: { endedReason?: string; handoffId?: string } = {}
  ): void {
    if (!result.ok) {
      this.seenCommands.delete(`${input.tenantId}:${input.commandId}`)
      throw toTelephonyError(result.code, result.message)
    }
    this.bindCallIds(callId, result.status.call?.id)
    this.observeSnapshot(result.status, {
      tenantId: input.tenantId,
      callId,
      commandId: input.commandId,
      ...extra
    })
  }

  private emit(observation: TelephonyObservation): void {
    for (const listener of this.listeners) listener(observation)
  }
}

function callKey(tenantId: string, callId: string): string {
  return `${tenantId}:${callId}`
}

function toTelephonyError(code: PhoneCommandErrorCode, message: string): TelephonyError {
  if (
    code === 'CALL_IN_PROGRESS' ||
    code === 'NO_ACTIVE_CALL' ||
    code === 'TIMEOUT' ||
    code === 'APP_NOT_READY'
  ) {
    return new TelephonyError(code, message)
  }
  if (code === 'INVALID_NUMBER') return new TelephonyError('INVALID_ARGUMENT', message)
  return new TelephonyError('APP_NOT_READY', message)
}

function observationsFromSnapshot(
  previous: PhoneStatusSnapshot | undefined,
  next: PhoneStatusSnapshot,
  context: { tenantId: string; callId?: string; commandId?: string; endedReason?: string; handoffId?: string },
  handoffByCall: Map<string, string>,
  resolvePortCallId: (gatewayCallId: string | undefined, contextCallId?: string) => string | undefined
): TelephonyObservation[] {
  const observations: TelephonyObservation[] = []
  const call = next.call
  const tenantId = context.tenantId
  const commandId = context.commandId
  const callId = resolvePortCallId(call?.id, context.callId)
  if (!callId) return observations

  const previousCall = previous?.call
  const previousStatus = previousCall?.id && previousCall.id === call?.id ? previousCall.status : undefined
  const nextStatus = call?.status
  const providerRef = call?.providerCallSid ?? call?.id
  const base = { tenantId, callId, ...(commandId ? { commandId } : {}), ...(providerRef ? { providerRef } : {}) }

  if (
    (nextStatus === 'dialing' || nextStatus === 'ringing' || nextStatus === 'connecting') &&
    previousStatus !== nextStatus
  ) {
    observations.push({ ...base, type: 'ringing' })
  }
  if (nextStatus === 'active' && previousStatus !== 'active') {
    if (
      previousStatus !== 'dialing' &&
      previousStatus !== 'ringing' &&
      previousStatus !== 'connecting' &&
      previous?.call?.id !== call?.id
    ) {
      observations.push({ ...base, type: 'ringing' })
    }
    observations.push({ ...base, type: 'connected' })
  }
  if ((nextStatus === 'ended' || nextStatus === 'error') && previousStatus !== nextStatus) {
    observations.push({
      ...base,
      type: 'ended',
      ...(context.endedReason || nextStatus === 'error' ? { reason: context.endedReason ?? nextStatus } : {})
    })
  }

  const handoffId = context.handoffId ?? handoffByCall.get(callKey(tenantId, callId))
  if (handoffId && next.controlMode === 'human' && previous?.controlMode !== 'human') {
    observations.push({ ...base, handoffId, type: 'owner_ringing' })
    observations.push({ ...base, handoffId, type: 'owner_joined' })
  }

  return observations
}
