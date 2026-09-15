import { ownerEndpointTo } from '@mishu/core/handoff'
import { systemClock, type Clock } from '@mishu/core/clock'
import {
  TelephonyError,
  type TelephonyObservation,
  type TelephonyPort
} from '@mishu/core/ports'
import { normalizeTenantId } from '@mishu/core/tenant'
import { ConferenceHandoffController } from './conference-controller.js'
import type { TwilioRestPort } from './twilio-rest-port.js'
import { connectStreamTwiml } from '../voice/protocol/twilio-media.js'

const FROM = '+15551230000'
const STREAM_URL = 'wss://127.0.0.1/media'

function callKey(tenantId: string, callId: string): string {
  return `${tenantId}:${callId}`
}

/**
 * TelephonyPort over Twilio REST + Conference CAS. Conference identifiers
 * stay inside the adapter; core only sees dial/answer/hangup/transferToOwner.
 */
export class TwilioRestTelephonyAdapter implements TelephonyPort {
  private readonly listeners = new Set<(observation: TelephonyObservation) => void>()
  private readonly seenCommands = new Set<string>()
  private readonly calls = new Map<string, { callerSid: string; tenantId: string; callId: string }>()
  private readonly handoffForCall = new Map<string, string>()
  private readonly controller: ConferenceHandoffController

  constructor(
    private readonly twilio: TwilioRestPort,
    clock: Clock = systemClock,
    options?: {
      from?: string
      streamUrl?: string
      gatherActionUrl?: (id: string) => string
      statusCallback?: (id: string) => string
    }
  ) {
    this.from = options?.from ?? FROM
    this.streamUrl = options?.streamUrl ?? STREAM_URL
    this.controller = new ConferenceHandoffController(twilio, {
      clock,
      gatherActionUrl: options?.gatherActionUrl ?? ((id) => `https://example.invalid/twilio/gather?handoffId=${id}`),
      statusCallback: options?.statusCallback ?? ((id) => `https://example.invalid/twilio/status?handoffId=${id}`)
    })
  }

  private readonly from: string
  private readonly streamUrl: string

  capabilities(input: { tenantId: string }) {
    normalizeTenantId(input.tenantId)
    return { concurrentCalls: 'many' as const, ownerKinds: ['client', 'pstn'] as const }
  }

  async dial(input: { tenantId: string; callId: string; commandId: string; peer: string }): Promise<void> {
    normalizeTenantId(input.tenantId)
    if (this.alreadyRan(input)) return
    const created = await this.twilio.createOwnerCall({
      from: this.from,
      to: input.peer,
      twiml: connectStreamTwiml(this.streamUrl, { tenantId: input.tenantId, callId: input.callId }),
      timeoutSec: 30
    })
    this.calls.set(callKey(input.tenantId, input.callId), {
      callerSid: created.callSid,
      tenantId: input.tenantId,
      callId: input.callId
    })
    this.emit({
      tenantId: input.tenantId,
      callId: input.callId,
      commandId: input.commandId,
      type: 'ringing',
      providerRef: created.callSid
    })
    this.emit({
      tenantId: input.tenantId,
      callId: input.callId,
      commandId: input.commandId,
      type: 'connected',
      providerRef: created.callSid
    })
  }

  async answer(input: { tenantId: string; callId: string; commandId: string }): Promise<void> {
    normalizeTenantId(input.tenantId)
    if (this.alreadyRan(input)) return
    this.requireCall(input)
  }

  async reject(input: { tenantId: string; callId: string; commandId: string }): Promise<void> {
    await this.hangup({ ...input, reason: 'rejected' })
  }

  async hangup(input: { tenantId: string; callId: string; commandId: string; reason: string }): Promise<void> {
    const tenantId = normalizeTenantId(input.tenantId)
    if (this.alreadyRan({ ...input, tenantId })) return
    const key = callKey(tenantId, input.callId)
    const call = this.calls.get(key)
    if (!call) return
    const handoffId = this.handoffForCall.get(key)
    if (handoffId) await this.controller.onCallerHangup(handoffId)
    await this.twilio.endCall(call.callerSid)
    this.calls.delete(key)
    this.emit({
      tenantId,
      callId: input.callId,
      commandId: input.commandId,
      type: 'ended',
      reason: input.reason,
      providerRef: call.callerSid
    })
  }

  async transferToOwner(input: {
    tenantId: string
    callId: string
    commandId: string
    handoffId: string
    owner: { kind: 'client'; identity: string } | { kind: 'pstn'; number: string } | { kind: 'local_takeover' }
    timeoutSec: number
  }): Promise<void> {
    normalizeTenantId(input.tenantId)
    if (this.alreadyRan(input)) return
    if (input.owner.kind === 'local_takeover') {
      throw new TelephonyError('CAPABILITY_UNAVAILABLE', 'Cloud telephony does not support local_takeover')
    }
    const call = this.requireCall(input)
    this.handoffForCall.set(callKey(input.tenantId, input.callId), input.handoffId)
    await this.controller.request({
      tenantId: input.tenantId,
      callId: input.callId,
      handoffId: input.handoffId,
      commandId: input.commandId,
      callerCallSid: call.callerSid,
      owner: ownerEndpointTo(input.owner),
      from: this.from,
      timeoutSec: input.timeoutSec
    })
    this.emit({
      tenantId: input.tenantId,
      callId: input.callId,
      handoffId: input.handoffId,
      commandId: input.commandId,
      type: 'owner_ringing',
      providerRef: call.callerSid
    })
  }

  subscribe(listener: (observation: TelephonyObservation) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async ingestOwnerStatus(
    input: { tenantId: string; callId: string; handoffId: string },
    status: 'ringing' | 'answered' | 'confirmed' | 'joined' | 'busy' | 'failed'
  ): Promise<void> {
    const before = this.controller.get(input.handoffId)?.state
    await this.controller.onOwnerStatus(input.handoffId, status)
    const after = this.controller.get(input.handoffId)
    if (!after) return
    if (after.state === 'connected' && before !== 'connected') {
      this.emit({
        tenantId: input.tenantId,
        callId: input.callId,
        handoffId: input.handoffId,
        type: 'owner_joined'
      })
    } else if (
      (after.state === 'failed' || after.state === 'declined' || after.state === 'timed_out' || after.state === 'fallback_message') &&
      before !== after.state
    ) {
      this.emit({
        tenantId: input.tenantId,
        callId: input.callId,
        handoffId: input.handoffId,
        type: 'owner_failed',
        reason: after.cause
      })
    }
  }

  private alreadyRan(input: { tenantId: string; commandId: string }): boolean {
    const key = `${input.tenantId}:${input.commandId}`
    if (this.seenCommands.has(key)) return true
    this.seenCommands.add(key)
    return false
  }

  private requireCall(input: { tenantId: string; callId: string }) {
    const call = this.calls.get(callKey(input.tenantId, input.callId))
    if (!call) throw new TelephonyError('NO_ACTIVE_CALL', 'There is no active call')
    return call
  }

  private emit(observation: TelephonyObservation): void {
    for (const listener of this.listeners) listener(observation)
  }
}
