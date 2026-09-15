import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const twilio = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class FakeCall {
    static Codec = { Opus: 'opus', PCMU: 'pcmu' }
    readonly parameters: Record<string, string>
    private readonly listeners = new Map<string, Listener[]>()
    readonly remoteStream = {} as MediaStream
    emitDisconnectOnDisconnect = true
    readonly disconnect = vi.fn(() => {
      if (this.emitDisconnectOnDisconnect) this.emit('disconnect')
    })

    constructor(callSid = 'CA-test') {
      this.parameters = { CallSid: callSid }
    }

    on(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
    }

    once(event: string, listener: Listener): void {
      const onceListener: Listener = (...args) => {
        this.removeListener(event, onceListener)
        listener(...args)
      }
      this.on(event, onceListener)
    }

    removeListener(event: string, listener: Listener): void {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
      )
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }

    accept(): void {
      this.emit('accept')
    }

    reject(): void {
      this.emit('reject')
    }

    getRemoteStream(): MediaStream {
      return this.remoteStream
    }
  }

  class FakeDevice {
    static last?: FakeDevice
    readonly audio = {
      addProcessor: vi.fn().mockResolvedValue(undefined),
      removeProcessor: vi.fn().mockResolvedValue(undefined)
    }
    readonly outgoingCall = new FakeCall()
    readonly disconnectAll = vi.fn(() => this.outgoingCall.emit('disconnect'))
    private readonly listeners = new Map<string, Listener[]>()
    state = 'unregistered'
    connectResult?: Promise<FakeCall>

    constructor(_token: string) {
      FakeDevice.last = this
    }

    on(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }

    async register(): Promise<void> {
      this.state = 'registered'
      this.emit('registered')
    }

    async connect(): Promise<FakeCall> {
      return this.connectResult ?? this.outgoingCall
    }

    updateToken(): void {}
    destroy(): void {}
  }

  return { FakeCall, FakeDevice }
})

vi.mock('@twilio/voice-sdk', () => ({
  Call: twilio.FakeCall,
  Device: twilio.FakeDevice
}))

vi.mock('./audio-router', () => ({
  SwitchableAudioProcessor: class {
    async createProcessedStream(stream: MediaStream): Promise<MediaStream> { return stream }
    async setMode(): Promise<void> {}
    async setAssistantStream(): Promise<void> {}
    async waitForAssistantReady(): Promise<boolean> { return true }
    async dispose(): Promise<void> {}
  }
}))

import { TwilioPhoneAdapter } from './twilio-phone'

describe('TwilioPhoneAdapter call termination', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { livePhone: { getRuntimeConfig: vi.fn() } })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    twilio.FakeDevice.last = undefined
  })

  it('classifies an unsolicited disconnect as remote_hangup', async () => {
    const adapter = new TwilioPhoneAdapter()
    await adapter.initialize('test-token')
    await adapter.dial('+13125550198')
    const call = twilio.FakeDevice.last?.outgoingCall
    if (!call) throw new Error('Expected an outgoing call')
    call.accept()

    call.emit('disconnect')

    expect(adapter.getState()).toMatchObject({
      call: { status: 'ended' },
      endReason: 'remote_hangup'
    })
  })

  it('keeps the provisional outbound id when CallSid arrives after connect', async () => {
    const adapter = new TwilioPhoneAdapter()
    await adapter.initialize('test-token')
    const call = twilio.FakeDevice.last?.outgoingCall
    if (!call) throw new Error('Expected an outgoing call')
    delete call.parameters.CallSid
    const observed: Array<{ id: string; providerCallSid?: string; status: string }> = []
    adapter.subscribe(() => {
      const current = adapter.getState().call
      if (current) observed.push({
        id: current.id,
        status: current.status,
        ...(current.providerCallSid ? { providerCallSid: current.providerCallSid } : {})
      })
    })

    await adapter.dial('+13125550198')
    call.parameters.CallSid = 'CA-late'
    call.accept()
    call.emit('disconnect')

    expect(new Set(observed.map(({ id }) => id))).toEqual(new Set([observed[0]?.id]))
    expect(observed.map(({ status }) => status)).toEqual(
      expect.arrayContaining(['dialing', 'connecting', 'active', 'ended'])
    )
    expect(adapter.getState().call).toMatchObject({
      id: observed[0]?.id,
      providerCallSid: 'CA-late',
      status: 'ended'
    })
  })

  it('keeps an app-requested disconnect classified as local_hangup', async () => {
    const adapter = new TwilioPhoneAdapter()
    await adapter.initialize('test-token')
    await adapter.dial('+13125550198')

    await adapter.hangup()

    expect(twilio.FakeDevice.last?.outgoingCall.disconnect).toHaveBeenCalledOnce()
    expect(adapter.getState()).toMatchObject({
      connection: 'ready',
      call: { status: 'ended' },
      endReason: 'local_hangup'
    })
  })

  it('disconnects a connecting call and clears a stale device error state', async () => {
    const adapter = new TwilioPhoneAdapter()
    await adapter.initialize('test-token')
    await adapter.dial('+13125550198')
    const device = twilio.FakeDevice.last
    if (!device) throw new Error('Expected a Twilio device')
    device.emit('error', new Error('temporary signaling error'))

    await adapter.hangup('session_error')

    expect(device.outgoingCall.disconnect).toHaveBeenCalledOnce()
    expect(adapter.getState()).toMatchObject({
      connection: 'ready',
      call: { status: 'ended' },
      endReason: 'session_error'
    })
    expect(adapter.getState().error).toBeUndefined()
  })

  it('disconnects ringing and active calls instead of only changing local state', async () => {
    const adapter = new TwilioPhoneAdapter()
    await adapter.initialize('test-token')
    const device = twilio.FakeDevice.last
    if (!device) throw new Error('Expected a Twilio device')
    const incoming = new twilio.FakeCall('CA-incoming')
    device.emit('incoming', incoming)

    await adapter.hangup()
    expect(incoming.disconnect).toHaveBeenCalledOnce()

    await adapter.dial('+13125550198')
    device.outgoingCall.accept()
    await adapter.hangup()
    expect(device.outgoingCall.disconnect).toHaveBeenCalledOnce()
  })

  it('falls back to device-wide disconnect after the call event timeout', async () => {
    vi.useFakeTimers()
    const adapter = new TwilioPhoneAdapter()
    await adapter.initialize('test-token')
    await adapter.dial('+13125550198')
    const device = twilio.FakeDevice.last
    if (!device) throw new Error('Expected a Twilio device')
    device.outgoingCall.emitDisconnectOnDisconnect = false

    const ending = adapter.hangup()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(device.disconnectAll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await ending

    expect(device.disconnectAll).toHaveBeenCalledOnce()
    expect(adapter.getState()).toMatchObject({
      connection: 'ready',
      call: { status: 'ended' },
      endReason: 'local_hangup'
    })
  })

  it('disconnects a late call returned after hangup and permits the next dial', async () => {
    const adapter = new TwilioPhoneAdapter()
    await adapter.initialize('test-token')
    const device = twilio.FakeDevice.last
    if (!device) throw new Error('Expected a Twilio device')
    let releaseConnect!: (call: InstanceType<typeof twilio.FakeCall>) => void
    device.connectResult = new Promise((resolve) => { releaseConnect = resolve })

    const dialing = adapter.dial('+13125550198')
    await Promise.resolve()
    await adapter.hangup('session_error')
    releaseConnect(device.outgoingCall)

    await expect(dialing).rejects.toThrow('cancelled before connecting')
    expect(device.outgoingCall.disconnect).toHaveBeenCalledOnce()
    expect(adapter.getState()).toMatchObject({
      connection: 'ready',
      call: { status: 'ended' },
      endReason: 'session_error'
    })

    device.connectResult = undefined
    await expect(adapter.dial('+13125550197')).resolves.toBeUndefined()
    expect(adapter.getState().call).toMatchObject({
      peer: '+13125550197',
      status: 'connecting'
    })
  })

  it('records a carrier error code while masking phone-like text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const adapter = new TwilioPhoneAdapter()
    await adapter.initialize('test-token')
    await adapter.dial('+13125550198')
    const call = twilio.FakeDevice.last?.outgoingCall
    if (!call) throw new Error('Expected an outgoing call')

    call.emit('error', { code: 31_005, message: 'Carrier failed for +13125550198' })

    expect(adapter.getState()).toMatchObject({
      call: { status: 'error' },
      endReason: 'carrier_error',
      error: 'Twilio 31005: Carrier failed for [redacted number]'
    })
    expect(warn).toHaveBeenCalledWith('Twilio call error', {
      code: 31_005,
      message: 'Carrier failed for [redacted number]'
    })
  })
})
