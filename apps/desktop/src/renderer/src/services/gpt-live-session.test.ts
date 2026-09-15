import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GptLiveSession } from './gpt-live-session'

class FakeMediaStream extends EventTarget {
  private readonly tracks: MediaStreamTrack[] = []

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track)
    this.dispatchEvent(new Event('addtrack'))
  }

  getAudioTracks(): MediaStreamTrack[] {
    return [...this.tracks]
  }

  getTracks(): MediaStreamTrack[] {
    return [...this.tracks]
  }
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open'
  readonly send = vi.fn<(data: string) => void>()
}

class FakePeerConnection extends EventTarget {
  static last?: FakePeerConnection

  readonly dataChannel = new FakeDataChannel()
  readonly sender = {
    replaceTrack: vi.fn<(track: MediaStreamTrack | null) => Promise<void>>().mockResolvedValue(undefined)
  }
  connectionState: RTCPeerConnectionState = 'new'
  iceGatheringState: RTCIceGatheringState = 'complete'
  localDescription: RTCSessionDescription | null = { type: 'offer', sdp: 'test-offer' } as RTCSessionDescription

  constructor() {
    super()
    FakePeerConnection.last = this
  }

  addTrack(): RTCRtpSender {
    return this.sender as unknown as RTCRtpSender
  }

  addTransceiver(): RTCRtpTransceiver {
    return { sender: this.sender } as unknown as RTCRtpTransceiver
  }

  createDataChannel(): RTCDataChannel {
    return this.dataChannel as unknown as RTCDataChannel
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'test-offer' }
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {
    this.connectionState = 'connected'
    this.dispatchEvent(new Event('connectionstatechange'))
  }

  close(): void {
    this.connectionState = 'closed'
    this.dispatchEvent(new Event('connectionstatechange'))
  }
}

describe('GptLiveSession', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaStream', FakeMediaStream)
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal('window', {
      livePhone: {
        startRealtime: vi.fn().mockResolvedValue({ sdp: 'test-answer', threadId: 'thread-1' }),
        stopRealtime: vi.fn().mockResolvedValue(undefined)
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    FakePeerConnection.last = undefined
  })

  it('attaches caller audio that arrives after the realtime session starts', async () => {
    const input = new FakeMediaStream()
    const session = new GptLiveSession()
    await session.start(input as unknown as MediaStream)
    const sender = FakePeerConnection.last?.sender
    const track = { id: 'caller-audio', kind: 'audio', readyState: 'live' } as MediaStreamTrack

    input.addTrack(track)
    await Promise.resolve()

    expect(sender?.replaceTrack).toHaveBeenCalledWith(track)
  })

  it('keeps late caller audio detached while human takeover is active', async () => {
    const input = new FakeMediaStream()
    const session = new GptLiveSession()
    await session.start(input as unknown as MediaStream)
    await session.pauseInput()
    const sender = FakePeerConnection.last?.sender
    const track = { id: 'caller-audio', kind: 'audio', readyState: 'live' } as MediaStreamTrack

    input.addTrack(track)
    await Promise.resolve()

    expect(sender?.replaceTrack).not.toHaveBeenCalledWith(track)
    expect(sender?.replaceTrack).toHaveBeenLastCalledWith(null)
  })

  it('rebuilds a failed peer when AI takeover resumes', async () => {
    const session = new GptLiveSession()
    const input = new FakeMediaStream()
    await session.start(input as unknown as MediaStream)
    const failedPeer = FakePeerConnection.last
    if (!failedPeer) throw new Error('Expected a peer connection')
    failedPeer.connectionState = 'failed'
    failedPeer.dispatchEvent(new Event('connectionstatechange'))

    await session.start(input as unknown as MediaStream)

    expect(FakePeerConnection.last).not.toBe(failedPeer)
    expect(session.getState().connection.status).toBe('ready')
  })

  it('reports a disconnected peer and a closed data channel as session errors', async () => {
    const session = new GptLiveSession()
    await session.start()
    const peer = FakePeerConnection.last
    if (!peer) throw new Error('Expected a peer connection')

    peer.connectionState = 'disconnected'
    peer.dispatchEvent(new Event('connectionstatechange'))
    expect(session.getState().connection).toMatchObject({ status: 'error' })

    peer.connectionState = 'connected'
    peer.dataChannel.dispatchEvent(new Event('close'))
    expect(session.getState().connection).toEqual({
      status: 'error',
      message: 'GPT Live data channel closed'
    })
  })

  it('passes call instructions into realtime session startup', async () => {
    const session = new GptLiveSession()

    await session.start(undefined, 'Introduce the spring plan')

    expect(window.livePhone.startRealtime).toHaveBeenCalledWith({
      sdp: 'test-offer',
      instructions: 'Introduce the spring plan'
    })
  })

  it('passes the campaign voice into realtime session startup', async () => {
    const session = new GptLiveSession()

    await session.start(undefined, 'Introduce the spring plan', 'juniper')

    expect(window.livePhone.startRealtime).toHaveBeenCalledWith({
      sdp: 'test-offer',
      instructions: 'Introduce the spring plan',
      voice: 'juniper'
    })
  })

  it('requests proactive speech through the realtime data channel', async () => {
    const session = new GptLiveSession()
    await session.start()

    await session.speak('Hello from the phone agent.')

    const channel = FakePeerConnection.last?.dataChannel
    if (!channel) throw new Error('Expected a data channel')
    const sentEvent = JSON.parse(channel.send.mock.calls[0]?.[0] ?? '{}')
    expect(sentEvent).toEqual({
      type: 'session.context.append',
      channel: 'speakable',
      content: [{ type: 'input_text', text: 'Hello from the phone agent.' }]
    })
  })
})
