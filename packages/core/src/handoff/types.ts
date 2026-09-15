/**
 * Handoff domain types for @mishu/core/handoff.
 *
 * Live states follow the current Conference controller. ADR-0002 also names
 * `owner_notified`; that name is accepted as an alias of post-request
 * `requested` and is not a distinct live state today.
 */

export type HandoffState =
  | 'requested'
  | 'owner_notified'
  | 'owner_ringing'
  | 'accepted'
  | 'connecting'
  | 'connected'
  | 'completed'
  | 'declined'
  | 'timed_out'
  | 'failed'
  | 'fallback_message'
  | 'cancelled'

export type HandoffCause =
  | 'completed'
  | 'declined'
  | 'timed_out'
  | 'failed'
  | 'cancelled'
  | 'duplicate'

export type HandoffParty = 'owner' | 'caller'

export type HandoffLeg = 'owner' | 'caller' | 'unknown'

export type MoveSkipReason = 'already_moving' | 'already_connected'

export type OwnerEndpoint =
  | { kind: 'client'; identity: string }
  | { kind: 'pstn'; number: string }
  | { kind: 'local_takeover' }

export type OwnerEndpointKind = OwnerEndpoint['kind']

/**
 * ADR-0002 inserts `owner_notified` after `requested`. The live machine keeps
 * `requested` until ringing, so the ADR name aliases the current live state.
 */
export const ADR_HANDOFF_LIVE_ALIASES = {
  owner_notified: 'requested'
} as const satisfies Record<'owner_notified', HandoffState>

export interface HandoffMachineRecord {
  tenantId?: string
  handoffId?: string
  version: number
  state: HandoffState
  cause?: HandoffCause
  callerMovedToConference: boolean
  fallbackMessage?: boolean
}

export type CallerMoveClaim =
  | { claimed: true; version: number }
  | { claimed: false; reason: MoveSkipReason | 'not_accepted' }

export type CompletedLegAction = 'owner_gone' | 'owner_declined' | 'caller_gone' | 'ignore'
