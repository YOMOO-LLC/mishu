import type { CodexConnectionState, RealtimeVoice } from '../../../shared/contracts'
import type { GptLiveState } from './types'

const DATA_CHANNEL_LABEL = 'oai-events'
const DATA_CHANNEL_OPEN_TIMEOUT_MS = 10_000

export class GptLiveSession {
  private generation = 0
  private readySessionId?: string
  private unsubscribeReady?: () => void
  private provider?: 'codex' | 'gpt-live-api'
  private peer?: RTCPeerConnection
  private dataChannel?: RTCDataChannel
  private inputSender?: RTCRtpSender
  private inputStream?: MediaStream
  private inputPaused = false
  private outputStream?: MediaStream
  private state: GptLiveState = {
    connection: { status: 'idle' }
  }
  private readonly listeners = new Set<() => void>()

  getState = (): GptLiveState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(
    inputStream?: MediaStream,
    instructions?: string,
    voice?: RealtimeVoice
  ): Promise<void> {
    if (this.peer && this.state.connection.status === 'error') {
      await this.stop().catch(() => undefined)
    }
    if (this.peer) {
      await this.setInputStream(inputStream)
      return
    }

    const generation = ++this.generation
    this.provider = (await window.livePhone.getVoiceSettings?.())?.provider
    if (generation !== this.generation) return
    this.readySessionId = undefined
    this.unsubscribeReady = window.livePhone.onEvent?.((event) => {
      if (event.type === 'voice-session-ready') {
        this.readySessionId = event.sessionId
        this.refreshReady()
      }
    })
    this.setConnection({ status: 'connecting' })
    const peer = new RTCPeerConnection()
    this.peer = peer

    const outputStream = new MediaStream()
    this.outputStream = outputStream
    peer.addEventListener('track', ({ track, streams }) => {
      const stream = streams[0]
      if (stream) {
        for (const remoteTrack of stream.getTracks()) {
          if (!outputStream.getTracks().some(({ id }) => id === remoteTrack.id)) {
            outputStream.addTrack(remoteTrack)
          }
        }
      } else if (!outputStream.getTracks().some(({ id }) => id === track.id)) {
        outputStream.addTrack(track)
      }
      this.emit()
    })

    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'connected') {
        this.refreshReady()
      } else if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        this.setConnection({
          status: 'error',
          message: `GPT Live WebRTC connection ${peer.connectionState}`
        })
      } else if (peer.connectionState === 'closed') {
        this.setConnection({ status: 'idle' })
      }
    })

    this.setInputSource(inputStream)
    this.inputPaused = false
    const currentInputStream = this.inputStream
    const audioTrack = this.getLiveInputTrack()
    if (audioTrack && currentInputStream) {
      this.inputSender = peer.addTrack(audioTrack, currentInputStream)
    } else {
      this.inputSender = peer.addTransceiver('audio', { direction: 'sendrecv' }).sender
    }
    await this.syncInputTrack()

    const dataChannel = peer.createDataChannel(DATA_CHANNEL_LABEL)
    this.dataChannel = dataChannel
    dataChannel.addEventListener('close', () => {
      if (this.peer === peer && this.dataChannel === dataChannel) {
        this.setConnection({ status: 'error', message: 'GPT Live data channel closed' })
      }
    })
    dataChannel.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string') return
      try {
        const event = JSON.parse(data) as {
          type?: string
          session?: { id?: string }
          message?: string
          error?: { message?: string }
        }
        if (event.type === 'session.started' && typeof event.session?.id === 'string') {
          void window.livePhone.reportRealtimeStarted?.(event.session.id).catch(() => undefined)
        }
        if (event.type === 'error') {
          this.setConnection({
            ...this.state.connection,
            status: 'error',
            message: this.provider === 'gpt-live-api' ? 'GPT Live API returned an error' : event.error?.message ?? event.message ?? 'GPT Live returned an error'
          })
        }
      } catch {
        // The app-server notification channel remains the source of transcript events.
      }
    })

    try {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      await waitForIceGathering(peer)
      const localSdp = peer.localDescription?.sdp
      if (!localSdp) throw new Error('WebRTC offer did not contain SDP')

      const response = await window.livePhone.startRealtime({
        sdp: localSdp,
        ...(instructions ? { instructions } : {}),
        ...(voice ? { voice } : {})
      })
      if (this.peer !== peer) throw new Error('Voice session ended during startup')
      this.provider = response.provider
      await peer.setRemoteDescription({ type: 'answer', sdp: response.sdp })
      this.setConnection({
        status: peer.connectionState === 'connected' && (this.provider !== 'gpt-live-api' || this.readySessionId === response.sessionId) ? 'ready' : 'connecting',
        threadId: response.threadId,
        sessionId: response.sessionId
      })
    } catch (error) {
      await this.stop().catch(() => undefined)
      this.setConnection({
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async setInputStream(stream?: MediaStream): Promise<void> {
    this.setInputSource(stream)
    this.inputPaused = false
    await this.syncInputTrack()
  }

  async pauseInput(): Promise<void> {
    this.inputPaused = true
    await this.syncInputTrack()
  }

  async speak(text: string): Promise<void> {
    if (!text.trim()) return
    if (this.provider === 'gpt-live-api') { await window.livePhone.appendSpeech(text); return }
    const dataChannel = this.dataChannel
    if (!dataChannel) throw new Error('GPT Live data channel is not available')
    await waitForDataChannelOpen(dataChannel)
    if (this.dataChannel !== dataChannel) throw new Error('GPT Live data channel changed before speech')
    dataChannel.send(
      JSON.stringify({
        type: 'session.context.append',
        channel: 'speakable',
        content: [{ type: 'input_text', text }]
      })
    )
  }

  async stop(): Promise<void> {
    this.generation += 1
    const peer = this.peer
    if (peer && this.provider === 'gpt-live-api') await window.livePhone.stopRealtime()
    this.peer = undefined
    this.unsubscribeReady?.()
    this.unsubscribeReady = undefined
    this.readySessionId = undefined
    this.dataChannel = undefined
    this.inputSender = undefined
    this.setInputSource(undefined)
    this.inputPaused = false
    this.outputStream = undefined
    if (peer) peer.close()
    if (this.provider !== 'gpt-live-api') await window.livePhone.stopRealtime()
    this.provider = undefined
    this.setConnection({ status: 'idle' })
  }

  private refreshReady(): void {
    if (this.peer?.connectionState !== 'connected') return
    if (this.provider === 'gpt-live-api' && this.readySessionId !== this.state.connection.sessionId) return
    this.setConnection({ ...this.state.connection, status: 'ready' })
  }

  private setConnection(connection: CodexConnectionState): void {
    this.state = { ...this.state, connection, outputStream: this.outputStream }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private setInputSource(stream?: MediaStream): void {
    if (this.inputStream === stream) return
    this.inputStream?.removeEventListener('addtrack', this.onInputTracksChanged)
    this.inputStream?.removeEventListener('removetrack', this.onInputTracksChanged)
    this.inputStream = stream
    this.inputStream?.addEventListener('addtrack', this.onInputTracksChanged)
    this.inputStream?.addEventListener('removetrack', this.onInputTracksChanged)
  }

  private getLiveInputTrack(): MediaStreamTrack | undefined {
    return this.inputStream?.getAudioTracks().find(({ readyState }) => readyState === 'live')
  }

  private async syncInputTrack(): Promise<void> {
    const track = this.inputPaused ? null : (this.getLiveInputTrack() ?? null)
    await this.inputSender?.replaceTrack(track)
  }

  private onInputTracksChanged = (): void => {
    void this.syncInputTrack().catch((error: unknown) => {
      this.setConnection({
        ...this.state.connection,
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    })
  }
}

function waitForDataChannelOpen(dataChannel: RTCDataChannel): Promise<void> {
  if (dataChannel.readyState === 'open') return Promise.resolve()
  if (dataChannel.readyState === 'closing' || dataChannel.readyState === 'closed') {
    return Promise.reject(new Error('GPT Live data channel closed before speech'))
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error('Timed out waiting for GPT Live data channel')),
      DATA_CHANNEL_OPEN_TIMEOUT_MS
    )
    const onOpen = (): void => finish()
    const onClose = (): void => finish(new Error('GPT Live data channel closed before speech'))
    const finish = (error?: Error): void => {
      window.clearTimeout(timeout)
      dataChannel.removeEventListener('open', onOpen)
      dataChannel.removeEventListener('close', onClose)
      if (error) reject(error)
      else resolve()
    }
    dataChannel.addEventListener('open', onOpen)
    dataChannel.addEventListener('close', onClose)
  })
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()

  return new Promise((resolve) => {
    const onStateChange = (): void => {
      if (peer.iceGatheringState !== 'complete') return
      peer.removeEventListener('icegatheringstatechange', onStateChange)
      resolve()
    }
    peer.addEventListener('icegatheringstatechange', onStateChange)
  })
}
