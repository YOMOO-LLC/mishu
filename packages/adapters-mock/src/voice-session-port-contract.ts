import { describe, expect, it } from 'vitest'
import type {
  VoiceAudioFormat,
  VoiceSessionCapabilities,
  VoiceSessionEvent,
  VoiceSessionPort,
  VoiceSessionStartInput
} from '@mishu/core/ports'

export type VoiceSessionPortFactory = () => VoiceSessionPort | Promise<VoiceSessionPort>

export interface VoiceSessionPortContractOptions {
  formats?: VoiceAudioFormat[]
  capabilities?: VoiceSessionCapabilities
}

const TARGET = { tenantId: 'local', callId: 'call_voice' } as const
const ALL_FORMATS: readonly VoiceAudioFormat[] = ['pcmu-8k', 'pcm24k', 'webrtc-sdp']

function primaryFormat(
  port: VoiceSessionPort,
  options: VoiceSessionPortContractOptions
): VoiceAudioFormat {
  if (options.formats?.[0]) return options.formats[0]
  if (port.capabilities.websocketFrames) return 'pcmu-8k'
  return 'webrtc-sdp'
}

function startInput(
  format: VoiceAudioFormat,
  tenantId: string,
  callId = TARGET.callId
): VoiceSessionStartInput {
  return {
    tenantId,
    callId,
    format,
    instructions: 'Be brief.',
    voice: 'marin',
    ...(format === 'webrtc-sdp' ? { sdp: 'v=0' } : {})
  }
}

/**
 * Behavioural VoiceSessionPort contract: tenantId required, started then closed
 * ordering, and no events after closed. Pass `formats` / `capabilities` so the
 * helper uses a supported start format (never a hardcoded pcmu-8k) and skips
 * cases the adapter declared unsupported.
 */
export function describeVoiceSessionPortContract(
  makePort: VoiceSessionPortFactory,
  options: VoiceSessionPortContractOptions = {}
): void {
  const declaredFormats = options.formats
  const undeclaredFormats = declaredFormats
    ? ALL_FORMATS.filter((format) => !declaredFormats.includes(format))
    : undefined

  describe('VoiceSessionPort contract', () => {
    it('requires tenantId on every call', async () => {
      const port = await makePort()
      const format = primaryFormat(port, options)
      await expect(port.start(startInput(format, ''))).rejects.toThrow()
      expect(() => port.discardPlayback({ tenantId: '', callId: 'call_voice' })).toThrow()
      expect(() => port.appendFallbackVoicemail({ tenantId: '', callId: 'call_voice' })).toThrow()
      await expect(port.close({
        tenantId: '',
        callId: 'call_voice',
        reason: 'done'
      })).rejects.toThrow()
    })

    it('emits started then closed, and drops events after closed', async () => {
      const port = await makePort()
      const format = primaryFormat(port, options)
      const events: VoiceSessionEvent[] = []
      port.subscribe((event) => events.push(event))
      const started = await port.start(startInput(format, TARGET.tenantId))
      expect(started.sessionId).toBeTruthy()
      expect(events.some((event) => event.type === 'started' && event.sessionId === started.sessionId)).toBe(true)
      await port.close({ ...TARGET, reason: 'done' })
      const closedAt = events.findIndex((event) => event.type === 'closed')
      expect(closedAt).toBeGreaterThanOrEqual(0)
      expect(events[closedAt]).toMatchObject({ type: 'closed', reason: 'done', callId: TARGET.callId })
      const afterClose = events.length
      await port.close({ ...TARGET, reason: 'again' })
      expect(events).toHaveLength(afterClose)
      expect(events.slice(closedAt + 1)).toEqual([])
    })

    if (undeclaredFormats === undefined) {
      it.skip('skips undeclared start formats (pass formats to enable)')
    } else if (undeclaredFormats.length > 0) {
      it.skip(
        `start in ${undeclaredFormats.join('/')} (adapter does not declare ${undeclaredFormats.join(', ')})`
      )
    }

    if (options.capabilities?.discardPlayback === false) {
      it.skip('discardPlayback drops queued audio (adapter declares discardPlayback: false; desktop barge-in is renderer-side)')
    } else if (options.capabilities?.discardPlayback) {
      it('accepts discardPlayback on a live session', async () => {
        const port = await makePort()
        const format = primaryFormat(port, options)
        await port.start(startInput(format, TARGET.tenantId))
        expect(() => port.discardPlayback(TARGET)).not.toThrow()
        await port.close({ ...TARGET, reason: 'done' })
      })
    } else {
      it.skip('discardPlayback drops queued audio (pass capabilities.discardPlayback to enable)')
    }
  })
}
