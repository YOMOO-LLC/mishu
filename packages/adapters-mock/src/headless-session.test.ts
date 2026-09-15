import { describe, expect, it } from 'vitest'
import { FakeClock } from '@mishu/adapters-mock/clock'
import { MockTelephony } from '@mishu/adapters-mock/telephony'
import { MockVoiceSession } from '@mishu/adapters-mock/voice'
import {
  applyFallbackIntent,
  casHandoffTransition,
  initialHandoffMachine,
  shouldFireHandoffDeadline,
  type HandoffMachineRecord
} from '@mishu/core/handoff'
import { callerOnlyHangupHeuristic, type TranscriptTurn } from '@mishu/core/hangup'
import type { TelephonyObservation, VoiceSessionEvent } from '@mishu/core/ports'

const TENANT = 'local'
const PEER = '+15555550100'

function turnsFrom(events: VoiceSessionEvent[]): TranscriptTurn[] {
  return events.flatMap((event) => {
    if (event.type !== 'transcript' || !event.final || !event.text) return []
    return [{ role: event.role, text: event.text }]
  })
}

describe('headless mock session', () => {
  it('hangs up after a scripted inbound goodbye using core hangup decision', async () => {
    const clock = new FakeClock(0)
    const telephony = new MockTelephony({ clock })
    const voice = new MockVoiceSession({ clock })
    const phoneEvents: TelephonyObservation[] = []
    const voiceEvents: VoiceSessionEvent[] = []
    telephony.subscribe((observation) => phoneEvents.push(observation))
    voice.subscribe((event) => voiceEvents.push(event))

    const { callId } = telephony.simulateInbound({ tenantId: TENANT, peer: PEER })
    await telephony.answer({ tenantId: TENANT, callId, commandId: 'cmd-answer' })
    await voice.start({
      tenantId: TENANT,
      callId,
      format: 'pcmu-8k',
      instructions: 'Be brief.',
      voice: 'marin'
    })
    voice.scriptAssistantReply({ tenantId: TENANT, callId }, 'Goodbye.')
    voice.emitCallerTranscript({ tenantId: TENANT, callId }, 'Goodbye')

    const verdict = callerOnlyHangupHeuristic(turnsFrom(voiceEvents))
    expect(verdict).toEqual({ end: true, reason: 'caller_farewell' })
    await telephony.hangup({
      tenantId: TENANT,
      callId,
      commandId: 'cmd-hangup',
      reason: verdict.reason
    })
    await voice.close({ tenantId: TENANT, callId, reason: verdict.reason })

    expect(phoneEvents.map((event) => event.type)).toEqual(['ringing', 'connected', 'ended'])
    expect(voiceEvents.some((event) => event.type === 'closed')).toBe(true)
  })

  it('falls back to voicemail after 20s when the owner never joins, without hanging up the caller', async () => {
    const clock = new FakeClock(0)
    const telephony = new MockTelephony({ clock, ownerOutcome: 'timeout' })
    const voice = new MockVoiceSession({ clock })
    const phoneEvents: TelephonyObservation[] = []
    telephony.subscribe((observation) => phoneEvents.push(observation))

    const { callId } = telephony.simulateInbound({ tenantId: TENANT, peer: PEER, callId: 'call_xfer' })
    await telephony.answer({ tenantId: TENANT, callId, commandId: 'cmd-answer' })
    await voice.start({
      tenantId: TENANT,
      callId,
      format: 'pcm24k',
      instructions: 'Be brief.',
      voice: 'marin'
    })

    const handoff: HandoffMachineRecord = {
      tenantId: TENANT,
      handoffId: 'h-timeout',
      ...initialHandoffMachine()
    }
    await telephony.transferToOwner({
      tenantId: TENANT,
      callId,
      commandId: 'cmd-xfer',
      handoffId: 'h-timeout',
      owner: { kind: 'client', identity: 'owner' },
      timeoutSec: 20
    })
    expect(phoneEvents.some((event) => event.type === 'owner_ringing')).toBe(true)
    expect(shouldFireHandoffDeadline(handoff.state)).toBe(true)

    clock.advance(20_000)
    expect(phoneEvents.at(-1)).toMatchObject({ type: 'owner_failed', reason: 'timed_out' })

    const expectedVersion = handoff.version
    expect(casHandoffTransition(handoff, expectedVersion, 'requested', 'timed_out', 'timed_out')).toBe(true)
    expect(applyFallbackIntent(handoff)).toBe(true)
    expect(handoff).toMatchObject({
      state: 'fallback_message',
      fallbackMessage: true,
      callerMovedToConference: false
    })

    voice.appendFallbackVoicemail({ tenantId: TENANT, callId })
    expect(voice.fallbackVoicemail).toEqual([
      expect.objectContaining({ tenantId: TENANT, callId })
    ])
    expect(phoneEvents.some((event) => event.type === 'ended')).toBe(false)
  })
})
