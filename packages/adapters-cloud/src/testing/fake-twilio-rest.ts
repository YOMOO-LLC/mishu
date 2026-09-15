import type {
  CreateOwnerCallInput,
  CreateOwnerParticipantInput,
  CreatedParticipant,
  TwilioRestPort
} from '../telephony/twilio-rest-port.js'

export class FakeTwilioRest implements TwilioRestPort {
  readonly created: CreateOwnerParticipantInput[] = []
  readonly outboundCalls: CreateOwnerCallInput[] = []
  readonly twimlUpdates: Array<{ callSid: string; twiml: string }> = []
  readonly ended: string[] = []
  failCreate = false
  failUpdate = false
  failEnd = false
  nextCallSid = 'CAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  private readonly participants = new Map<string, string[]>()

  participantsIn(conferenceName: string): string[] {
    return [...(this.participants.get(conferenceName) ?? [])]
  }

  async createOwnerParticipant(input: CreateOwnerParticipantInput): Promise<CreatedParticipant> {
    this.created.push(input)
    if (this.failCreate) throw new Error('create failed')
    this.addParticipant(input.conferenceName, this.nextCallSid)
    return { callSid: this.nextCallSid, conferenceSid: 'CFcccccccccccccccccccccccccccccccc' }
  }

  async createOwnerCall(input: CreateOwnerCallInput): Promise<CreatedParticipant> {
    this.outboundCalls.push(input)
    if (this.failCreate) throw new Error('create failed')
    return { callSid: this.nextCallSid }
  }

  async updateCallTwiml(callSid: string, twiml: string): Promise<void> {
    this.twimlUpdates.push({ callSid, twiml })
    if (this.failUpdate) throw new Error('update failed')
    const conferenceName = conferenceNameFromTwiml(twiml)
    if (conferenceName) this.addParticipant(conferenceName, callSid)
  }

  async endCall(callSid: string): Promise<void> {
    this.ended.push(callSid)
    if (this.failEnd) throw new Error('end failed')
  }

  private addParticipant(conferenceName: string, callSid: string): void {
    const list = this.participants.get(conferenceName) ?? []
    if (!list.includes(callSid)) list.push(callSid)
    this.participants.set(conferenceName, list)
  }
}

function conferenceNameFromTwiml(twiml: string): string | undefined {
  const match = /<Conference\b[^>]*>([^<]*)<\/Conference>/.exec(twiml)
  const name = match?.[1]?.trim()
  return name || undefined
}
