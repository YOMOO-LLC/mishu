import {
  applyFallbackIntent,
  canApplyOwnerJoined,
  claimCallerMove,
  completeCallerMove,
  hasBridgedHandoff,
  isActiveHandoffProgress,
  isTerminalHandoffState,
  moveSkipReason,
  ownerAcceptsOnAnswered,
  ownerAcceptsOnJoined,
  ownerRequiresGatherConfirm,
  transitionHandoff,
  type HandoffCause,
  type HandoffState
} from '@mishu/core/handoff'
import { systemClock, type Clock } from '@mishu/core/clock'
import { conferenceTwiml, ownerGatherTwiml } from '../voice/protocol/twilio-media.js'
import { redactPhone, redactSid } from '../voice/protocol/redact.js'
import {
  CONFERENCE_SILENCE_WAIT_URL,
  CONFERENCE_STATUS_CALLBACK_EVENTS,
  OWNER_STATUS_CALLBACK_EVENTS,
  ownerEndpointTo,
  parseOwnerEndpoint,
  type OwnerEndpoint,
  type TwilioRestPort
} from './twilio-rest-port.js'

export type { HandoffCause, HandoffState } from '@mishu/core/handoff'

export type OwnerStatus =
  | 'ringing'
  | 'answered'
  | 'confirmed'
  | 'joined'
  | 'busy'
  | 'no-answer'
  | 'failed'
  | 'canceled'

export type HandoffParty = 'owner' | 'caller'

export interface HandoffSnapshot {
  tenantId: string
  callId: string
  handoffId: string
  version: number
  state: HandoffState
  cause?: HandoffCause
  conferenceName: string
  ownerCallSidRedacted?: string
  ownerKind: OwnerEndpoint['kind']
  callerMovedToConference: boolean
  ownerLegCreated: boolean
  ownerLegEnded: boolean
  fallbackMessage?: boolean
}

export interface HandoffControllerOptions {
  clock?: Clock
  gatherActionUrl?: (handoffId: string) => string
  statusCallback?: string | ((handoffId: string) => string)
  onFallbackMessage?: (callerCallSid: string) => void
}

const MOVE_TRIGGER: ReadonlySet<OwnerStatus> = new Set(['answered', 'joined'])

export class ConferenceHandoffController {
  private readonly records = new Map<string, InternalHandoff>()
  private readonly clock: Clock

  constructor(
    private readonly twilio: TwilioRestPort,
    private readonly options: HandoffControllerOptions = {}
  ) {
    this.clock = options.clock ?? systemClock
  }

  get(handoffId: string): HandoffSnapshot | undefined {
    const record = this.records.get(handoffId)
    return record ? snapshot(record) : undefined
  }

  byOwnerCallSid(callSid: string): HandoffSnapshot | undefined {
    for (const record of this.records.values()) {
      if (record.ownerCallSid === callSid) return snapshot(record)
    }
    return undefined
  }

  byCallerCallSid(callSid: string): HandoffSnapshot | undefined {
    for (const record of this.records.values()) {
      if (record.callerCallSid === callSid) return snapshot(record)
    }
    return undefined
  }

  async request(input: {
    tenantId: string
    callId: string
    handoffId: string
    commandId: string
    callerCallSid: string
    owner: string
    from: string
    timeoutSec?: number
  }): Promise<HandoffSnapshot> {
    const existing = this.records.get(input.handoffId)
    if (existing) return { ...snapshot(existing), cause: 'duplicate' }
    const owner = parseOwnerEndpoint(input.owner)
    if (!owner) {
      const failed = this.create(input, { kind: 'client', identity: 'invalid' })
      failed.state = 'failed'
      failed.cause = 'failed'
      await this.toFallback(failed)
      return snapshot(failed)
    }
    const record = this.create(input, owner)
    const timeoutMs = (input.timeoutSec ?? 20) * 1_000
    record.timeoutId = this.clock.setTimeout(() => { void this.onDeadline(record.handoffId) }, timeoutMs)
    record.ownerLegCreated = true
    try {
      const statusCallback = this.statusCallbackUrl(record.handoffId)
      if (owner.kind === 'client') {
        const created = await this.twilio.createOwnerParticipant({
          conferenceName: record.conferenceName,
          from: input.from,
          to: ownerEndpointTo(owner),
          timeoutSec: input.timeoutSec ?? 20,
          label: 'owner',
          statusCallback,
          statusCallbackEvent: [...OWNER_STATUS_CALLBACK_EVENTS],
          conferenceStatusCallback: statusCallback,
          conferenceStatusCallbackEvent: [...CONFERENCE_STATUS_CALLBACK_EVENTS],
          waitUrl: CONFERENCE_SILENCE_WAIT_URL,
          startConferenceOnEnter: true,
          endConferenceOnExit: true
        })
        record.ownerCallSid = created.callSid
        record.conferenceSid = created.conferenceSid
      } else {
        const gatherUrl = this.options.gatherActionUrl?.(record.handoffId) ?? 'http://127.0.0.1/twilio/gather'
        const created = await this.twilio.createOwnerCall({
          from: input.from,
          to: ownerEndpointTo(owner),
          twiml: ownerGatherTwiml(gatherUrl),
          timeoutSec: input.timeoutSec ?? 20,
          statusCallback,
          statusCallbackEvent: [...OWNER_STATUS_CALLBACK_EVENTS]
        })
        record.ownerCallSid = created.callSid
      }
    } catch {
      await this.fail(record)
    }
    return snapshot(record)
  }

  async onOwnerStatus(handoffId: string, status: OwnerStatus): Promise<HandoffSnapshot | undefined> {
    const record = this.records.get(handoffId)
    if (!record) return undefined
    if (isTerminalHandoffState(record.state)) {
      if (MOVE_TRIGGER.has(status)) this.logMoveSkipped(record)
      return snapshot(record)
    }
    if (status === 'ringing') this.transition(record, 'requested', 'owner_ringing')
    else if (status === 'answered') await this.onAnswered(record)
    else if (status === 'confirmed') await this.onConfirmed(record)
    else if (status === 'joined') await this.onOwnerJoined(record)
    else if (status === 'busy' || status === 'canceled') {
      if (this.hasBridged(record)) await this.completeAfterPartyGone(record, 'owner')
      else {
        this.transition(record, record.state, 'declined', 'declined')
        await this.toFallback(record)
      }
    } else if (status === 'no-answer') {
      this.transition(record, record.state, 'timed_out', 'timed_out')
      await this.toFallback(record)
    } else if (status === 'failed') await this.fail(record)
    return snapshot(record)
  }

  async onCallerHangup(handoffId: string): Promise<HandoffSnapshot | undefined> {
    const record = this.records.get(handoffId)
    if (!record) return undefined
    if (this.hasBridged(record)) {
      await this.completeAfterPartyGone(record, 'caller')
      return snapshot(record)
    }
    if (!isTerminalHandoffState(record.state)) {
      record.state = 'cancelled'
      record.cause = 'cancelled'
      record.version += 1
      record.callerMovedToConference = false
      await this.hangupOwner(record)
      this.clearDeadline(record)
    }
    return snapshot(record)
  }

  async onPartyGone(handoffId: string, party: HandoffParty): Promise<HandoffSnapshot | undefined> {
    const record = this.records.get(handoffId)
    if (!record) return undefined
    if (this.hasBridged(record)) {
      await this.completeAfterPartyGone(record, party)
      return snapshot(record)
    }
    if (party === 'caller') return this.onCallerHangup(handoffId)
    return snapshot(record)
  }

  async onConferenceEnded(handoffId: string): Promise<HandoffSnapshot | undefined> {
    const record = this.records.get(handoffId)
    if (!record) return undefined
    if (this.hasBridged(record)) {
      await this.completeAfterPartyGone(record, 'conference')
      return snapshot(record)
    }
    return snapshot(record)
  }

  private async onAnswered(record: InternalHandoff): Promise<void> {
    if (record.state === 'requested') this.transition(record, 'requested', 'owner_ringing')
    if (!ownerAcceptsOnAnswered(record.owner.kind)) return
    // client: Participants.create already placed this leg in the conference, so answered means joined.
    await this.onOwnerJoined(record)
  }

  private async onConfirmed(record: InternalHandoff): Promise<void> {
    if (!ownerRequiresGatherConfirm(record.owner.kind)) return
    if (record.state === 'requested') this.transition(record, 'requested', 'owner_ringing')
    if (record.state !== 'owner_ringing' && record.state !== 'accepted') return
    this.transition(record, 'owner_ringing', 'accepted')
    if (!record.ownerCallSid) return
    try {
      await this.twilio.updateCallTwiml(
        record.ownerCallSid,
        conferenceTwiml(record.conferenceName, this.statusCallbackUrl(record.handoffId))
      )
    } catch {
      await this.fail(record)
    }
  }

  private async onOwnerJoined(record: InternalHandoff): Promise<void> {
    if (!canApplyOwnerJoined(record.owner.kind, record.state)) return
    if (record.state === 'requested') this.transition(record, 'requested', 'owner_ringing')
    if (record.state === 'owner_ringing') {
      if (!ownerAcceptsOnJoined(record.owner.kind)) return
      this.transition(record, 'owner_ringing', 'accepted')
    }
    await this.moveCallerOnce(record)
  }

  /** Compare-and-set: only the accepted → connecting winner may update the caller TwiML. */
  private async moveCallerOnce(record: InternalHandoff): Promise<void> {
    const claim = claimCallerMove(record)
    if (!claim.claimed) {
      if (claim.reason === 'already_moving' || claim.reason === 'already_connected') this.logMoveSkipped(record)
      return
    }
    const startedAt = this.clock.now()
    try {
      await this.twilio.updateCallTwiml(
        record.callerCallSid,
        conferenceTwiml(record.conferenceName, this.statusCallbackUrl(record.handoffId))
      )
      if (record.state !== 'connecting') return
      console.log(`handoff: caller moved elapsedMs=${this.clock.now() - startedAt}`)
      completeCallerMove(record, { ownerJoinedObserved: true })
      this.clearDeadline(record)
    } catch {
      if (record.state === 'connecting') await this.fail(record)
    }
  }

  private logMoveSkipped(record: InternalHandoff): void {
    console.log(`handoff: move skipped reason=${moveSkipReason(record)}`)
  }

  private hasBridged(record: InternalHandoff): boolean {
    return hasBridgedHandoff(record)
  }

  private async completeAfterPartyGone(
    record: InternalHandoff,
    gone: HandoffParty | 'conference'
  ): Promise<void> {
    if (record.state === 'connecting' || record.state === 'connected') {
      this.transition(record, record.state, 'completed', 'completed')
      this.clearDeadline(record)
    }
    if (gone === 'caller' || gone === 'conference') await this.hangupOwner(record)
    if (gone === 'owner' || gone === 'conference') await this.endCaller(record)
  }

  private async onDeadline(handoffId: string): Promise<void> {
    const record = this.records.get(handoffId)
    if (!record || isTerminalHandoffState(record.state) || isActiveHandoffProgress(record.state)) return
    this.transition(record, record.state, 'timed_out', 'timed_out')
    await this.toFallback(record)
  }

  private create(input: {
    tenantId: string
    callId: string
    handoffId: string
    commandId: string
    callerCallSid: string
  }, owner: OwnerEndpoint): InternalHandoff {
    const record: InternalHandoff = {
      tenantId: input.tenantId,
      callId: input.callId,
      handoffId: input.handoffId,
      commandId: input.commandId,
      callerCallSid: input.callerCallSid,
      version: 1,
      state: 'requested',
      conferenceName: `handoff_${input.handoffId}`,
      callerMovedToConference: false,
      ownerLegCreated: false,
      ownerLegEnded: false,
      callerLegEnded: false,
      owner
    }
    this.records.set(input.handoffId, record)
    return record
  }

  private transition(record: InternalHandoff, from: HandoffState, to: HandoffState, cause?: HandoffCause): boolean {
    return transitionHandoff(record, from, to, cause)
  }

  private async fail(record: InternalHandoff): Promise<void> {
    if (!isTerminalHandoffState(record.state)) this.transition(record, record.state, 'failed', 'failed')
    await this.toFallback(record)
  }

  private async toFallback(record: InternalHandoff): Promise<void> {
    if (!applyFallbackIntent(record)) return
    await this.hangupOwner(record)
    this.clearDeadline(record)
    this.options.onFallbackMessage?.(record.callerCallSid)
  }

  private statusCallbackUrl(handoffId: string): string | undefined {
    const callback = this.options.statusCallback
    if (typeof callback === 'function') return callback(handoffId)
    return callback
  }

  private async hangupOwner(record: InternalHandoff): Promise<void> {
    if (!record.ownerCallSid || record.ownerLegEnded) return
    record.ownerLegEnded = true
    try { await this.twilio.endCall(record.ownerCallSid) } catch { /* still record ended */ }
  }

  private async endCaller(record: InternalHandoff): Promise<void> {
    if (!record.callerCallSid || record.callerLegEnded) return
    record.callerLegEnded = true
    try { await this.twilio.endCall(record.callerCallSid) } catch { /* still record ended */ }
  }

  private clearDeadline(record: InternalHandoff): void {
    if (record.timeoutId !== undefined) this.clock.clearTimeout(record.timeoutId)
    record.timeoutId = undefined
  }
}

interface InternalHandoff {
  tenantId: string
  callId: string
  handoffId: string
  commandId: string
  callerCallSid: string
  version: number
  state: HandoffState
  cause?: HandoffCause
  conferenceName: string
  ownerCallSid?: string
  conferenceSid?: string
  callerMovedToConference: boolean
  ownerLegCreated: boolean
  ownerLegEnded: boolean
  callerLegEnded: boolean
  fallbackMessage?: boolean
  timeoutId?: unknown
  owner: OwnerEndpoint
}

function snapshot(record: InternalHandoff): HandoffSnapshot {
  return {
    tenantId: record.tenantId,
    callId: record.callId,
    handoffId: record.handoffId,
    version: record.version,
    state: record.state,
    cause: record.cause,
    conferenceName: record.conferenceName,
    ownerCallSidRedacted: record.ownerCallSid ? redactSid(record.ownerCallSid) : undefined,
    ownerKind: record.owner.kind,
    callerMovedToConference: record.callerMovedToConference,
    ownerLegCreated: record.ownerLegCreated,
    ownerLegEnded: record.ownerLegEnded,
    fallbackMessage: record.fallbackMessage
  }
}

export function redactOwner(owner: string): string {
  return owner.startsWith('client:') ? `client:${owner.slice(7, 9)}…` : redactPhone(owner)
}
