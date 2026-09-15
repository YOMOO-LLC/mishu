const CANDIDATE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=opus',
  'audio/ogg;codecs=opus'
]
const MAX_CHUNK_DELAY_MS = 500

export interface RecordingChunk {
  callId: string
  seq: number
  data: Uint8Array
}

export interface RecordingTransport {
  start(callId: string, mime: string): Promise<void>
  chunk(callId: string, seq: number, data: Uint8Array): Promise<void>
  finish(callId: string, durationMs: number): Promise<void>
}

export interface CallRecorderOptions {
  transport: RecordingTransport
  mediaRecorderFactory?: (
    stream: MediaStream,
    options: MediaRecorderOptions
  ) => MediaRecorder
  audioContextFactory?: () => AudioContext
  now?: () => number
}

interface SourceConnection {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
}

export class CallRecorder {
  private readonly transport: RecordingTransport
  private readonly mediaRecorderFactory: (
    stream: MediaStream,
    options: MediaRecorderOptions
  ) => MediaRecorder
  private readonly audioContextFactory: () => AudioContext
  private readonly now: () => number

  private recordingCallId?: string
  private startedAt = 0
  private seq = 0
  private stopping = false
  private chunkQueue: Promise<void> = Promise.resolve()
  private context?: AudioContext
  private merger?: ChannelMergerNode
  private destination?: MediaStreamAudioDestinationNode
  private caller?: SourceConnection
  private assistant?: SourceConnection
  private mediaRecorder?: MediaRecorder

  constructor(options: CallRecorderOptions) {
    this.transport = options.transport
    this.mediaRecorderFactory =
      options.mediaRecorderFactory ??
      ((stream, mediaOptions) => new MediaRecorder(stream, mediaOptions))
    this.audioContextFactory = options.audioContextFactory ?? (() => new AudioContext())
    this.now = options.now ?? (() => Date.now())
  }

  async start(callId: string, callerStream?: MediaStream): Promise<void> {
    if (this.recordingCallId) return
    this.recordingCallId = callId
    this.startedAt = this.now()
    this.seq = 0
    this.chunkQueue = Promise.resolve()

    const context = this.audioContextFactory()
    this.context = context
    this.merger = context.createChannelMerger(2)
    this.destination = context.createMediaStreamDestination()
    this.merger.connect(this.destination)
    void context.resume()

    const mime = selectMimeType()
    this.mediaRecorder = this.mediaRecorderFactory(this.destination.stream, { mimeType: mime })
    const recorder = this.mediaRecorder
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return
      void this.sendChunk(event.data)
    }
    try {
      recorder.start(1_000)
    } catch {
      recorder.start()
    }
    await this.transport.start(callId, mime).catch(() => undefined)

    if (callerStream) this.setCallerStream(callerStream)
  }

  setCallerStream(stream: MediaStream): void {
    this.connectSource('caller', stream)
  }

  setAssistantStream(stream: MediaStream): void {
    this.connectSource('assistant', stream)
  }

  isRecording(): boolean {
    return this.recordingCallId !== undefined
  }

  async stop(): Promise<void> {
    const callId = this.recordingCallId
    if (!callId || this.stopping) return
    this.stopping = true
    const startedAt = this.startedAt
    const recorder = this.mediaRecorder

    if (recorder && recorder.state !== 'inactive') {
      const finalChunk = new Promise<void>((resolve) => {
        const original = recorder.ondataavailable
        recorder.ondataavailable = (event: BlobEvent) => {
          original?.call(recorder, event)
          resolve()
        }
        setTimeout(resolve, MAX_CHUNK_DELAY_MS)
        try {
          recorder.stop()
        } catch {
          resolve()
        }
      })
      await finalChunk
    }

    this.recordingCallId = undefined
    this.mediaRecorder = undefined
    this.stopping = false
    await this.chunkQueue.catch(() => undefined)
    this.teardownAudioGraph()

    const durationMs = Math.max(0, this.now() - startedAt)
    await this.transport.finish(callId, durationMs).catch(() => undefined)
  }

  dispose(): void {
    if (this.recordingCallId) {
      void this.stop()
    } else {
      this.teardownAudioGraph()
    }
  }

  private sendChunk(blob: Blob): void {
    const callId = this.recordingCallId
    if (!callId) return
    const seq = this.seq++
    this.chunkQueue = this.chunkQueue
      .then(async () => {
        const buffer = await blob.arrayBuffer()
        await this.transport.chunk(callId, seq, new Uint8Array(buffer))
      })
      .catch(() => undefined)
  }

  private connectSource(side: 'caller' | 'assistant', stream: MediaStream): void {
    const context = this.context
    const merger = this.merger
    if (!context || !merger) return

    const existing = side === 'caller' ? this.caller : this.assistant
    if (existing) {
      existing.source.disconnect()
      existing.stream.removeEventListener('addtrack', this.onTracksChanged)
      existing.stream.removeEventListener('removetrack', this.onTracksChanged)
    }

    const track = stream.getAudioTracks()[0]
    if (!track) return

    const source = context.createMediaStreamSource(stream)
    source.connect(merger, 0, side === 'caller' ? 0 : 1)
    const connection: SourceConnection = { stream, source }
    if (side === 'caller') this.caller = connection
    else this.assistant = connection
    stream.addEventListener('addtrack', this.onTracksChanged)
    stream.addEventListener('removetrack', this.onTracksChanged)
  }

  private onTracksChanged = (event: Event): void => {
    const stream = event.target as MediaStream
    if (stream === this.caller?.stream) this.setCallerStream(stream)
    if (stream === this.assistant?.stream) this.setAssistantStream(stream)
  }

  private teardownAudioGraph(): void {
    this.caller?.source.disconnect()
    this.caller?.stream.removeEventListener('addtrack', this.onTracksChanged)
    this.caller?.stream.removeEventListener('removetrack', this.onTracksChanged)
    this.assistant?.source.disconnect()
    this.assistant?.stream.removeEventListener('addtrack', this.onTracksChanged)
    this.assistant?.stream.removeEventListener('removetrack', this.onTracksChanged)
    this.caller = undefined
    this.assistant = undefined
    this.merger?.disconnect()
    this.merger = undefined
    this.destination = undefined
    void this.context?.close()
    this.context = undefined
  }
}

function selectMimeType(): string {
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
    for (const candidate of CANDIDATE_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate
    }
  }
  return 'audio/webm'
}