/** Minimal mono PCM16 WAV writer/reader for spike fixtures and listen-back files. */

export function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataSize = pcm.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  Buffer.from(pcm.buffer, pcm.byteOffset, dataSize).copy(buffer, 44)
  return buffer
}

export function parseWavPcm16(buffer: Buffer): { sampleRate: number; pcm: Int16Array } {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV file')
  const channels = buffer.readUInt16LE(22)
  const sampleRate = buffer.readUInt32LE(24)
  const bits = buffer.readUInt16LE(34)
  const dataIndex = buffer.indexOf(Buffer.from('data'), 36)
  if (dataIndex < 0) throw new Error('WAV data chunk missing')
  const size = buffer.readUInt32LE(dataIndex + 4)
  const samples = buffer.subarray(dataIndex + 8, dataIndex + 8 + size)
  if (bits !== 16 || channels !== 1) throw new Error('expected mono 16-bit WAV')
  return { sampleRate, pcm: new Int16Array(samples.buffer, samples.byteOffset, samples.length / 2) }
}
