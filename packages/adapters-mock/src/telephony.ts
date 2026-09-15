import type { Clock, IdGen } from '@mishu/core/clock'
import type { OwnerEndpoint } from '@mishu/core/handoff'
import {
  TelephonyError,
  type TelephonyCapabilities,
  type TelephonyCommandInput,
  type TelephonyDialInput,
  type TelephonyHangupInput,
  type TelephonyListener,
  type TelephonyObservation,
  type TelephonyPort,
  type TelephonyTransferInput
} from '@mishu/core/ports'
import { FakeClock, FakeIdGen } from './clock.js'
import { requireTelephonyTenant } from './require-tenant.js'

/** Kept so the T12.14 stub suite still passes. */
export const ADAPTERS_MOCK_TELEPHONY_TASK = 'T12.18'

const MOCK_OWNER_KINDS = ['client', 'pstn'] as const

export type MockOwnerOutcome = 'joined' | 'failed' | 'timeout'

export interface MockTelephonyOptions {
  clock?: Clock
  idGen?: IdGen
  /** Delay from dial ringing to connected. 0 emits both inside dial(). */
  connectDelayMs?: number
  /** Default transfer result for client/pstn owners. */
  ownerOutcome?: MockOwnerOutcome
  /** Delay after owner_ringing before auto join/fail. Ignored when outcome is timeout. */
  ownerJoinDelayMs?: number
}

interface TransferState {
  handoffId: string
  commandId: string
  timeoutId: unknown
  joinId?: unknown
  owner: OwnerEndpoint
}

interface CallRecord {
  tenantId: string
  callId: string
  peer: string
  direction: 'inbound' | 'outbound'
  status: 'ringing' | 'connected' | 'ended'
  connectId?: unknown
  transfer?: TransferState
  endedReason?: string
}

function callKey(tenantId: string, callId: string): string {
  return `${tenantId}:${callId}`
}

function requireCallId(callId: unknown): string {
  if (typeof callId !== 'string' || callId.trim() === '') {
    throw new TelephonyError('INVALID_ARGUMENT', 'callId is required')
  }
  return callId.trim()
}

function requireCommandId(commandId: unknown): string {
  if (typeof commandId !== 'string' || commandId.trim() === '') {
    throw new TelephonyError('INVALID_ARGUMENT', 'commandId is required')
  }
  return commandId.trim()
}

function requireCommand(input: TelephonyCommandInput): {
  tenantId: string
  callId: string
  commandId: string
} {
  return {
    tenantId: requireTelephonyTenant(input.tenantId),
    callId: requireCallId(input.callId),
    commandId: requireCommandId(input.commandId)
  }
}

/**
 * In-memory TelephonyPort. Timers go through Clock; no network.
 * local_takeover is capability-unavailable, matching the cloud adapter.
 */
export class MockTelephony implements TelephonyPort {
  readonly clock: Clock
  readonly idGen: IdGen
  connectDelayMs: number
  ownerOutcome: MockOwnerOutcome
  ownerJoinDelayMs: number

  private readonly listeners = new Set<TelephonyListener>()
  private readonly seenCommands = new Set<string>()
  private readonly calls = new Map<string, CallRecord>()

  constructor(options: MockTelephonyOptions = {}) {
    this.clock = options.clock ?? new FakeClock(0)
    this.idGen = options.idGen ?? new FakeIdGen('call')
    this.connectDelayMs = options.connectDelayMs ?? 0
    this.ownerOutcome = options.ownerOutcome ?? 'joined'
    this.ownerJoinDelayMs = options.ownerJoinDelayMs ?? 0
  }

  capabilities(input: { tenantId: string }): TelephonyCapabilities {
    requireTelephonyTenant(input.tenantId)
    return { concurrentCalls: 'many', ownerKinds: MOCK_OWNER_KINDS }
  }

  /**
   * Place a simulated inbound call into ringing. answer/reject act on it.
   * This is a test helper, not a TelephonyPort method.
   */
  simulateInbound(input: {
    tenantId: string
    peer: string
    callId?: string
    commandId?: string
  }): { callId: string } {
    const tenantId = requireTelephonyTenant(input.tenantId)
    const peer = requirePeer(input.peer)
    const callId = input.callId?.trim() || this.idGen.id()
    const key = callKey(tenantId, callId)
    const existing = this.calls.get(key)
    if (existing && existing.status !== 'ended') {
      throw new TelephonyError('CALL_IN_PROGRESS', `Call ${callId} is already active`)
    }
    const record: CallRecord = {
      tenantId,
      callId,
      peer,
      direction: 'inbound',
      status: 'ringing'
    }
    this.calls.set(key, record)
    this.emit({
      tenantId,
      callId,
      ...(input.commandId ? { commandId: input.commandId } : {}),
      type: 'ringing'
    })
    return { callId }
  }

  /** Drive a pending transfer to owner_joined before the clock timeout. */
  simulateOwnerJoined(input: { tenantId: string; callId: string }): void {
    const tenantId = requireTelephonyTenant(input.tenantId)
    const callId = requireCallId(input.callId)
    const record = this.requireLiveCall(tenantId, callId)
    if (!record.transfer) {
      throw new TelephonyError('INVALID_ARGUMENT', 'There is no pending owner transfer')
    }
    this.completeOwnerJoin(record)
  }

  /** Drive a pending transfer to owner_failed before the clock timeout. */
  simulateOwnerFailed(input: { tenantId: string; callId: string; reason?: string }): void {
    const tenantId = requireTelephonyTenant(input.tenantId)
    const callId = requireCallId(input.callId)
    const record = this.requireLiveCall(tenantId, callId)
    if (!record.transfer) {
      throw new TelephonyError('INVALID_ARGUMENT', 'There is no pending owner transfer')
    }
    this.failOwner(record, input.reason ?? 'failed')
  }

  async dial(input: TelephonyDialInput): Promise<void> {
    const command = requireCommand(input)
    if (this.alreadyRan(command)) return
    const peer = requirePeer(input.peer)
    const key = callKey(command.tenantId, command.callId)
    const existing = this.calls.get(key)
    if (existing && existing.status !== 'ended') {
      this.forgetCommand(command)
      throw new TelephonyError('CALL_IN_PROGRESS', `Call ${command.callId} is already active`)
    }
    const record: CallRecord = {
      tenantId: command.tenantId,
      callId: command.callId,
      peer,
      direction: 'outbound',
      status: 'ringing'
    }
    this.calls.set(key, record)
    this.emit({
      tenantId: command.tenantId,
      callId: command.callId,
      commandId: command.commandId,
      type: 'ringing'
    })
    const connect = (): void => {
      if (record.status !== 'ringing') return
      record.status = 'connected'
      record.connectId = undefined
      this.emit({
        tenantId: command.tenantId,
        callId: command.callId,
        commandId: command.commandId,
        type: 'connected'
      })
    }
    if (this.connectDelayMs <= 0) {
      connect()
      return
    }
    record.connectId = this.clock.setTimeout(connect, this.connectDelayMs)
  }

  async answer(input: TelephonyCommandInput): Promise<void> {
    const command = requireCommand(input)
    if (this.alreadyRan(command)) return
    const record = this.calls.get(callKey(command.tenantId, command.callId))
    if (!record || record.status === 'ended') {
      this.forgetCommand(command)
      throw new TelephonyError('NO_ACTIVE_CALL', 'There is no inbound call to answer')
    }
    if (record.status === 'connected') return
    if (record.direction !== 'inbound' || record.status !== 'ringing') {
      this.forgetCommand(command)
      throw new TelephonyError('NO_ACTIVE_CALL', 'There is no inbound call to answer')
    }
    if (record.connectId !== undefined) this.clock.clearTimeout(record.connectId)
    record.connectId = undefined
    record.status = 'connected'
    this.emit({
      tenantId: command.tenantId,
      callId: command.callId,
      commandId: command.commandId,
      type: 'connected'
    })
  }

  async reject(input: TelephonyCommandInput): Promise<void> {
    const command = requireCommand(input)
    if (this.alreadyRan(command)) return
    const record = this.calls.get(callKey(command.tenantId, command.callId))
    if (!record || record.status !== 'ringing' || record.direction !== 'inbound') {
      this.forgetCommand(command)
      throw new TelephonyError('NO_ACTIVE_CALL', 'There is no inbound call to reject')
    }
    this.endCall(record, 'rejected', command.commandId)
  }

  async hangup(input: TelephonyHangupInput): Promise<void> {
    const command = requireCommand(input)
    if (this.alreadyRan(command)) return
    const record = this.calls.get(callKey(command.tenantId, command.callId))
    if (!record || record.status === 'ended') {
      return
    }
    this.endCall(record, input.reason || 'local_hangup', command.commandId)
  }

  async transferToOwner(input: TelephonyTransferInput): Promise<void> {
    const command = requireCommand(input)
    if (this.alreadyRan(command)) return
    if (!input.handoffId?.trim()) {
      this.forgetCommand(command)
      throw new TelephonyError('INVALID_ARGUMENT', 'handoffId is required')
    }
    if (!Number.isFinite(input.timeoutSec) || input.timeoutSec < 0) {
      this.forgetCommand(command)
      throw new TelephonyError('INVALID_ARGUMENT', 'timeoutSec is required')
    }
    if (input.owner.kind === 'local_takeover') {
      this.forgetCommand(command)
      throw new TelephonyError(
        'CAPABILITY_UNAVAILABLE',
        'Mock telephony does not support local_takeover'
      )
    }
    const record = this.calls.get(callKey(command.tenantId, command.callId))
    if (!record || record.status === 'ended') {
      this.forgetCommand(command)
      throw new TelephonyError('NO_ACTIVE_CALL', 'There is no active call')
    }
    if (record.status !== 'connected') {
      this.forgetCommand(command)
      throw new TelephonyError('NO_ACTIVE_CALL', 'Call is not connected')
    }
    this.clearTransferTimers(record)
    const timeoutMs = input.timeoutSec * 1000
    const transfer: TransferState = {
      handoffId: input.handoffId.trim(),
      commandId: command.commandId,
      timeoutId: this.clock.setTimeout(() => {
        this.failOwner(record, 'timed_out')
      }, timeoutMs),
      owner: input.owner
    }
    record.transfer = transfer
    this.emit({
      tenantId: command.tenantId,
      callId: command.callId,
      handoffId: transfer.handoffId,
      commandId: command.commandId,
      type: 'owner_ringing'
    })
    if (this.ownerOutcome === 'timeout') return
    const finish = (): void => {
      if (this.ownerOutcome === 'failed') this.failOwner(record, 'failed')
      else this.completeOwnerJoin(record)
    }
    if (this.ownerJoinDelayMs <= 0) {
      finish()
      return
    }
    transfer.joinId = this.clock.setTimeout(finish, this.ownerJoinDelayMs)
  }

  subscribe(listener: TelephonyListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private alreadyRan(input: { tenantId: string; commandId: string }): boolean {
    const key = `${input.tenantId}:${input.commandId}`
    if (this.seenCommands.has(key)) return true
    this.seenCommands.add(key)
    return false
  }

  private forgetCommand(input: { tenantId: string; commandId: string }): void {
    this.seenCommands.delete(`${input.tenantId}:${input.commandId}`)
  }

  private requireLiveCall(tenantId: string, callId: string): CallRecord {
    const record = this.calls.get(callKey(tenantId, callId))
    if (!record || record.status === 'ended') {
      throw new TelephonyError('NO_ACTIVE_CALL', 'There is no active call')
    }
    return record
  }

  private completeOwnerJoin(record: CallRecord): void {
    const transfer = record.transfer
    if (!transfer || record.status === 'ended') return
    this.clearTransferTimers(record)
    record.transfer = undefined
    this.emit({
      tenantId: record.tenantId,
      callId: record.callId,
      handoffId: transfer.handoffId,
      commandId: transfer.commandId,
      type: 'owner_joined'
    })
  }

  private failOwner(record: CallRecord, reason: string): void {
    const transfer = record.transfer
    if (!transfer || record.status === 'ended') return
    this.clearTransferTimers(record)
    record.transfer = undefined
    this.emit({
      tenantId: record.tenantId,
      callId: record.callId,
      handoffId: transfer.handoffId,
      commandId: transfer.commandId,
      type: 'owner_failed',
      reason
    })
  }

  private endCall(record: CallRecord, reason: string, commandId?: string): void {
    if (record.status === 'ended') return
    this.clearTransferTimers(record)
    if (record.connectId !== undefined) this.clock.clearTimeout(record.connectId)
    record.connectId = undefined
    record.transfer = undefined
    record.status = 'ended'
    record.endedReason = reason
    this.emit({
      tenantId: record.tenantId,
      callId: record.callId,
      ...(commandId ? { commandId } : {}),
      type: 'ended',
      reason
    })
  }

  private clearTransferTimers(record: CallRecord): void {
    const transfer = record.transfer
    if (!transfer) return
    this.clock.clearTimeout(transfer.timeoutId)
    if (transfer.joinId !== undefined) this.clock.clearTimeout(transfer.joinId)
    transfer.joinId = undefined
  }

  private emit(observation: TelephonyObservation): void {
    const record = this.calls.get(callKey(observation.tenantId, observation.callId))
    if (record?.status === 'ended' && observation.type !== 'ended') return
    for (const listener of [...this.listeners]) listener(observation)
  }
}

function requirePeer(peer: unknown): string {
  if (typeof peer !== 'string' || peer.trim() === '') {
    throw new TelephonyError('INVALID_ARGUMENT', 'peer is required')
  }
  return peer.trim()
}
