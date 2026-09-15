import type { OwnerEndpoint, OwnerEndpointKind } from '../handoff.js'

export type TelephonyCallObservationType = 'ringing' | 'connected' | 'ended'
export type TelephonyOwnerObservationType = 'owner_ringing' | 'owner_joined' | 'owner_failed'

export type TelephonyErrorCode =
  | 'CALL_IN_PROGRESS'
  | 'NO_ACTIVE_CALL'
  | 'CAPABILITY_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'APP_NOT_READY'

export class TelephonyError extends Error {
  constructor(
    readonly code: TelephonyErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TelephonyError'
  }
}

export interface TelephonyCapabilities {
  concurrentCalls: 'single' | 'many'
  ownerKinds: readonly OwnerEndpointKind[]
}

export interface TelephonyCommandInput {
  tenantId: string
  callId: string
  commandId: string
}

export interface TelephonyDialInput extends TelephonyCommandInput {
  peer: string
}

export interface TelephonyHangupInput extends TelephonyCommandInput {
  reason: string
}

export interface TelephonyTransferInput extends TelephonyCommandInput {
  handoffId: string
  owner: OwnerEndpoint
  timeoutSec: number
}

export type TelephonyObservation =
  | {
      tenantId: string
      callId: string
      commandId?: string
      type: TelephonyCallObservationType
      reason?: string
      providerRef?: string
    }
  | {
      tenantId: string
      callId: string
      handoffId: string
      type: TelephonyOwnerObservationType
      commandId?: string
      reason?: string
      providerRef?: string
    }

export type TelephonyListener = (observation: TelephonyObservation) => void

/**
 * Host-agnostic telephony commands. Core never sees conference or device
 * identifiers; those stay in adapters. Single-active-call hosts report
 * `concurrentCalls: 'single'` and throw `CALL_IN_PROGRESS` rather than
 * baking that limit into the method shape.
 */
export interface TelephonyPort {
  capabilities(input: { tenantId: string }): TelephonyCapabilities
  dial(input: TelephonyDialInput): Promise<void>
  answer(input: TelephonyCommandInput): Promise<void>
  reject(input: TelephonyCommandInput): Promise<void>
  hangup(input: TelephonyHangupInput): Promise<void>
  transferToOwner(input: TelephonyTransferInput): Promise<void>
  subscribe(listener: TelephonyListener): () => void
}
