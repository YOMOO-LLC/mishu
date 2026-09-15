import type { ControlMode } from './types'

const ASSISTANT_READY_POLL_MS = 25

/** Routes either GPT output or the user's microphone into Twilio's local audio input. */
export class SwitchableAudioProcessor {
  private context?: AudioContext
  private destination?: MediaStreamAudioDestinationNode
  private source?: MediaStreamAudioSourceNode
  private microphone?: MediaStream
  private assistant?: MediaStream
  private mode: ControlMode = 'ai'

  async createProcessedStream(microphone: MediaStream): Promise<MediaStream> {
    this.microphone = microphone
    this.context ??= new AudioContext()
    if (!this.destination || this.destination.stream.getTracks().some(({ readyState }) => readyState === 'ended')) {
      this.destination = this.context.createMediaStreamDestination()
    }
    await this.context.resume()
    this.reconnect()
    return this.destination.stream
  }

  async destroyProcessedStream(stream: MediaStream): Promise<void> {
    this.source?.disconnect()
    this.source = undefined
    this.microphone = undefined
    if (this.destination?.stream === stream) this.destination = undefined
  }

  async setAssistantStream(stream?: MediaStream): Promise<void> {
    if (this.assistant !== stream) {
      this.assistant?.removeEventListener('addtrack', this.onAssistantTracksChanged)
      this.assistant?.removeEventListener('removetrack', this.onAssistantTracksChanged)
      stream?.addEventListener('addtrack', this.onAssistantTracksChanged)
      stream?.addEventListener('removetrack', this.onAssistantTracksChanged)
    }
    this.assistant = stream
    await this.context?.resume()
    this.reconnect()
  }

  async waitForAssistantReady(stream: MediaStream, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.assistant === stream) {
      if (this.isAssistantReady(stream)) return true
      if (Date.now() >= deadline) return false
      await delay(ASSISTANT_READY_POLL_MS)
    }
    return false
  }

  async setMode(mode: ControlMode): Promise<void> {
    this.mode = mode
    this.reconnect()
  }

  async dispose(): Promise<void> {
    this.source?.disconnect()
    this.source = undefined
    this.assistant?.removeEventListener('addtrack', this.onAssistantTracksChanged)
    this.assistant?.removeEventListener('removetrack', this.onAssistantTracksChanged)
    this.assistant = undefined
    await this.context?.close()
    this.context = undefined
    this.destination = undefined
  }

  private reconnect(): void {
    this.source?.disconnect()
    this.source = undefined
    const sourceStream = this.mode === 'ai' ? this.assistant : this.microphone
    if (!this.context || !this.destination || !sourceStream?.getAudioTracks().length) return
    this.source = this.context.createMediaStreamSource(sourceStream)
    this.source.connect(this.destination)
  }

  private isAssistantReady(stream: MediaStream): boolean {
    return (
      this.mode === 'ai' &&
      this.assistant === stream &&
      this.context?.state === 'running' &&
      Boolean(this.destination && this.source) &&
      stream.getAudioTracks().some(({ readyState }) => readyState === 'live')
    )
  }

  private onAssistantTracksChanged = (): void => {
    void this.context?.resume().then(() => this.reconnect())
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
