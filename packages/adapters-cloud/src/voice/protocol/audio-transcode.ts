/**
 * Twilio Media Streams is always G.711 μ-law 8 kHz 20 ms frames.
 * GPT-Live WebSocket `session.audio.format` (accessed 2026-09-13):
 *   { type: 'audio/pcmu', rate: 8000 }
 *   { type: 'audio/pcm', rate: 24000 }  // default in the official WS docs
 * Field name is `session.audio.format` with `{ type, rate }`.
 */
import {
  FRAME_DURATION_MS,
  MULAW_BYTES_PER_FRAME,
  MULAW_SAMPLE_RATE,
  mulawToPcm16,
  pcm16ToMulaw
} from './mulaw.js'

export type LiveAudioFormatName = 'pcmu' | 'pcm24k'

export const PCM24K_RATE = 24_000
export const PCM24K_SAMPLES_PER_FRAME = (PCM24K_RATE * FRAME_DURATION_MS) / 1_000
export const PCM24K_BYTES_PER_FRAME = PCM24K_SAMPLES_PER_FRAME * 2

export function parseAudioFormat(value: string | undefined): LiveAudioFormatName {
  if (value === undefined || value === 'pcmu') return 'pcmu'
  if (value === 'pcm24k') return 'pcm24k'
  throw new Error('audio format must be pcmu or pcm24k')
}

export function gptLiveAudioFormat(name: LiveAudioFormatName): { type: 'audio/pcmu' | 'audio/pcm'; rate: number } {
  return name === 'pcm24k'
    ? { type: 'audio/pcm', rate: PCM24K_RATE }
    : { type: 'audio/pcmu', rate: MULAW_SAMPLE_RATE }
}

export function resamplePcm16(pcm: Int16Array, sourceRate: number, targetRate: number): Int16Array {
  if (sourceRate === targetRate) return pcm
  const outLength = Math.max(1, Math.round(pcm.length * targetRate / sourceRate))
  const out = new Int16Array(outLength)
  const ratio = sourceRate / targetRate
  for (let i = 0; i < outLength; i++) {
    const src = i * ratio
    const left = Math.min(pcm.length - 1, Math.floor(src))
    const right = Math.min(pcm.length - 1, left + 1)
    const frac = src - left
    out[i] = Math.round(pcm[left]! * (1 - frac) + pcm[right]! * frac)
  }
  return out
}

export function mulawFrameToPcm24kBase64(mulawFrame: Buffer): string {
  const pcm8k = mulawToPcm16(mulawFrame)
  const pcm24k = resamplePcm16(pcm8k, MULAW_SAMPLE_RATE, PCM24K_RATE)
  return Buffer.from(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength).toString('base64')
}

export class Pcm24kOutboundAssembler {
  private pending = Buffer.alloc(0)

  reset(): void {
    this.pending = Buffer.alloc(0)
  }

  /** Convert a GPT-Live PCM16 24 kHz delta into 20 ms μ-law Twilio frames. */
  pushDelta(deltaBase64: string): string[] {
    let bytes: Buffer
    try { bytes = Buffer.from(deltaBase64, 'base64') } catch { return [] }
    if (bytes.length % 2 === 1) bytes = bytes.subarray(0, bytes.length - 1)
    this.pending = Buffer.concat([this.pending, bytes])
    const frames: string[] = []
    while (this.pending.length >= PCM24K_BYTES_PER_FRAME) {
      const copy = Buffer.from(this.pending.subarray(0, PCM24K_BYTES_PER_FRAME))
      this.pending = this.pending.subarray(PCM24K_BYTES_PER_FRAME)
      const pcm24k = new Int16Array(copy.buffer, copy.byteOffset, PCM24K_SAMPLES_PER_FRAME)
      const pcm8k = resamplePcm16(pcm24k, PCM24K_RATE, MULAW_SAMPLE_RATE)
      const mulaw = pcm16ToMulaw(pcm8k)
      if (mulaw.length === MULAW_BYTES_PER_FRAME) frames.push(mulaw.toString('base64'))
    }
    return frames
  }
}
