import type { CallEndReason, PhoneCall } from '../../../shared/contracts'
import type { ControlMode, PhoneAdapter, PhoneAdapterState } from './types'

let mockCallSequence = 0

interface ToneSource {
  context: AudioContext
  oscillator: OscillatorNode
  destination: MediaStreamAudioDestinationNode
}

function createToneSource(frequency: number): ToneSource {
  const context = new AudioContext()
  const oscillator = context.createOscillator()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  const gain = context.createGain()
  gain.gain.value = 0.12
  const destination = context.createMediaStreamDestination()
  oscillator.connect(gain)
  gain.connect(destination)
  oscillator.start()
  void context.resume().catch(() => undefined)
  return { context, oscillator, destination }
}

function stopToneSource(source: ToneSource | undefined): void {
  if (!source) return
  try {
    source.oscillator.stop()
  } catch {
    // The oscillator may already be stopped.
  }
  void source.context.close().catch(() => undefined)
}

export class MockPhoneAdapter implements PhoneAdapter {
  private state: PhoneAdapterState = { connection: 'idle' }
  private callerStream?: MediaStream
  private assistantStream?: MediaStream
  private callerTone?: ToneSource
  private assistantTone?: ToneSource
  private readonly listeners = new Set<() => void>()

  getState = (): PhoneAdapterState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initialize(): Promise<void> {
    this.setState({ connection: 'ready' })
  }

  async dial(peer: string): Promise<void> {
    const call = this.newCall('outbound', peer, 'dialing')
    this.setState({ connection: 'ready', call, endReason: undefined })
    await Promise.resolve()
    this.activateCall()
  }

  async simulateIncoming(peer = '+1 312 555 0142'): Promise<void> {
    this.setState({
      connection: 'ready',
      call: this.newCall('inbound', peer, 'ringing'),
      endReason: undefined
    })
  }

  async answer(): Promise<void> {
    if (this.state.call?.status !== 'ringing') return
    this.activateCall()
  }

  async reject(): Promise<void> {
    this.endCall('rejected')
  }

  async hangup(reason: CallEndReason = 'local_hangup'): Promise<void> {
    this.endCall(reason)
  }

  async simulateRemoteHangup(): Promise<void> {
    this.endCall('remote_hangup')
  }

  async setControlMode(_mode: ControlMode): Promise<void> {}

  async setAssistantStream(_stream?: MediaStream): Promise<void> {}

  getCallerStream(): MediaStream | undefined {
    return this.callerStream
  }

  getAssistantStream(): MediaStream | undefined {
    return this.assistantStream
  }

  async dispose(): Promise<void> {
    stopToneSource(this.callerTone)
    stopToneSource(this.assistantTone)
    this.callerTone = undefined
    this.assistantTone = undefined
    this.callerStream = undefined
    this.assistantStream = undefined
    this.setState({ connection: 'idle' })
  }

  private newCall(
    direction: PhoneCall['direction'],
    peer: string,
    status: PhoneCall['status']
  ): PhoneCall {
    mockCallSequence += 1
    return { id: `mock-call-${mockCallSequence}`, direction, peer, status }
  }

  private activateCall(): void {
    const call = this.state.call
    if (!call) return
    this.callerTone = createToneSource(440)
    this.callerStream = this.callerTone.destination.stream
    this.assistantTone = createToneSource(220)
    this.assistantStream = this.assistantTone.destination.stream
    this.setState({
      connection: 'ready',
      call: { ...call, status: 'active', startedAt: Date.now() }
    })
  }

  private endCall(endReason: CallEndReason): void {
    const call = this.state.call
    stopToneSource(this.callerTone)
    stopToneSource(this.assistantTone)
    this.callerTone = undefined
    this.assistantTone = undefined
    this.callerStream = undefined
    this.assistantStream = undefined
    this.setState({
      connection: 'ready',
      call: call ? { ...call, status: 'ended' } : undefined,
      endReason
    })
  }

  private setState(state: PhoneAdapterState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
