export {
  ADR_HANDOFF_LIVE_ALIASES,
  type CallerMoveClaim,
  type CompletedLegAction,
  type HandoffCause,
  type HandoffLeg,
  type HandoffMachineRecord,
  type HandoffParty,
  type HandoffState,
  type MoveSkipReason,
  type OwnerEndpoint,
  type OwnerEndpointKind
} from './handoff/types.js'

export {
  canApplyOwnerJoined,
  ownerAcceptsOnAnswered,
  ownerAcceptsOnJoined,
  ownerEndpointTo,
  ownerRequiresGatherConfirm,
  parseOwnerEndpoint
} from './handoff/endpoint.js'

export {
  applyFallbackIntent,
  casHandoffTransition,
  claimCallerMove,
  completeCallerMove,
  hasBridgedHandoff,
  initialHandoffMachine,
  isActiveHandoffProgress,
  isTerminalHandoffState,
  moveSkipReason,
  resolveLiveHandoffState,
  shouldFireHandoffDeadline,
  transitionHandoff
} from './handoff/machine.js'

export { classifyHandoffLeg, interpretCompletedLeg } from './handoff/observation.js'
