import type { CreateOwnerCallInput, CreateOwnerParticipantInput, CreatedParticipant, TwilioRestPort } from './twilio-rest-port.js'

type TwilioCalls = ((sid: string) => {
  update: (input: { twiml?: string; status?: string }) => Promise<unknown>
}) & {
  create: (input: {
    from: string
    to: string
    twiml: string
    timeout?: number
    statusCallback?: string
    statusCallbackEvent?: string[]
  }) => Promise<{ sid: string }>
}

/** Wraps an already-constructed Twilio SDK client. Callers must only construct that client after paid confirmation. */
export function twilioSdkRestPort(client: {
  conferences: (sidOrName: string) => {
    participants: {
      create: (input: {
        from: string
        to: string
        timeout?: number
        label?: string
        statusCallback?: string
        statusCallbackEvent?: string[]
        conferenceStatusCallback?: string
        conferenceStatusCallbackEvent?: string[]
        waitUrl?: string
        beep?: string
        startConferenceOnEnter?: boolean
        endConferenceOnExit?: boolean
      }) => Promise<{ callSid: string; conferenceSid?: string }>
    }
  }
  calls: TwilioCalls
}): TwilioRestPort {
  return {
    async createOwnerParticipant(input: CreateOwnerParticipantInput): Promise<CreatedParticipant> {
      const participant = await client.conferences(input.conferenceName).participants.create({
        from: input.from,
        to: input.to,
        timeout: input.timeoutSec,
        label: input.label,
        statusCallback: input.statusCallback,
        statusCallbackEvent: input.statusCallbackEvent ? [...input.statusCallbackEvent] : undefined,
        conferenceStatusCallback: input.conferenceStatusCallback,
        conferenceStatusCallbackEvent: input.conferenceStatusCallbackEvent
          ? [...input.conferenceStatusCallbackEvent]
          : undefined,
        waitUrl: input.waitUrl,
        beep: 'false',
        startConferenceOnEnter: input.startConferenceOnEnter ?? true,
        endConferenceOnExit: input.endConferenceOnExit ?? true
      })
      return { callSid: participant.callSid, conferenceSid: participant.conferenceSid }
    },
    async createOwnerCall(input: CreateOwnerCallInput): Promise<CreatedParticipant> {
      const created = await client.calls.create({
        from: input.from,
        to: input.to,
        twiml: input.twiml,
        timeout: input.timeoutSec,
        statusCallback: input.statusCallback,
        statusCallbackEvent: input.statusCallbackEvent ? [...input.statusCallbackEvent] : undefined
      })
      return { callSid: created.sid }
    },
    async updateCallTwiml(callSid: string, twiml: string): Promise<void> {
      await client.calls(callSid).update({ twiml })
    },
    async endCall(callSid: string): Promise<void> {
      await client.calls(callSid).update({ status: 'completed' })
    }
  }
}
