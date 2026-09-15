import { describe, expect, it } from 'vitest'
import { describeVoiceSessionPortContract } from '@mishu/adapters-mock/contract-tests'
import { MockVoiceSession } from '@mishu/adapters-mock/voice'
import type { VoiceSessionEvent } from '@mishu/core/ports'

describeVoiceSessionPortContract(() => new MockVoiceSession(), {
  formats: ['pcmu-8k', 'pcm24k', 'webrtc-sdp'],
  capabilities: {
    sdp: true,
    websocketFrames: true,
    localOnly: false,
    fallbackVoicemail: true,
    discardPlayback: true
  }
})

describe('MockVoiceSession', () => {
  const target = { tenantId: 'local', callId: 'call_a' }

  it('supports pcmu-8k, pcm24k, and a trivial webrtc-sdp answer', async () => {
    const pcmu = new MockVoiceSession()
    expect(pcmu.capabilities).toEqual({
      sdp: true,
      websocketFrames: true,
      localOnly: false,
      fallbackVoicemail: true,
      discardPlayback: true
    })
    const framed = await pcmu.start({
      ...target,
      format: 'pcmu-8k',
      instructions: 'Be brief.',
      voice: 'marin'
    })
    expect(framed.sdp).toBeUndefined()

    const pcm = new MockVoiceSession()
    await pcm.start({
      ...target,
      callId: 'call_pcm',
      format: 'pcm24k',
      instructions: 'Be brief.',
      voice: 'marin'
    })

    const webrtc = new MockVoiceSession()
    const sdp = await webrtc.start({
      ...target,
      callId: 'call_sdp',
      format: 'webrtc-sdp',
      instructions: 'Be brief.',
      voice: 'marin',
      sdp: 'v=0'
    })
    expect(sdp.sdp).toContain('v=0')
  })

  it('replays scripted caller and assistant transcripts with final flags', async () => {
    const port = new MockVoiceSession()
    const events: VoiceSessionEvent[] = []
    port.subscribe((event) => events.push(event))
    await port.start({
      ...target,
      format: 'pcmu-8k',
      instructions: 'Be brief.',
      voice: 'marin',
      openingLine: 'Hello.'
    })
    port.scriptAssistantReply(target, 'Goodbye.')
    port.emitCallerTranscript(target, 'Goodbye')
    expect(events.filter((event) => event.type === 'transcript')).toEqual([
      expect.objectContaining({ role: 'assistant', delta: 'Hello.', final: false }),
      expect.objectContaining({ role: 'assistant', text: 'Hello.', final: true }),
      expect.objectContaining({ role: 'caller', delta: 'Goodbye', final: false }),
      expect.objectContaining({ role: 'caller', text: 'Goodbye', final: true }),
      expect.objectContaining({ role: 'assistant', delta: 'Goodbye.', final: false }),
      expect.objectContaining({ role: 'assistant', text: 'Goodbye.', final: true })
    ])
    expect(events.some((event) => event.type === 'turnIdle')).toBe(true)
  })

  it('records discardPlayback and appendFallbackVoicemail', async () => {
    const port = new MockVoiceSession()
    await port.start({
      ...target,
      format: 'pcm24k',
      instructions: 'Be brief.',
      voice: 'marin'
    })
    port.discardPlayback(target)
    port.appendFallbackVoicemail(target)
    expect(port.discardedPlayback).toEqual([expect.objectContaining(target)])
    expect(port.fallbackVoicemail).toEqual([expect.objectContaining(target)])
  })
})
