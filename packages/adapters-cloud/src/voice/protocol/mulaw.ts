/** G.711 μ-law helpers for 8 kHz mono telephony frames. */

export const MULAW_SAMPLE_RATE = 8_000
export const FRAME_DURATION_MS = 20
export const MULAW_BYTES_PER_FRAME = (MULAW_SAMPLE_RATE * FRAME_DURATION_MS) / 1_000
export const MULAW_SILENCE_BYTE = 0xff

const BIAS = 0x84
const CLIP = 32_635

export function linearToMulaw(sample: number): number {
  let sign = (sample >> 8) & 0x80
  if (sign !== 0) sample = -sample
  if (sample > CLIP) sample = CLIP
  sample += BIAS
  let exponent = 7
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) { /* find exponent */ }
  const mantissa = (sample >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

export function mulawToLinear(mulaw: number): number {
  mulaw = ~mulaw & 0xff
  const sign = mulaw & 0x80
  const exponent = (mulaw >> 4) & 0x07
  const mantissa = mulaw & 0x0f
  let sample = ((mantissa << 3) + BIAS) << exponent
  sample -= BIAS
  return sign !== 0 ? -sample : sample
}

export function pcm16ToMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]!)
  return out
}

export function mulawToPcm16(bytes: Buffer): Int16Array {
  const pcm = new Int16Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) pcm[i] = mulawToLinear(bytes[i]!)
  return pcm
}

export function splitMulawFrames(bytes: Buffer, frameSize = MULAW_BYTES_PER_FRAME): Buffer[] {
  const frames: Buffer[] = []
  for (let offset = 0; offset + frameSize <= bytes.length; offset += frameSize) {
    frames.push(bytes.subarray(offset, offset + frameSize))
  }
  return frames
}

export function synthesizeToneMulaw(options: {
  frequencyHz: number
  durationMs: number
  amplitude?: number
}): Buffer {
  const samples = Math.round((options.durationMs / 1_000) * MULAW_SAMPLE_RATE)
  const amplitude = options.amplitude ?? 8_000
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * options.frequencyHz * i) / MULAW_SAMPLE_RATE))
  }
  return pcm16ToMulaw(pcm)
}

export function silenceMulaw(durationMs: number): Buffer {
  return Buffer.alloc(Math.round((durationMs / 1_000) * MULAW_SAMPLE_RATE), MULAW_SILENCE_BYTE)
}

export function mulawRms(frame: Buffer): number {
  const pcm = mulawToPcm16(frame)
  if (pcm.length === 0) return 0
  let sum = 0
  for (const sample of pcm) sum += sample * sample
  return Math.sqrt(sum / pcm.length)
}

export function isSpeechFrame(frame: Buffer, threshold = 400): boolean {
  return mulawRms(frame) >= threshold
}

export function resamplePcm16To8k(pcm: Int16Array, sourceRate: number): Int16Array {
  if (sourceRate === MULAW_SAMPLE_RATE) return pcm
  const outLength = Math.max(1, Math.round(pcm.length * MULAW_SAMPLE_RATE / sourceRate))
  const out = new Int16Array(outLength)
  const ratio = sourceRate / MULAW_SAMPLE_RATE
  for (let i = 0; i < outLength; i++) {
    const src = i * ratio
    const left = Math.min(pcm.length - 1, Math.floor(src))
    const right = Math.min(pcm.length - 1, left + 1)
    const frac = src - left
    out[i] = Math.round(pcm[left]! * (1 - frac) + pcm[right]! * frac)
  }
  return out
}
