/** T12.16 Telephony/Handoff adapter. REST + Conference production subset lives here. */
export const ADAPTERS_CLOUD_TELEPHONY_TASK = 'T12.16'

export {
  OWNER_STATUS_CALLBACK_EVENTS,
  CONFERENCE_STATUS_CALLBACK_EVENTS,
  CONFERENCE_SILENCE_WAIT_URL,
  parseOwnerEndpoint,
  ownerEndpointTo,
  type CreateOwnerParticipantInput,
  type CreateOwnerCallInput,
  type CreatedParticipant,
  type TwilioRestPort,
  type OwnerEndpoint
} from './telephony/twilio-rest-port.js'
export {
  ConferenceHandoffController,
  redactOwner,
  type OwnerStatus,
  type HandoffParty,
  type HandoffSnapshot,
  type HandoffControllerOptions
} from './telephony/conference-controller.js'
export type { HandoffCause, HandoffState } from './telephony/conference-controller.js'
export {
  classifyTwilioCallback,
  formatTwilioCallbackLog,
  normalizeConferenceStatusEvent,
  redactHandoffId,
  type TwilioCallbackKind,
  type TwilioCallbackLeg,
  type ClassifiedTwilioCallback
} from './telephony/twilio-callback.js'
export {
  publicRequestUrl,
  validateTwilioSignature,
  websocketRequestUrl,
  validateUpgradeSignature,
  expectedTwilioSignature,
  type UpgradeRejectReason,
  type UpgradeSignatureResult
} from './telephony/signature.js'
export { twilioSdkRestPort } from './telephony/twilio-rest-adapter.js'
export { TwilioRestTelephonyAdapter } from './telephony/telephony-port.js'
