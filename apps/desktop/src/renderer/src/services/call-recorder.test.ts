import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CallRecorder,
  type RecordingChunk,
  type RecordingTransport
} from './call-recorder'

class FakeTransport implements RecordingTransport {
  readonly starts: string[] = []
  readonly chunks: RecordingChunk[] = []
  readonly finishes: Array<{ callId: string; durationMs: number }> = []
  async start(callId: string, _mime: string): Promise<void> {
    this.starts.push(callId)
  }
  async chunk(callId: string, seq: number, data: Uint8Array): Promise<void> {
    this.chunks.push({ callId, seq, data })
  }
  async finish(callId: string, durationMs: number): Promise<void> {
    this.finishes.push({ callId, durationMs })
  }
}

class FakeMediaStream {
  tracks: Array<{ readyState: string; id: string }>
  constructor() {
    this.tracks = []
  }
  getAudioTracks() {
    return this.tracks
  }
  getTracks() {
    return this.tracks
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeAudioContext {
  state = 'running'
  source?: { stream?: FakeMediaStream; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
  mergeInputs: Array<FakeMediaStream | undefined> = [undefined, undefined]
  destination?: { stream: FakeMediaStream }
  readonly resume = vi.fn().mockResolvedValue(undefined)

  createMediaStreamSource(stream: MediaStream) {
    this.source = {
      stream: stream as unknown as FakeMediaStream,
      connect: vi.fn(),
      disconnect: vi.fn()
    }
    return this.source as unknown as MediaStreamAudioSourceNode
  }

  createChannelMerger(count: number) {
    this.mergeInputs = Array.from({ length: count }, () => undefined)
    return {
      connect: vi.fn((node: { stream: FakeMediaStream }) => {
        this.destination = node
      }),
      disconnect: vi.fn(),
      inputCount: count
    } as unknown as ChannelMergerNode
  }

  createMediaStreamDestination() {
    const stream = new FakeMediaStream()
    stream.tracks.push({ readyState: 'live', id: 'dest-track' })
    this.destination = { stream }
    return { stream, disconnect: vi.fn() } as unknown as MediaStreamAudioDestinationNode
  }

  createGain() {
    return {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn()
    } as unknown as GainNode
  }

  async close(): Promise<void> {
    this.state = 'closed'
  }
}

class FakeMediaRecorder {
  readonly started: boolean
  readonly stopped: boolean
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  static isTypeSupported = vi.fn((_type: string) => true)

  constructor(public readonly stream: MediaStream, public readonly options: MediaRecorderOptions) {
    this.started = false
    this.stopped = false
  }

  start(_timeslice?: number): void {}
  stop(): void {
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(['final']) })
    }
    if (this.onstop) this.onstop()
  }
}

describe('CallRecorder', () => {
  let transport: FakeTransport
  let audioContext: FakeAudioContext
  let mediaStream: FakeMediaStream
  let recorder: CallRecorder
  let mediaRecorder: FakeMediaRecorder

  const callerStream = new FakeMediaStream()
  const assistantStream = new FakeMediaStream()

  beforeEach(() => {
    callerStream.tracks = [{ readyState: 'live', id: 'caller' }]
    assistantStream.tracks = []
    mediaStream = new FakeMediaStream()
    mediaStream.tracks.push({ readyState: 'live', id: 'dest' })
    audioContext = new FakeAudioContext()
    transport = new FakeTransport()
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.stubGlobal('MediaStreamAudioSourceNode', class {})
    vi.stubGlobal('MediaStreamAudioDestinationNode', class {})
    vi.stubGlobal('ChannelMergerNode', class {})
    vi.stubGlobal('GainNode', class {})
    mediaRecorder = new FakeMediaRecorder(mediaStream as unknown as MediaStream, {})
    vi.stubGlobal('MediaRecorder', class extends FakeMediaRecorder {})
    recorder = new CallRecorder({
      transport,
      mediaRecorderFactory: (stream, options) => {
        const instance = new FakeMediaRecorder(stream, options)
        mediaRecorder = instance
        return instance as unknown as MediaRecorder
      },
      audioContextFactory: () => audioContext as unknown as AudioContext,
      now: () => 1000
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts and stops exactly once across active->ended, and finishes with duration', async () => {
    await recorder.start('call-1', callerStream as unknown as MediaStream)
    await recorder.start('call-1', callerStream as unknown as MediaStream)

    expect(transport.starts).toEqual(['call-1'])

    await recorder.stop()

    expect(transport.finishes).toHaveLength(1)
    expect(transport.finishes[0]).toEqual({ callId: 'call-1', durationMs: 0 })
  })

  it('sends chunks in increasing seq order', async () => {
    await recorder.start('call-1', callerStream as unknown as MediaStream)

    mediaRecorder.ondataavailable?.({ data: new Blob(['one']) })
    await Promise.resolve()
    mediaRecorder.ondataavailable?.({ data: new Blob(['two']) })
    await Promise.resolve()
    await recorder.stop()

    expect(transport.chunks.map(({ seq }) => seq)).toEqual([0, 1, 2])
    expect(transport.chunks[0].callId).toBe('call-1')
  })

  it('accepts the assistant stream arriving mid-call without restarting recording', async () => {
    await recorder.start('call-1', callerStream as unknown as MediaStream)
    recorder.setAssistantStream(assistantStream as unknown as MediaStream)

    expect(transport.starts).toEqual(['call-1'])

    await recorder.stop()

    expect(transport.finishes).toHaveLength(1)
  })

  it('uses the first supported mime type from the candidate list', async () => {
    const candidate = 'audio/webm;codecs=opus'
    vi.stubGlobal('MediaRecorder', class {
      static isTypeSupported = vi.fn((type: string) => type === candidate)
      ondataavailable: unknown = null
      onstop: unknown = null
      constructor(public stream: MediaStream, public options: MediaRecorderOptions) {}
      start(): void {}
      stop(): void {}
    })

    await recorder.start('call-1', callerStream as unknown as MediaStream)
    await recorder.stop()

    expect(mediaRecorder.options.mimeType).toBe(candidate)
    expect(transport.starts).toEqual(['call-1'])
  })

  it('ignores repeated start for the same callId without emitting a second start', async () => {
    await recorder.start('call-1', callerStream as unknown as MediaStream)
    await recorder.start('call-1', callerStream as unknown as MediaStream)
    await recorder.start('call-1', callerStream as unknown as MediaStream)

    expect(transport.starts).toEqual(['call-1'])
    await recorder.stop()
    expect(transport.finishes).toHaveLength(1)
  })
})