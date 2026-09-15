import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexConnectionState,
  LivePhoneEvent,
  PhoneCall,
  PhoneCommandRequest,
  PhoneCommandResult
} from '../../../shared/contracts'
import type { RealtimeVoice } from '../../../shared/contracts'
import type { CampaignPolicy } from '../../../shared/policy'
import { CallRecorder } from './call-recorder'
import { PhoneController } from './phone-controller'
import type { GptLiveState, PhoneAdapter, PhoneAdapterState } from './types'

function policy(overrides: Partial<CampaignPolicy> = {}): CampaignPolicy {
  return {
    persona: '',
    allowedTopics: [],
    forbiddenTopics: [],
    forbiddenClaims: [],
    negativePrompt: '',
    recordingDisclosure: true,
    maxCallDurationSec: 600,
    callingHours: { timeZone: 'UTC', windows: [] },
    doNotCall: [],
    blockedCallers: [],
    ...overrides
  }
}

function campaign(overrides: Partial<CampaignPolicy> = {}): {
  id: string
  name: string
  direction: 'inbound' | 'outbound' | 'both'
  systemPrompt: string
  voice: RealtimeVoice
  policy: CampaignPolicy
  createdAt: number
  updatedAt: number
} {
  const p = policy(overrides)
  return {
    id: 'campaign-1',
    name: 'Campaign',
    direction: 'both',
    systemPrompt: p.persona || 'test prompt',
    voice: 'juniper',
    policy: p,
    createdAt: 1,
    updatedAt: 1
  }
}

class NoopRecorder extends CallRecorder {
  stopCount = 0

  constructor() {
    super({
      transport: {
        start: vi.fn().mockResolvedValue(undefined),
        chunk: vi.fn().mockResolvedValue(undefined),
        finish: vi.fn().mockResolvedValue(undefined)
      }
    })
  }
  override async start(_callId: string, _callerStream?: MediaStream): Promise<void> {}
  override setCallerStream(_stream: MediaStream): void {}
  override setAssistantStream(_stream: MediaStream): void {}
  override async stop(): Promise<void> {
    this.stopCount += 1
  }
  override isRecording(): boolean {
    return false
  }
}

class FakeLiveSession {
  private state: GptLiveState = { connection: { status: 'idle' } }
  private readonly listeners = new Set<() => void>()
  readonly starts: Array<MediaStream | undefined> = []
  readonly instructions: Array<string | undefined> = []
  readonly voices: Array<string | undefined> = []
  readonly attachedStreams: MediaStream[] = []
  readonly spoken: string[] = []
  pauseCount = 0
  stopCount = 0
  failNextStart?: Error

  getState = (): GptLiveState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(stream?: MediaStream, instructions?: string, voice?: string): Promise<void> {
    this.starts.push(stream)
    this.instructions.push(instructions)
    this.voices.push(voice)
    this.setConnection({ status: 'connecting' })
    if (this.failNextStart) {
      const error = this.failNextStart
      this.failNextStart = undefined
      this.setConnection({ status: 'error', message: error.message })
      throw error
    }
  }

  async pauseInput(): Promise<void> { this.pauseCount += 1 }
  async speak(text: string): Promise<void> {
    this.spoken.push(text)
  }
  async setInputStream(stream?: MediaStream): Promise<void> {
    if (stream) this.attachedStreams.push(stream)
  }
  async stop(): Promise<void> {
    this.stopCount += 1
    this.setConnection({ status: 'idle' })
  }

  markReady(outputStream: MediaStream): void {
    this.state = { connection: { status: 'ready' }, outputStream }
    this.emit()
  }

  markDisconnected(message = 'GPT Live session closed unexpectedly'): void {
    this.setConnection({ status: 'error', message })
  }

  private setConnection(connection: CodexConnectionState): void {
    this.state = { ...this.state, connection }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

class FakePhoneAdapter implements PhoneAdapter {
  private state: PhoneAdapterState = { connection: 'ready' }
  private readonly listeners = new Set<() => void>()
  readonly events: string[]
  readonly rejected: string[] = []
  readonly hungUp: string[] = []
  readonly controlModes: Array<'ai' | 'human'> = []
  failControlMode?: Error
  private readonly callerMediaStream = { getAudioTracks: () => [] } as unknown as MediaStream
  private availableCallerStream?: MediaStream

  constructor(events: string[]) {
    this.events = events
  }

  getState = (): PhoneAdapterState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initialize(): Promise<void> {}
  async dial(peer: string): Promise<void> {
    this.events.push('dial')
    this.setCall({ id: 'call-1', direction: 'outbound', peer, status: 'dialing' })
  }
  async answer(): Promise<void> {}
  async reject(): Promise<void> {
    this.rejected.push(this.state.call?.id ?? '')
  }
  async hangup(reason: PhoneAdapterState['endReason'] = 'local_hangup'): Promise<void> {
    const call = this.state.call
    if (!call) return
    this.hungUp.push(call.id)
    this.setCall({ ...call, status: 'ended' }, reason)
  }
  async simulateIncoming(peer = '+13125550199'): Promise<void> {
    this.setCall({ id: 'call-simulated', direction: 'inbound', peer, status: 'ringing' })
  }
  async simulateRemoteHangup(): Promise<void> {
    const call = this.state.call
    if (!call) return
    this.setCall({ ...call, status: 'ended' }, 'remote_hangup')
  }
  async setControlMode(mode: 'ai' | 'human'): Promise<void> {
    this.controlModes.push(mode)
    if (this.failControlMode) {
      const error = this.failControlMode
      this.failControlMode = undefined
      throw error
    }
  }
  async setAssistantStream(): Promise<void> {}
  getCallerStream(): MediaStream | undefined {
    return this.availableCallerStream
  }
  async dispose(): Promise<void> {}

  activate(streamReady = true): void {
    const call = this.state.call
    if (!call) throw new Error('Expected a pending call')
    this.availableCallerStream = streamReady ? this.callerMediaStream : undefined
    this.setCall({ ...call, status: 'active', startedAt: Date.now() })
  }

  activateAt(startedAt: number, streamReady = true): void {
    const call = this.state.call
    if (!call) throw new Error('Expected a pending call')
    this.availableCallerStream = streamReady ? this.callerMediaStream : undefined
    this.setCall({ ...call, status: 'active', startedAt })
  }

  releaseCallerStream(): MediaStream {
    this.availableCallerStream = this.callerMediaStream
    return this.callerMediaStream
  }

  ring(): void {
    this.setCall({ id: 'call-incoming', direction: 'inbound', peer: '+13125550199', status: 'ringing' })
  }

  private setCall(call: PhoneCall, endReason?: PhoneAdapterState['endReason']): void {
    this.state = { ...this.state, call, endReason }
    for (const listener of this.listeners) listener()
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('PhoneController live-call readiness', () => {
  let live: FakeLiveSession
  let phone: FakePhoneAdapter
  let recorder: NoopRecorder
  let controller: PhoneController
  const events: string[] = []
  let emitEvent: (event: LivePhoneEvent) => void
  let emitCommand: (request: PhoneCommandRequest) => void
  let commandResults: PhoneCommandResult[]

  beforeEach(() => {
    events.length = 0
    emitEvent = () => undefined
    emitCommand = () => undefined
    commandResults = []
    live = new FakeLiveSession()
    phone = new FakePhoneAdapter(events)
    recorder = new NoopRecorder()
    vi.stubGlobal('window', {
      livePhone: {
        getRuntimeConfig: vi.fn().mockResolvedValue({ mockMode: false, twilioToken: 'test-token' }),
        getCampaignWorkspace: vi.fn().mockResolvedValue({
          campaigns: [],
          selectedCampaignId: 'default'
        }),
        getCampaign: vi.fn().mockResolvedValue(campaign()),
        selectCampaign: vi.fn(),
        onEvent: vi.fn((listener: (event: LivePhoneEvent) => void) => {
          emitEvent = listener
          return () => undefined
        }),
        onPhoneCommand: vi.fn((listener: (request: PhoneCommandRequest) => void) => {
          emitCommand = listener
          return () => undefined
        }),
        respondPhoneCommand: vi.fn((result: PhoneCommandResult) => commandResults.push(result)),
        publishPhoneStatus: vi.fn(),
        appendSpeech: vi.fn().mockResolvedValue(undefined),
        stopRealtime: vi.fn().mockResolvedValue(undefined),
        reportCallLifecycle: vi.fn().mockResolvedValue(undefined),
        reportTranscriptEntry: vi.fn().mockResolvedValue(undefined),
        listCalls: vi.fn().mockResolvedValue([]),
        getCall: vi.fn().mockResolvedValue(undefined),
        getCallTranscript: vi.fn().mockResolvedValue([]),
        recordStart: vi.fn().mockResolvedValue(undefined),
        recordChunk: vi.fn().mockResolvedValue(undefined),
        recordFinish: vi.fn().mockResolvedValue(undefined),
        getRecording: vi.fn().mockResolvedValue(undefined),
        reportGuardrailEvent: vi.fn().mockResolvedValue(undefined)
      }
    })
    controller = new PhoneController(
      live as unknown as ConstructorParameters<typeof PhoneController>[0],
      () => phone,
      recorder
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('on_answer creates no voice session for an unanswered outbound call', async () => {
    window.livePhone.getVoiceSettings = vi.fn(async () => ({ provider: 'gpt-live-api', apiVoice: 'marin', startPolicy: 'on_answer' } as const))
    await controller.dial('+13125550198')
    expect(live.starts).toHaveLength(0)
    await controller.simulateRemoteHangup()
    expect(live.starts).toHaveLength(0)
  })

  it('on_answer starts only after the outbound call is accepted', async () => {
    window.livePhone.getVoiceSettings = vi.fn(async () => ({ provider: 'gpt-live-api', apiVoice: 'marin', startPolicy: 'on_answer' } as const))
    await controller.dial('+13125550198')
    expect(live.starts).toHaveLength(0)
    phone.activate()
    await flush()
    expect(live.starts).toHaveLength(1)
  })

  it('on_answer startup failure hangs up with session_error', async () => {
    window.livePhone.getVoiceSettings = vi.fn(async () => ({ provider: 'gpt-live-api', apiVoice: 'marin', startPolicy: 'on_answer' } as const))
    live.failNextStart = new Error('API startup failed')
    await controller.dial('+13125550198')
    phone.activate()
    await flush()
    expect(phone.hungUp).toEqual(['call-1'])
    expect(window.livePhone.reportCallLifecycle).toHaveBeenCalledWith(expect.objectContaining({ endReason: 'session_error' }))
  })

  it('on_answer never prewarms an unanswered incoming call', async () => {
    window.livePhone.getVoiceSettings = vi.fn(async () => ({ provider: 'gpt-live-api', apiVoice: 'marin', startPolicy: 'on_answer' } as const))
    await controller.initialize()
    phone.ring()
    await flush()
    expect(live.starts).toHaveLength(0)
    await controller.simulateRemoteHangup()
    expect(live.starts).toHaveLength(0)
  })

  it('starts warming GPT Live before an outbound call begins', async () => {
    const originalStart = live.start.bind(live)
    live.start = async (stream?: MediaStream, instructions?: string) => {
      events.push('live-start')
      await originalStart(stream, instructions)
    }

    await controller.dial('+13125550198')

    expect(events.slice(0, 2)).toEqual(['live-start', 'dial'])
    expect(live.starts).toEqual([undefined])
  })

  it('disconnects after an SDP timeout, reports session_error, and allows another dial', async () => {
    live.failNextStart = new Error('Timed out waiting for realtime SDP after 45000ms')

    await expect(controller.dial('+13125550198')).rejects.toThrow(
      'Timed out waiting for realtime SDP after 45000ms'
    )
    await flush()

    expect(phone.hungUp).toEqual(['call-1'])
    expect(controller.getState()).toMatchObject({
      phoneConnection: 'ready',
      call: { status: 'ended' }
    })
    expect(window.livePhone.reportCallLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        call: expect.objectContaining({ status: 'ended' }),
        endReason: 'session_error'
      })
    )

    await expect(controller.dial('+13125550197')).resolves.toBeUndefined()
    expect(controller.getState().call).toMatchObject({
      peer: '+13125550197',
      status: 'dialing'
    })
    expect(events.filter((event) => event === 'dial')).toHaveLength(2)
  })

  it('returns the realtime startup error through the phone command gateway', async () => {
    await controller.initialize()
    live.failNextStart = new Error('Timed out waiting for realtime SDP after 45000ms')

    emitCommand({
      requestId: 'dial-timeout',
      command: { type: 'dial', peer: '+13125550198' },
      issuedAt: 1
    })
    await vi.waitFor(() => {
      expect(commandResults.at(-1)).toMatchObject({
        requestId: 'dial-timeout',
        ok: false,
        code: 'RENDERER_ERROR',
        message: 'Timed out waiting for realtime SDP after 45000ms'
      })
    })

    expect(phone.hungUp).toEqual(['call-1'])
    expect(window.livePhone.reportCallLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ endReason: 'session_error' })
    )
  })

  it('handles gateway dial, status, and hangup commands through the existing phone stack', async () => {
    await controller.initialize()
    emitCommand({ requestId: 'dial-1', command: { type: 'dial', peer: '+13125550198' }, issuedAt: 1 })
    await flush()
    expect(commandResults.at(-1)).toMatchObject({
      requestId: 'dial-1',
      ok: true,
      status: { call: { status: 'dialing' } }
    })

    emitCommand({ requestId: 'hangup-1', command: { type: 'hangup' }, issuedAt: 2 })
    await flush()
    expect(commandResults.at(-1)).toMatchObject({
      requestId: 'hangup-1',
      ok: true,
      status: { call: { status: 'ended' } }
    })
  })

  it('loads a command campaign without changing the selected campaign', async () => {
    const selected = campaign()
    const inline = {
      ...campaign({ persona: 'Use the inline campaign to introduce the new package' }),
      id: 'ephemeral-task-1',
      name: 'Inline campaign',
      direction: 'outbound' as const,
      voice: 'sol' as const
    }
    vi.mocked(window.livePhone.getCampaignWorkspace).mockResolvedValue({
      campaigns: [selected],
      selectedCampaignId: selected.id
    })
    vi.mocked(window.livePhone.getCampaign).mockResolvedValue(inline)

    await controller.initialize()
    emitCommand({
      requestId: 'dial-inline',
      command: { type: 'dial', peer: '+13125550198', campaignId: inline.id },
      issuedAt: 1
    })
    await flush()

    expect(window.livePhone.getCampaign).toHaveBeenCalledWith(inline.id)
    expect(window.livePhone.selectCampaign).not.toHaveBeenCalled()
    expect(commandResults.at(-1)).toMatchObject({ requestId: 'dial-inline', ok: true })
    expect(live.instructions.at(-1)).toContain('Use the inline campaign to introduce the new package')
    expect(live.voices.at(-1)).toBe('sol')

    phone.activate()
    await flush()
    await controller.hangup()
    expect(window.livePhone.reportCallLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ campaign: expect.objectContaining({ id: inline.id, name: inline.name }) })
    )

    await controller.dial('+13125550197')
    expect(live.voices.at(-1)).toBe(selected.voice)
  })

  it('persists a terminal lifecycle before publishing ended state', async () => {
    let releasePersistence!: () => void
    const persisted = new Promise<void>((resolve) => { releasePersistence = resolve })
    vi.mocked(window.livePhone.reportCallLifecycle).mockImplementation(async (report) => {
      if (report.call.status === 'ended') await persisted
    })
    await controller.dial('+13125550198')
    phone.activate()
    await flush()
    expect(controller.getState().call?.status).toBe('active')

    const ending = controller.hangup()
    await flush()
    expect(window.livePhone.reportCallLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ call: expect.objectContaining({ status: 'ended' }) })
    )
    expect(controller.getState().call?.status).toBe('active')

    releasePersistence()
    await ending
    expect(controller.getState().call?.status).toBe('ended')
  })

  it('returns a guardrail error code for blocked gateway dialing', async () => {
    controller.setCampaignSnapshot(campaign({ doNotCall: ['+13125550198'] }))
    await controller.initialize()
    emitCommand({ requestId: 'dial-blocked', command: { type: 'dial', peer: '+13125550198' }, issuedAt: 1 })
    await flush()
    expect(commandResults.at(-1)).toMatchObject({
      requestId: 'dial-blocked',
      ok: false,
      code: 'GUARDRAIL_BLOCKED'
    })
  })

  it('handles simulated incoming commands only in mock mode', async () => {
    vi.mocked(window.livePhone.getRuntimeConfig).mockResolvedValue({ mockMode: true })
    await controller.initialize()
    emitCommand({
      requestId: 'incoming-1',
      command: { type: 'simulateIncoming', peer: '+13125550123' },
      issuedAt: 1
    })
    await flush()
    expect(commandResults.at(-1)).toMatchObject({
      requestId: 'incoming-1',
      ok: true,
      status: { call: { direction: 'inbound', peer: '+13125550123', status: 'ringing' } }
    })
  })

  it('maps setControlMode commands to the active phone stack', async () => {
    await controller.initialize()
    phone.ring()
    phone.activate()
    emitCommand({ requestId: 'control-1', command: { type: 'setControlMode', mode: 'human' }, issuedAt: 1 })
    await flush()
    expect(commandResults.at(-1)).toMatchObject({
      requestId: 'control-1', ok: true, status: { controlMode: 'human' }
    })
  })

  it('applies the operator goal to the prewarmed outbound session', async () => {
    await controller.dial('+13125550198', 'Introduce the spring package and see if they will book a demo')

    expect(live.instructions[0]).toContain('Introduce the spring package and see if they will book a demo')
    expect(live.instructions[0]).toContain('speaking with an AI assistant')
  })

  it('keeps the campaign systemPrompt before policy instructions and an explicit task goal', async () => {
    controller.setCallProfile({
      ...campaign({ persona: 'You are the appointment coordinator.' }),
      systemPrompt: 'Follow the complete appointment reminder script.'
    })

    await controller.dial('+13125550198', 'Confirm the appointment time.')

    const instructions = live.instructions[0] ?? ''
    expect(instructions.indexOf('Follow the complete appointment reminder script.')).toBeLessThan(
      instructions.indexOf('You are the appointment coordinator.')
    )
    expect(instructions.indexOf('You are the appointment coordinator.')).toBeLessThan(
      instructions.indexOf('Confirm the appointment time.')
    )
  })

  it('applies the selected campaign profile to outbound calls', async () => {
    controller.setCallProfile(campaign({ persona: 'Introduce the membership plan and learn booking intent' }))

    await controller.dial('+13125550198')

    expect(live.instructions[0]).toContain('Introduce the membership plan and learn booking intent')
    expect(live.voices[0]).toBe('juniper')
  })

  it('warms GPT Live while an incoming call is ringing', async () => {
    await controller.initialize()

    phone.ring()
    await flush()

    expect(live.starts).toEqual([undefined])
  })

  it('loads the selected campaign before registering for incoming calls', async () => {
    vi.mocked(window.livePhone.getCampaignWorkspace).mockResolvedValue({
      selectedCampaignId: 'campaign-inbound',
      campaigns: [{
        id: 'campaign-inbound',
        name: 'Inbound reception',
        direction: 'inbound',
        systemPrompt: "Learn the caller's issue and arrange follow-up",
        voice: 'maple',
        policy: {
          persona: "Learn the caller's issue and arrange follow-up",
          allowedTopics: [],
          forbiddenTopics: [],
          forbiddenClaims: [],
          negativePrompt: '',
          recordingDisclosure: true,
          maxCallDurationSec: 600,
          callingHours: { timeZone: 'UTC', windows: [] },
          doNotCall: [],
          blockedCallers: []
        },
        createdAt: 1,
        updatedAt: 1
      }]
    })

    await controller.initialize()
    phone.ring()
    await flush()

    expect(live.instructions[0]).toContain("Learn the caller's issue and arrange follow-up")
    expect(live.voices[0]).toBe('maple')
  })

  it('greets once when an active AI call becomes ready', async () => {
    vi.useFakeTimers()
    await controller.dial('+13125550198')
    phone.activate()
    const output = {
      getAudioTracks: () => [{ id: 'assistant-audio', readyState: 'live' }]
    } as unknown as MediaStream

    live.markReady(output)
    live.markReady(output)
    await vi.advanceTimersByTimeAsync(699)

    expect(live.spoken).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)

    expect(live.spoken).toHaveLength(1)
    expect(live.spoken[0]).not.toContain('AI')
    expect(live.spoken[0]).toBe('Hello, the call is connected.')
  })

  it('attaches a caller stream that becomes available after the call is active', async () => {
    vi.useFakeTimers()
    await controller.dial('+13125550198')
    phone.activate(false)
    await Promise.resolve()

    const callerStream = phone.releaseCallerStream()
    await vi.advanceTimersByTimeAsync(100)

    expect(live.attachedStreams).toContain(callerStream)
  })

  it('blocks an outbound dial on the DNC list and reports a guardrail event', async () => {
    controller.setCampaignSnapshot(campaign({ doNotCall: ['+13125550198'] }))

    await expect(controller.dial('+1 312 555-0198')).rejects.toThrow('DNC')

    expect(phone.events).not.toContain('dial')
    expect(window.livePhone.reportGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'pre-dial', kind: 'dnc_blocked' })
    )
  })

  it('uses outbound instructions for dials and inbound instructions for incoming calls', async () => {
    const activeCampaign = campaign({ openingInbound: 'Hi I am X', openingOutbound: 'Am I speaking with the decision maker?' })
    controller.setCallProfile(activeCampaign)
    controller.setCampaignSnapshot(activeCampaign)
    await controller.initialize()

    await controller.dial('+13125550198')
    expect(live.instructions[live.instructions.length - 1]).toContain('Am I speaking with the decision maker?')
    expect(live.instructions[live.instructions.length - 1]).not.toContain('Hi I am X')

    phone.ring()
    await flush()
    expect(live.instructions[live.instructions.length - 1]).toContain('Hi I am X')
    expect(live.instructions[live.instructions.length - 1]).not.toContain('Am I speaking with the decision maker?')
  })

  it('blocks an outbound dial outside calling hours', async () => {
    const now = new Date('2026-09-13T13:00:00Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    controller.setCampaignSnapshot(
      campaign({
        callingHours: {
          timeZone: 'UTC',
          windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '12:00' }]
        }
      })
    )

    await expect(controller.dial('+14155550199')).rejects.toThrow('calling window')

    expect(phone.events).not.toContain('dial')
    expect(window.livePhone.reportGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'pre-dial', kind: 'outside_calling_hours' })
    )
  })

  it('rejects a blocked inbound caller and reports a guardrail event', async () => {
    controller.setCampaignSnapshot(campaign({ blockedCallers: ['+13125550199'] }))
    await controller.initialize()

    phone.ring()
    await flush()

    expect(phone.rejected).toContain('call-incoming')
    expect(window.livePhone.reportGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-incoming', kind: 'blocked_caller' })
    )
  })

  it('hangs up with end reason max_duration once the policy limit is reached', async () => {
    vi.useFakeTimers()
    controller.setCampaignSnapshot(campaign({ maxCallDurationSec: 30 }))
    await controller.dial('+13125550198')
    phone.activate()
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(29_000)
    expect(phone.hungUp).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    expect(phone.hungUp).toEqual(['call-1'])
    expect(controller.getState().call?.status).toBe('ended')
  })

  it('persists remote_hangup when the phone side disconnects without a local request', async () => {
    await controller.dial('+13125550198')
    phone.activate()
    await flush()

    await controller.simulateRemoteHangup()

    expect(window.livePhone.reportCallLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        call: expect.objectContaining({ status: 'ended' }),
        endReason: 'remote_hangup'
      })
    )
  })

  it('ends an active phone call with session_error and suppresses trailing speech after realtime closes', async () => {
    await controller.dial('+13125550198')
    phone.activate()
    await flush()
    emitEvent({ type: 'assistant-message', text: 'before close' })
    expect(window.livePhone.appendSpeech).toHaveBeenCalledWith('before close')

    live.markDisconnected()
    await flush()
    await flush()
    emitEvent({ type: 'assistant-message', text: 'after close' })

    expect(phone.hungUp).toEqual(['call-1'])
    expect(window.livePhone.appendSpeech).not.toHaveBeenCalledWith('after close')
    expect(window.livePhone.reportCallLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        call: expect.objectContaining({ status: 'ended' }),
        endReason: 'session_error'
      })
    )
  })

  it('stops accepting speech and new assistant transcript entries after end_call is requested', async () => {
    await controller.dial('+13125550198')
    phone.activate()
    await flush()
    emitEvent({
      type: 'transcript',
      entry: { id: 'assistant-before', speaker: 'assistant', text: 'Goodbye.', final: true, timestamp: 1 }
    })

    emitEvent({ type: 'call-end-requested', callId: 'call-1' })
    emitEvent({ type: 'assistant-message', text: 'another farewell' })
    emitEvent({
      type: 'transcript',
      entry: { id: 'assistant-after', speaker: 'assistant', text: 'More speech.', final: true, timestamp: 2 }
    })
    await flush()

    expect(live.pauseCount).toBe(1)
    expect(window.livePhone.appendSpeech).not.toHaveBeenCalledWith('another farewell')
    expect(controller.getState().transcript.map(({ id }) => id)).toContain('assistant-before')
    expect(controller.getState().transcript.map(({ id }) => id)).not.toContain('assistant-after')
  })

  it('reports a single stable call id across outbound lifecycle transitions', async () => {
    await controller.dial('+13125550198')
    phone.activate()
    await flush()
    await controller.hangup()

    const ids = vi.mocked(window.livePhone.reportCallLifecycle).mock.calls
      .map(([lifecycle]) => lifecycle.call.id)
    expect(ids.length).toBeGreaterThanOrEqual(3)
    expect(new Set(ids)).toEqual(new Set(['call-1']))
  })

  it('counts max duration from the moment the call becomes active, not the dial start', async () => {
    vi.useFakeTimers()
    controller.setCampaignSnapshot(campaign({ maxCallDurationSec: 30 }))
    await controller.dial('+13125550198')
    await vi.advanceTimersByTimeAsync(10_000)
    phone.activateAt(Date.now() - 10_000)
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(29_000)
    expect(phone.hungUp).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    expect(phone.hungUp).toEqual(['call-1'])
  })

  it('reports a forbidden claim from an assistant transcript and hands off when configured', async () => {
    controller.setCampaignSnapshot(campaign({ forbiddenClaims: ['guaranteed refund'], onForbiddenClaim: 'handoff' }))
    await controller.dial('+13125550198')
    phone.activate()
    await Promise.resolve()

    emitEvent({
      type: 'transcript',
      entry: {
        id: 't1',
        speaker: 'assistant',
        text: 'we offer a guaranteed refund',
        final: true,
        timestamp: Date.now()
      }
    })

    expect(window.livePhone.reportGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'forbidden_claim', details: { claims: ['guaranteed refund'], entryId: 't1' } })
    )
    expect(controller.getState().controlMode).toBe('human')
  })

  it('reports a forbidden claim but keeps AI control in report mode', async () => {
    controller.setCampaignSnapshot(campaign({ forbiddenClaims: ['one-year free trial'] }))
    await controller.dial('+13125550198')
    phone.activate()
    await Promise.resolve()

    emitEvent({
      type: 'transcript',
      entry: {
        id: 't2',
        speaker: 'assistant',
        text: 'you can have a one-year free trial now',
        final: true,
        timestamp: Date.now()
      }
    })

    expect(window.livePhone.reportGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'forbidden_claim' })
    )
    expect(controller.getState().controlMode).toBe('ai')
  })

  it('resets control mode to ai after a remote hangup following human takeover', async () => {
    await controller.dial('+13125550198')
    phone.activate()
    await flush()
    await controller.setControlMode('human')
    expect(controller.getState().controlMode).toBe('human')
    expect(phone.controlModes).toEqual(['human'])

    await controller.simulateRemoteHangup()

    expect(controller.getState().controlMode).toBe('ai')
    expect(phone.controlModes).toEqual(['human', 'ai'])
  })

  it('resets control mode to ai after a local hangup following human takeover', async () => {
    await controller.dial('+13125550198')
    phone.activate()
    await flush()
    await controller.setControlMode('human')
    expect(controller.getState().controlMode).toBe('human')

    await controller.hangup()

    expect(controller.getState().controlMode).toBe('ai')
    expect(phone.controlModes.at(-1)).toBe('ai')
  })

  it('leaves control mode ai when a call that stayed in ai ends', async () => {
    await controller.dial('+13125550198')
    phone.activate()
    await flush()
    expect(controller.getState().controlMode).toBe('ai')

    await controller.hangup()

    expect(controller.getState().controlMode).toBe('ai')
    expect(phone.controlModes).toEqual(['ai'])
  })

  it('still finalizes recorder, live bridge, and campaign restore when control reset fails', async () => {
    const selected = campaign()
    const inline = {
      ...campaign({ persona: 'Use the inline campaign to introduce the new package' }),
      id: 'ephemeral-task-1',
      name: 'Inline campaign',
      direction: 'outbound' as const,
      voice: 'sol' as const
    }
    vi.mocked(window.livePhone.getCampaignWorkspace).mockResolvedValue({
      campaigns: [selected],
      selectedCampaignId: selected.id
    })
    vi.mocked(window.livePhone.getCampaign).mockResolvedValue(inline)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await controller.initialize()
    emitCommand({
      requestId: 'dial-inline',
      command: { type: 'dial', peer: '+13125550198', campaignId: inline.id },
      issuedAt: 1
    })
    await flush()
    phone.activate()
    await flush()
    expect(live.voices.at(-1)).toBe('sol')

    phone.failControlMode = new Error('audio graph torn down')
    await controller.hangup()

    expect(controller.getState().controlMode).toBe('ai')
    expect(recorder.stopCount).toBeGreaterThan(0)
    expect(live.stopCount).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalled()
    expect(phone.controlModes.at(-1)).toBe('ai')

    await controller.dial('+13125550197')
    expect(live.voices.at(-1)).toBe(selected.voice)
    warn.mockRestore()
  })
})
