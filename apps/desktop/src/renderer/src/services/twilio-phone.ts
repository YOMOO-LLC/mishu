import { Call, Device } from '@twilio/voice-sdk'
import type { CallEndReason, PhoneCall } from '../../../shared/contracts'
import { SwitchableAudioProcessor } from './audio-router'
import type { ControlMode, PhoneAdapter, PhoneAdapterState } from './types'

const ASSISTANT_AUDIO_READY_TIMEOUT_MS = 5_000
const DISCONNECT_EVENT_TIMEOUT_MS = 2_000

export class TwilioPhoneAdapter implements PhoneAdapter {
  private device?: Device
  private activeCall?: Call
  private callerStream?: MediaStream
  private requestedEndReason?: CallEndReason
  private dialGeneration = 0
  private readonly audioProcessor = new SwitchableAudioProcessor()
  private readonly listeners = new Set<() => void>()
  private state: PhoneAdapterState = { connection: 'idle' }

  getState = (): PhoneAdapterState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initialize(token?: string): Promise<void> {
    if (!token) throw new Error('A Twilio access token is required')
    if (this.device) {
      this.device.updateToken(token)
      return
    }

    this.setState({ ...this.state, connection: 'connecting', error: undefined })
    const device = new Device(token, {
      codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU]
    })
    this.device = device

    device.on('registered', () => this.setState({ ...this.state, connection: 'ready' }))
    device.on('unregistered', () => this.setState({ ...this.state, connection: 'idle' }))
    device.on('error', (error) => {
      this.setState({ ...this.state, connection: 'error', error: error.message })
    })
    device.on('tokenWillExpire', () => {
      void window.livePhone
        .getRuntimeConfig()
        .then((config) => {
          if (config.twilioToken) device.updateToken(config.twilioToken)
        })
        .catch((error: unknown) => {
          this.setState({
            ...this.state,
            connection: 'error',
            error: error instanceof Error ? error.message : String(error)
          })
        })
    })
    device.on('incoming', (call) => {
      if (this.activeCall) {
        call.reject()
        return
      }
      const id = call.parameters.CallSid ?? `inbound-${Date.now()}`
      this.bindCall(call, id, 'inbound', call.parameters.From ?? 'Unknown caller', 'ringing')
    })

    await device.audio?.addProcessor(this.audioProcessor)
    await device.register()
  }

  async dial(peer: string): Promise<void> {
    if (!this.device) throw new Error('Twilio Device is not initialized')
    const generation = ++this.dialGeneration
    const pending: PhoneCall = {
      id: `outbound-${Date.now()}`,
      direction: 'outbound',
      peer,
      status: 'dialing'
    }
    this.setState({ ...this.state, call: pending, error: undefined })
    try {
      const call = await this.device.connect({ params: { To: peer } })
      if (generation !== this.dialGeneration) {
        call.disconnect()
        throw new Error('Twilio call was cancelled before connecting')
      }
      this.bindCall(call, pending.id, 'outbound', peer, 'connecting')
    } catch (error) {
      if (generation === this.dialGeneration) this.failCall(error)
      throw error
    }
  }

  async answer(): Promise<void> {
    if (!this.activeCall || this.state.call?.status !== 'ringing') return
    this.setCallStatus('connecting')
    this.activeCall.accept()
  }

  async reject(): Promise<void> {
    const call = this.activeCall
    if (!call) return
    this.requestedEndReason = 'rejected'
    call.reject()
    this.endCall('rejected', call)
  }

  async hangup(reason: CallEndReason = 'local_hangup'): Promise<void> {
    const call = this.activeCall
    if (!call) {
      if (this.state.call && !['ended', 'error'].includes(this.state.call.status)) {
        this.dialGeneration += 1
        this.device?.disconnectAll()
        this.endCall(reason)
      }
      return
    }
    this.requestedEndReason = reason
    let disconnected = false
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(), DISCONNECT_EVENT_TIMEOUT_MS)
      const onDisconnect = (): void => {
        disconnected = true
        finish()
      }
      const finish = (error?: unknown): void => {
        clearTimeout(timeout)
        call.removeListener('disconnect', onDisconnect)
        if (error) reject(error)
        else resolve()
      }
      call.once('disconnect', onDisconnect)
      try {
        call.disconnect()
      } catch (error) {
        finish(error)
      }
    }).catch((error: unknown) => {
      this.endCall(reason, call)
      throw error
    })
    if (!disconnected) this.device?.disconnectAll()
    this.endCall(reason, call)
  }

  async setControlMode(mode: ControlMode): Promise<void> {
    await this.audioProcessor.setMode(mode)
  }

  async setAssistantStream(stream?: MediaStream): Promise<void> {
    await this.audioProcessor.setAssistantStream(stream)
    if (!stream || this.state.call?.status !== 'active') return
    const ready = await this.audioProcessor.waitForAssistantReady(
      stream,
      ASSISTANT_AUDIO_READY_TIMEOUT_MS
    )
    if (!ready && this.state.call?.status === 'active') {
      throw new Error('Twilio assistant audio pipeline did not become ready in time')
    }
  }

  getCallerStream(): MediaStream | undefined {
    return this.callerStream ?? this.activeCall?.getRemoteStream()
  }

  async dispose(): Promise<void> {
    this.dialGeneration += 1
    this.activeCall?.disconnect()
    this.activeCall = undefined
    this.requestedEndReason = undefined
    this.callerStream = undefined
    if (this.device) {
      await this.device.audio?.removeProcessor(this.audioProcessor)
      this.device.destroy()
      this.device = undefined
    }
    await this.audioProcessor.dispose()
    this.setState({ connection: 'idle' })
  }

  private bindCall(
    call: Call,
    id: string,
    direction: PhoneCall['direction'],
    peer: string,
    status: PhoneCall['status']
  ): void {
    this.activeCall = call
    this.requestedEndReason = undefined
    const providerCallSid = call.parameters.CallSid
    this.setState({
      ...this.state,
      call: { id, direction, peer, status, ...(providerCallSid ? { providerCallSid } : {}) },
      error: undefined,
      endReason: undefined
    })

    call.on('accept', () => {
      this.callerStream = call.getRemoteStream()
      this.attachProviderCallSid(call)
      this.setCallStatus('active', Date.now())
    })
    call.on('disconnect', () => {
      this.attachProviderCallSid(call)
      this.endCall(this.requestedEndReason ?? 'remote_hangup', call)
    })
    call.on('cancel', () => {
      this.attachProviderCallSid(call)
      this.endCall('remote_hangup', call)
    })
    call.on('reject', () => {
      this.attachProviderCallSid(call)
      this.endCall(this.requestedEndReason ?? 'rejected', call)
    })
    call.on('error', (error) => this.failCall(error, call))
  }

  private setCallStatus(status: PhoneCall['status'], startedAt?: number): void {
    const call = this.state.call
    if (!call) return
    this.setState({ ...this.state, call: { ...call, status, startedAt: startedAt ?? call.startedAt } })
  }

  private attachProviderCallSid(call: Call): void {
    const providerCallSid = call.parameters.CallSid
    const current = this.state.call
    if (!providerCallSid || !current || current.providerCallSid === providerCallSid) return
    this.setState({ ...this.state, call: { ...current, providerCallSid } })
  }

  private endCall(reason: CallEndReason, sourceCall?: Call): void {
    if (sourceCall && this.activeCall !== sourceCall) return
    const call = this.state.call
    this.activeCall = undefined
    this.requestedEndReason = undefined
    this.callerStream = undefined
    this.setState({
      ...this.state,
      connection: this.connectionAfterCall(),
      error: undefined,
      call: call ? { ...call, status: 'ended' } : undefined,
      endReason: reason
    })
  }

  private failCall(error: unknown, sourceCall?: Call): void {
    if (sourceCall && this.activeCall !== sourceCall) return
    const { code, message } = describeTwilioError(error)
    const call = this.state.call
    this.activeCall = undefined
    this.requestedEndReason = undefined
    this.callerStream = undefined
    console.warn('Twilio call error', { ...(code !== undefined ? { code } : {}), message })
    this.setState({
      ...this.state,
      connection: this.connectionAfterCall(),
      error: code === undefined ? message : `Twilio ${code}: ${message}`,
      call: call ? { ...call, status: 'error' } : undefined,
      endReason: 'carrier_error'
    })
  }

  private setState(state: PhoneAdapterState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  private connectionAfterCall(): PhoneAdapterState['connection'] {
    return this.device?.state === 'registered' ? 'ready' : this.state.connection
  }
}

function describeTwilioError(error: unknown): { code?: number; message: string } {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : undefined
  const code = typeof candidate?.code === 'number' && Number.isFinite(candidate.code)
    ? candidate.code
    : undefined
  const rawMessage = typeof candidate?.message === 'string'
    ? candidate.message
    : error instanceof Error
      ? error.message
      : String(error)
  const message = rawMessage
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[redacted number]')
    .slice(0, 500)
  return { ...(code !== undefined ? { code } : {}), message }
}
