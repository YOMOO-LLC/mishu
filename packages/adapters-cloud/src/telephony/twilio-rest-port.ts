/** Participant call events. Twilio defaults StatusCallbackEvent to `completed` only. */
export const OWNER_STATUS_CALLBACK_EVENTS = ['initiated', 'ringing', 'answered', 'completed'] as const

/** Conference events. Twilio defaults ConferenceStatusCallbackEvent to `start end` (no join). */
export const CONFERENCE_STATUS_CALLBACK_EVENTS = ['start', 'join', 'leave', 'end'] as const

/** Empty wait URL silences default classical hold music while a conference has one participant. */
export const CONFERENCE_SILENCE_WAIT_URL = ''

export interface CreateOwnerParticipantInput {
  conferenceName: string
  from: string
  to: string
  timeoutSec: number
  label: string
  statusCallback?: string
  statusCallbackEvent?: readonly string[]
  conferenceStatusCallback?: string
  conferenceStatusCallbackEvent?: readonly string[]
  waitUrl?: string
  startConferenceOnEnter?: boolean
  endConferenceOnExit?: boolean
}

export interface CreatedParticipant {
  callSid: string
  conferenceSid?: string
}

export interface CreateOwnerCallInput {
  from: string
  to: string
  twiml: string
  timeoutSec: number
  statusCallback?: string
  statusCallbackEvent?: readonly string[]
}

export interface TwilioRestPort {
  createOwnerParticipant(input: CreateOwnerParticipantInput): Promise<CreatedParticipant>
  createOwnerCall(input: CreateOwnerCallInput): Promise<CreatedParticipant>
  updateCallTwiml(callSid: string, twiml: string): Promise<void>
  endCall(callSid: string): Promise<void>
}

export type OwnerEndpoint = { kind: 'client'; identity: string } | { kind: 'pstn'; number: string }

export function parseOwnerEndpoint(value: string): OwnerEndpoint | undefined {
  if (/^client:[A-Za-z0-9_-]{1,121}$/.test(value)) {
    return { kind: 'client', identity: value.slice('client:'.length) }
  }
  if (/^\+[1-9]\d{6,14}$/.test(value)) return { kind: 'pstn', number: value }
  return undefined
}

export function ownerEndpointTo(value: OwnerEndpoint): string {
  return value.kind === 'client' ? `client:${value.identity}` : value.number
}
