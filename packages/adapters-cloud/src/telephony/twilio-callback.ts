import { classifyHandoffLeg, type HandoffLeg } from '@mishu/core/handoff'
import { redactText } from '../voice/protocol/redact.js'

export type TwilioCallbackKind = 'call' | 'conference' | 'gather'
export type TwilioCallbackLeg = HandoffLeg

export interface ClassifiedTwilioCallback {
  kind: TwilioCallbackKind
  event: string
  leg: TwilioCallbackLeg
}

/** Twilio sends long names on the webhook; create/TwiML subscribe with the short names. */
const CONFERENCE_EVENT_ALIASES: Record<string, string> = {
  join: 'join',
  'participant-join': 'join',
  leave: 'leave',
  'participant-leave': 'leave',
  start: 'start',
  'conference-start': 'start',
  end: 'end',
  'conference-end': 'end',
  mute: 'mute',
  'participant-mute': 'mute',
  'participant-unmute': 'mute',
  hold: 'hold',
  'participant-hold': 'hold',
  'participant-unhold': 'hold',
  modify: 'modify',
  'participant-modify': 'modify',
  speaker: 'speaker',
  'participant-speech-start': 'speaker',
  'participant-speech-stop': 'speaker',
  announcement: 'announcement',
  'announcement-end': 'announcement',
  'announcement-fail': 'announcement'
}

export function normalizeConferenceStatusEvent(statusCallbackEvent: string): string | undefined {
  return CONFERENCE_EVENT_ALIASES[statusCallbackEvent]
}

export function classifyTwilioCallback(
  pathname: string,
  form: URLSearchParams,
  ids: { ownerCallSid?: string; callerCallSid?: string }
): ClassifiedTwilioCallback {
  const callSid = form.get('CallSid') ?? ''
  const leg: TwilioCallbackLeg = classifyHandoffLeg(callSid, {
    ownerCallRef: ids.ownerCallSid,
    callerCallRef: ids.callerCallSid
  })
  if (pathname.endsWith('/twilio/gather')) {
    return { kind: 'gather', event: form.get('Digits') ? 'digits' : 'timeout', leg }
  }
  const statusEvent = form.get('StatusCallbackEvent') ?? ''
  const conferenceSid = form.get('ConferenceSid') ?? ''
  const conferenceEvent = normalizeConferenceStatusEvent(statusEvent)
  if (conferenceSid !== '' || conferenceEvent !== undefined) {
    return { kind: 'conference', event: conferenceEvent ?? (statusEvent || 'conference'), leg }
  }
  return { kind: 'call', event: statusEvent || form.get('CallStatus') || 'call', leg }
}

export function redactHandoffId(id: string): string {
  if (!id) return 'unknown'
  const scrubbed = redactText(id)
  if (scrubbed.length <= 4) return `${scrubbed.slice(0, 1)}…`
  return `${scrubbed.slice(0, 2)}…${scrubbed.slice(-2)}`
}

export function formatTwilioCallbackLog(input: ClassifiedTwilioCallback & {
  handoffId: string
  signatureFailed?: boolean
}): string {
  const prefix = input.signatureFailed ? 'twilio-callback: signature-failed' : 'twilio-callback:'
  return `${prefix} kind=${input.kind} event=${input.event} leg=${input.leg} handoff=${redactHandoffId(input.handoffId)}`
}
