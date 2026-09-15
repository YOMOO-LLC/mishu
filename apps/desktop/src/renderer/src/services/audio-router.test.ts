import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SwitchableAudioProcessor } from './audio-router'

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

describe('SwitchableAudioProcessor', () => {
  const destination = { stream: new FakeMediaStream() }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const context = {
    state: 'running',
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createMediaStreamDestination: vi.fn(() => destination),
    createMediaStreamSource: vi.fn(() => source)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'AudioContext',
      function FakeAudioContext() {
        return context
      } as unknown as typeof AudioContext
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('connects assistant audio that arrives after the stream is selected', async () => {
    const processor = new SwitchableAudioProcessor()
    const microphone = new FakeMediaStream()
    const assistant = new FakeMediaStream()
    await processor.createProcessedStream(microphone as unknown as MediaStream)
    await processor.setAssistantStream(assistant as unknown as MediaStream)
    const track = { kind: 'audio', readyState: 'live' } as MediaStreamTrack

    assistant.addTrack(track)
    await Promise.resolve()

    expect(context.createMediaStreamSource).toHaveBeenCalledWith(assistant)
    expect(source.connect).toHaveBeenCalledWith(destination)
  })

  it('does not report readiness until Twilio has created its processed stream', async () => {
    vi.useFakeTimers()
    const processor = new SwitchableAudioProcessor()
    const microphone = new FakeMediaStream()
    const assistant = new FakeMediaStream()
    assistant.addTrack({ kind: 'audio', readyState: 'live' } as MediaStreamTrack)
    await processor.setAssistantStream(assistant as unknown as MediaStream)

    const readiness = processor.waitForAssistantReady(assistant as unknown as MediaStream, 1_000)
    let settled = false
    void readiness.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)

    await processor.createProcessedStream(microphone as unknown as MediaStream)
    await vi.advanceTimersByTimeAsync(25)

    await expect(readiness).resolves.toBe(true)
  })
})
