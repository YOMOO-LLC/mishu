import type {
  CallEndReason,
  Campaign,
  CodexConnectionState,
  GuardrailEventKind,
  LivePhoneEvent,
  PhoneCall,
  PhoneCommandErrorCode,
  PhoneCommandRequest,
  PhoneCommandResult,
  PhoneStatusSnapshot,
  RealtimeVoice,
  TranscriptEntry
} from '../../../shared/contracts'
import { buildRealtimeInstructions } from './call-brief'
import { CallRecorder, type RecordingTransport } from './call-recorder'
import { GptLiveSession } from './gpt-live-session'
import {
  evaluateDialGuard,
  evaluateInboundGuard,
  hasExceededMaxDuration,
  matchForbiddenClaims
} from './guardrails'
import { MockPhoneAdapter } from './mock-phone'
import { normalizePhoneNumber } from './phone-number'
import { maskPhoneNumber } from '../../../shared/phone-mask'
import { appendTaskGoal, compilePolicyInstructions } from './policy-instructions'
import { TwilioPhoneAdapter } from './twilio-phone'
import type { ControlMode, PhoneAdapter, PhoneControllerState } from './types'

const INITIAL_STATE: PhoneControllerState = {
  runtimeMode: 'loading',
  phoneConnection: 'idle',
  codexConnection: { status: 'idle' },
  controlMode: 'ai',
  transcript: []
}

const INBOUND_READY_GREETING = 'Hello, the call is connected. How can I help you?'
const OUTBOUND_READY_GREETING = 'Hello, the call is connected.'
const OUTBOUND_GREETING_DELAY_MS = 700
const CALLER_STREAM_POLL_MS = 50
const CALLER_STREAM_TIMEOUT_MS = 5_000
const DEFAULT_GUARDRAIL_TICK_MS = 1_000

interface CampaignContext {
  configuredInboundInstructions?: string
  configuredOutboundInstructions?: string
  configuredSystemPrompt?: string
  configuredVoice?: RealtimeVoice
  campaignSnapshot?: Campaign
}

export class PhoneController {
  private voiceStartPolicy: 'on_dial' | 'on_answer' = 'on_dial'
  private state = INITIAL_STATE
  private phone?: PhoneAdapter
  private readonly live: GptLiveSession
  private readonly phoneFactory: (mockMode: boolean) => PhoneAdapter
  private readonly listeners = new Set<() => void>()
  private unsubscribePhone?: () => void
  private unsubscribeLive?: () => void
  private unsubscribeEvents?: () => void
  private unsubscribeCommands?: () => void
  private initialized?: Promise<void>
  private bridgedCallId?: string
  private greetedCallId?: string
  private announcingCallId?: string
  private prewarmedIncomingCallId?: string
  private activeInstructions?: string
  private activeVoice?: RealtimeVoice
  private configuredInboundInstructions?: string
  private configuredOutboundInstructions?: string
  private configuredSystemPrompt?: string
  private configuredVoice?: RealtimeVoice
  private callerAudioReadyCallId?: string
  private campaignSnapshot?: Campaign
  private commandCampaignRestore?: CampaignContext
  private endReason?: CallEndReason
  private acceptsRealtimeSpeech = false
  private endRequestedCallId?: string
  private assistantEntriesBeforeEndRequest = new Set<string>()
  private sessionFailureCallId?: string
  private sessionFailure?: Promise<void>
  private readonly recorder: CallRecorder
  private durationTimer?: ReturnType<typeof setInterval>
  private blockedIncomingCallIds = new Set<string>()
  private guardrailTickMs = DEFAULT_GUARDRAIL_TICK_MS
  private answeredAt?: number
  private pendingTerminalState?: Promise<void>

  constructor(
    live = new GptLiveSession(),
    phoneFactory: (mockMode: boolean) => PhoneAdapter = (mockMode) =>
      mockMode ? new MockPhoneAdapter() : new TwilioPhoneAdapter(),
    recorder?: CallRecorder
  ) {
    this.live = live
    this.phoneFactory = phoneFactory
    this.recorder = recorder ?? new CallRecorder({ transport: recordingTransport })
  }

  getState = (): PhoneControllerState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  initialize = async (): Promise<void> => {
    this.initialized ??= this.initializeOnce()
    return this.initialized
  }

  setCallProfile = (campaign: Campaign): void => {
    this.configuredSystemPrompt = campaign.systemPrompt.trim()
    this.configuredInboundInstructions = compilePolicyInstructions(
      campaign.policy,
      'inbound',
      campaign.systemPrompt
    )
    this.configuredOutboundInstructions = compilePolicyInstructions(
      campaign.policy,
      'outbound',
      campaign.systemPrompt
    )
    this.configuredVoice = campaign.voice
  }

  setCampaignSnapshot = (campaign: Campaign): void => {
    this.campaignSnapshot = campaign
    this.publishStatus()
  }

  dial = async (peer: string, goal?: string, voice?: RealtimeVoice): Promise<void> => {
    await this.initialize()
    const normalizedPeer = normalizePhoneNumber(peer)
    const policy = this.campaignSnapshot?.policy
    if (policy) {
      const result = evaluateDialGuard(policy, normalizedPeer, new Date())
      if (!result.allowed) {
        this.reportGuardrailEvent({
          kind: result.reason === 'dnc' ? 'dnc_blocked' : 'outside_calling_hours',
          details: { peer: maskPhoneNumber(normalizedPeer), message: result.message }
        })
        this.setState({ ...this.state, error: result.message })
        throw new Error(result.message)
      }
    }
    const normalizedGoal = goal?.trim()
    if (!normalizedGoal || normalizedGoal === this.configuredSystemPrompt) {
      this.activeInstructions = this.configuredOutboundInstructions
    } else {
      this.activeInstructions = this.configuredOutboundInstructions
        ? appendTaskGoal(this.configuredOutboundInstructions, normalizedGoal)
        : buildRealtimeInstructions(normalizedGoal)
    }
    this.activeVoice = voice ?? this.configuredVoice
    this.sessionFailureCallId = undefined
    this.sessionFailure = undefined
    this.setState({ ...this.state, error: undefined })
    this.voiceStartPolicy = (await window.livePhone.getVoiceSettings?.())?.startPolicy ?? 'on_dial'
    const prewarm = this.voiceStartPolicy === 'on_dial' && this.state.runtimeMode === 'twilio' && this.state.controlMode === 'ai'
      ? this.prewarmLiveBridge().catch(async (error: unknown) => {
        await this.endCurrentCallAfterSessionFailure(error)
        throw error
      })
      : undefined
    try {
      await Promise.all([this.phone?.dial(normalizedPeer), prewarm])
    } catch (error) {
      if (prewarm) await this.stopLiveBridge()
      throw error
    }
  }

  answer = async (): Promise<void> => {
    await this.initialize()
    await this.phone?.answer()
  }

  reject = async (): Promise<void> => {
    this.endReason = 'rejected'
    await this.phone?.reject()
    await this.pendingTerminalState
  }

  hangup = async (reason: 'local_hangup' | 'max_duration' = 'local_hangup'): Promise<void> => {
    this.endReason = reason
    await this.phone?.hangup(reason)
    await this.pendingTerminalState
    await this.stopLiveBridge()
  }

  setControlMode = async (mode: ControlMode): Promise<void> => {
    this.setState({ ...this.state, controlMode: mode })
    await this.phone?.setControlMode(mode)
    if (mode === 'human') {
      await this.live.pauseInput()
    } else if (this.state.call?.status === 'active' && this.state.runtimeMode === 'twilio') {
      await this.live.start(this.phone?.getCallerStream(), this.activeInstructions, this.activeVoice)
      await this.attachCallerStreamWhenReady(this.state.call.id)
      await this.syncLiveState()
    }
  }

  simulateIncoming = async (peer?: string): Promise<void> => {
    await this.initialize()
    if (!this.phone?.simulateIncoming) throw new Error('Simulated calls are only available in mock mode')
    await this.phone.simulateIncoming(peer)
  }

  simulateRemoteHangup = async (): Promise<void> => {
    await this.initialize()
    if (!this.phone?.simulateRemoteHangup) {
      throw new Error('Simulated remote hangup is only available in mock mode')
    }
    await this.phone.simulateRemoteHangup()
    await this.pendingTerminalState
  }

  dispose = async (): Promise<void> => {
    this.unsubscribePhone?.()
    this.unsubscribeLive?.()
    this.unsubscribeEvents?.()
    this.unsubscribeCommands?.()
    this.unsubscribeCommands = undefined
    this.stopDurationTimer()
    this.answeredAt = undefined
    await this.recorder.stop()
    await this.live.stop().catch(() => undefined)
    await this.phone?.dispose()
    this.initialized = undefined
    this.bridgedCallId = undefined
    this.greetedCallId = undefined
    this.announcingCallId = undefined
    this.prewarmedIncomingCallId = undefined
    this.activeInstructions = undefined
    this.activeVoice = undefined
    this.callerAudioReadyCallId = undefined
    this.campaignSnapshot = undefined
    this.commandCampaignRestore = undefined
    this.endReason = undefined
    this.acceptsRealtimeSpeech = false
    this.endRequestedCallId = undefined
    this.assistantEntriesBeforeEndRequest.clear()
    this.sessionFailureCallId = undefined
    this.sessionFailure = undefined
    this.blockedIncomingCallIds = new Set()
    this.setState(INITIAL_STATE)
  }

  private async initializeOnce(): Promise<void> {
    try {
      this.unsubscribeCommands ??= window.livePhone.onPhoneCommand?.(this.handlePhoneCommand)
      const [config, campaignWorkspace] = await Promise.all([
        window.livePhone.getRuntimeConfig(),
        window.livePhone.getCampaignWorkspace()
      ])
      const selectedCampaign = campaignWorkspace.campaigns.find(
        ({ id }) => id === campaignWorkspace.selectedCampaignId
      )
      if (selectedCampaign) {
        this.setCallProfile(selectedCampaign)
        this.setCampaignSnapshot(selectedCampaign)
      }
      this.phone = this.phoneFactory(config.mockMode)
      this.guardrailTickMs = config.guardrailTickMs ?? DEFAULT_GUARDRAIL_TICK_MS
      this.setState({
        ...this.state,
        runtimeMode: config.mockMode ? 'mock' : 'twilio',
        twilioPhoneNumber: config.twilioPhoneNumber,
        configPath: config.configPath,
        runtimeNotice: config.runtimeNotice,
        codexCommand: config.codexCommand,
        codexError: config.codexError,
        ...(!config.mockMode && config.codexError
          ? { codexConnection: { status: 'error', message: config.codexError } as const }
          : {})
      })

      this.unsubscribePhone = this.phone.subscribe(() => void this.onPhoneStateChange())
      this.unsubscribeLive = this.live.subscribe(() => void this.syncLiveState())
      this.unsubscribeEvents = window.livePhone.onEvent(this.onLivePhoneEvent)
      await this.phone.initialize(config.twilioToken)

      if (config.mockMode) {
        this.setState({
          ...this.state,
          codexConnection: { status: 'ready', threadId: 'mock-thread', sessionId: 'mock-session' }
        })
      }
      await this.onPhoneStateChange()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({
        ...this.state,
        phoneConnection: 'error',
        error: message
      })
      throw error
    }
  }

  private onPhoneStateChange = async (): Promise<void> => {
    const phoneState = this.phone?.getState()
    if (!phoneState) return
    if (
      phoneState.call &&
      phoneState.call.id !== this.endRequestedCallId &&
      (phoneState.call.status === 'ringing' || phoneState.call.status === 'dialing')
    ) {
      this.endRequestedCallId = undefined
      this.assistantEntriesBeforeEndRequest.clear()
    }
    const nextState: PhoneControllerState = {
      ...this.state,
      phoneConnection: phoneState.connection,
      call: phoneState.call,
      error: phoneState.error ?? this.state.error
    }
    const terminal = phoneState.call?.status === 'ended' || phoneState.call?.status === 'error'
    if (terminal) {
      this.acceptsRealtimeSpeech = false
      this.endReason ??= phoneState.endReason
    }
    if (!terminal) this.setState(nextState)

    if (
      phoneState.call?.direction === 'inbound' &&
      phoneState.call.status === 'ringing' &&
      phoneState.call.id !== this.prewarmedIncomingCallId
    ) {
      this.prewarmedIncomingCallId = phoneState.call.id
      const policy = this.campaignSnapshot?.policy
      const guard = policy ? evaluateInboundGuard(policy, phoneState.call.peer) : undefined
      if (guard && !guard.allowed) {
        this.blockedIncomingCallIds.add(phoneState.call.id)
        this.reportGuardrailEvent({
          kind: 'blocked_caller',
          callId: phoneState.call.id,
          details: { peer: maskPhoneNumber(phoneState.call.peer), message: guard.message }
        })
        void this.phone?.reject()
        return
      }
      this.activeInstructions = this.configuredInboundInstructions
      this.activeVoice = this.configuredVoice
      this.voiceStartPolicy = (await window.livePhone.getVoiceSettings?.())?.startPolicy ?? 'on_dial'
      if (this.phone?.getState().call?.id !== phoneState.call.id || this.phone.getState().call?.status !== 'ringing') return
      if (this.state.runtimeMode === 'twilio' && this.state.controlMode === 'ai') {
        if (this.voiceStartPolicy === 'on_dial') void this.prewarmLiveBridge().catch((error: unknown) =>
          this.endCurrentCallAfterSessionFailure(error))
      }
    }

    if (phoneState.call?.status === 'active' && phoneState.call.id !== this.bridgedCallId) {
      this.bridgedCallId = phoneState.call.id
      if (this.blockedIncomingCallIds.has(phoneState.call.id)) return
      void this.reportLifecycle(phoneState.call)
      this.answeredAt = Date.now()
      this.startDurationTimer()
      if (this.state.runtimeMode === 'mock') {
        this.recorder.start(phoneState.call.id, this.phone?.getCallerStream())
        const assistantStream = this.phone?.getAssistantStream?.()
        if (assistantStream) this.recorder.setAssistantStream(assistantStream)
        this.appendMockConversation()
      } else if (this.state.controlMode === 'ai') {
        this.recorder.start(phoneState.call.id, this.phone?.getCallerStream())
        try {
          await this.live.start(
            this.phone?.getCallerStream(),
            this.activeInstructions,
            this.activeVoice
          )
          await this.attachCallerStreamWhenReady(phoneState.call.id)
          await this.syncLiveState()
        } catch (error) {
          await this.endCurrentCallAfterSessionFailure(error)
        }
      }
    }

    if (terminal && phoneState.call) {
      const completion = this.finishTerminalState(phoneState.call, nextState)
      this.pendingTerminalState = completion
      try {
        await completion
      } finally {
        if (this.pendingTerminalState === completion) this.pendingTerminalState = undefined
      }
      return
    }

    if (phoneState.call) void this.reportLifecycle(phoneState.call)
  }

  private async finishTerminalState(call: PhoneCall, nextState: PhoneControllerState): Promise<void> {
    this.stopDurationTimer()
    this.answeredAt = undefined
    this.blockedIncomingCallIds.delete(call.id)
    await this.reportLifecycle(call)
    // Next inbound must not inherit human takeover; restore AI routing after cleanup.
    this.setState({ ...nextState, controlMode: 'ai' })
    await this.recorder.stop().catch((error: unknown) => {
      console.warn('Failed to stop call recorder after hangup', error)
    })
    await this.stopLiveBridge().catch((error: unknown) => {
      console.warn('Failed to stop GPT Live bridge after hangup', error)
    })
    await this.phone?.setControlMode('ai').catch((error: unknown) => {
      console.warn('Failed to reset call control mode to AI after hangup', error)
    })
    this.restoreCommandCampaign()
  }

  private async reportLifecycle(call: PhoneCall): Promise<void> {
    const codexConnection = this.state.codexConnection
    const ending =
      call.status === 'ended' || call.status === 'error'
        ? { endReason: this.endReason ?? ('unknown' as const) }
        : {}
    const campaign = this.campaignSnapshot
    await window.livePhone
      .reportCallLifecycle({
        call,
        runtimeMode: this.state.runtimeMode === 'loading' ? 'mock' : this.state.runtimeMode,
        ...(campaign ? { campaign } : {}),
        ...(codexConnection.threadId ? { threadId: codexConnection.threadId } : {}),
        ...(codexConnection.sessionId ? { sessionId: codexConnection.sessionId } : {}),
        ...ending
      })
      .catch(() => undefined)
    if (call.status === 'ended' || call.status === 'error') this.endReason = undefined
  }

  private onLivePhoneEvent = (event: LivePhoneEvent): void => {
    if (event.type === 'codex-state') {
      this.handleRealtimeConnection(event.state)
    } else if (event.type === 'transcript') {
      if (
        event.entry.speaker === 'assistant' &&
        this.endRequestedCallId === this.state.call?.id &&
        !this.assistantEntriesBeforeEndRequest.has(event.entry.id)
      ) return
      this.upsertTranscript(event.entry)
      this.monitorForbiddenClaims(event.entry)
    } else if (event.type === 'assistant-message') {
      if (
        this.acceptsRealtimeSpeech &&
        this.state.call?.status === 'active' &&
        this.state.controlMode === 'ai'
      ) {
        void window.livePhone.appendSpeech(event.text).catch(() => undefined)
      }
    } else if (event.type === 'call-end-requested') {
      if (event.callId !== this.state.call?.id) return
      this.endRequestedCallId = event.callId
      this.assistantEntriesBeforeEndRequest = new Set(
        this.state.transcript
          .filter(({ speaker }) => speaker === 'assistant')
          .map(({ id }) => id)
      )
      this.acceptsRealtimeSpeech = false
      void this.live.pauseInput().catch(() => undefined)
    } else if (event.type === 'error') {
      this.setState({ ...this.state, error: `${event.source}: ${event.message}` })
    }
  }

  private monitorForbiddenClaims(entry: TranscriptEntry): void {
    if (entry.speaker !== 'assistant' || !entry.final) return
    const policy = this.campaignSnapshot?.policy
    if (!policy || policy.forbiddenClaims.length === 0) return
    const matched = matchForbiddenClaims(policy, entry.text)
    if (matched.length === 0) return
    this.reportGuardrailEvent({
      kind: 'forbidden_claim',
      details: { claims: matched, entryId: entry.id }
    })
    if (policy.onForbiddenClaim === 'handoff' && this.state.call?.status === 'active') {
      void this.setControlMode('human').catch(() => undefined)
    }
  }

  private startDurationTimer(): void {
    this.stopDurationTimer()
    const policy = this.campaignSnapshot?.policy
    if (!policy || !this.answeredAt) return
    this.durationTimer = setInterval(() => {
      const call = this.state.call
      if (!call || call.status !== 'active' || !this.answeredAt) return
      if (hasExceededMaxDuration(policy, this.answeredAt, Date.now())) {
        this.stopDurationTimer()
        this.reportGuardrailEvent({
          kind: 'max_duration',
          callId: call.id,
          details: { maxCallDurationSec: policy.maxCallDurationSec, message: 'Call reached the maximum duration' }
        })
        this.setState({ ...this.state, error: 'Call reached the maximum duration and was hung up automatically' })
        void this.hangup('max_duration')
      }
    }, this.guardrailTickMs)
  }

  private stopDurationTimer(): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer)
      this.durationTimer = undefined
    }
  }

  private reportGuardrailEvent(event: {
    kind: GuardrailEventKind
    callId?: string
    details?: Record<string, unknown>
  }): void {
    void window.livePhone
      .reportGuardrailEvent({
        callId: event.callId ?? this.state.call?.id ?? 'pre-dial',
        kind: event.kind,
        at: Date.now(),
        ...(event.details ? { details: event.details } : {})
      })
      .catch(() => undefined)
  }

  private async stopLiveBridge(): Promise<void> {
    this.acceptsRealtimeSpeech = false
    this.bridgedCallId = undefined
    this.greetedCallId = undefined
    this.announcingCallId = undefined
    this.prewarmedIncomingCallId = undefined
    this.activeInstructions = undefined
    this.callerAudioReadyCallId = undefined
    if (this.state.runtimeMode === 'twilio' && this.live.getState().connection.status !== 'idle') {
      await this.live.stop().catch(() => undefined)
    }
  }

  private async prewarmLiveBridge(): Promise<void> {
    try {
      await this.live.start(undefined, this.activeInstructions, this.activeVoice)
    } catch (error) {
      this.setState({
        ...this.state,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  private async syncLiveState(): Promise<void> {
    const liveState = this.live.getState()
    this.handleRealtimeConnection(liveState.connection)
    if (liveState.outputStream) {
      this.recorder.setAssistantStream(liveState.outputStream)
      await this.phone?.setAssistantStream(liveState.outputStream)
    }
    await this.announceReadyCall(liveState)
  }

  private handleRealtimeConnection(connection: CodexConnectionState): void {
    const sessionWasAvailable = this.acceptsRealtimeSpeech
    this.acceptsRealtimeSpeech =
      this.endRequestedCallId !== this.state.call?.id &&
      (connection.status === 'connecting' || connection.status === 'ready')
    this.setState({ ...this.state, codexConnection: connection })
    if (
      sessionWasAvailable &&
      !this.acceptsRealtimeSpeech &&
      this.state.runtimeMode === 'twilio' &&
      this.state.controlMode === 'ai' &&
      this.hasCallInProgress()
    ) {
      void this.endCallAfterSessionFailure(this.state.call!.id, connection.message)
    }
  }

  private async endCurrentCallAfterSessionFailure(error: unknown): Promise<void> {
    const call = this.state.call
    if (!call || ['ended', 'error'].includes(call.status)) return
    await this.endCallAfterSessionFailure(
      call.id,
      error instanceof Error ? error.message : String(error)
    )
    await this.pendingTerminalState
  }

  private async endCallAfterSessionFailure(callId: string, message?: string): Promise<void> {
    if (this.sessionFailureCallId === callId && this.sessionFailure) {
      await this.sessionFailure
      return
    }
    this.sessionFailureCallId = callId
    const completion = (async () => {
      this.endReason = 'session_error'
      if (message) this.setState({ ...this.state, error: message })
      await this.phone?.hangup('session_error').catch((error: unknown) => {
        this.setState({
          ...this.state,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      await this.pendingTerminalState
    })()
    this.sessionFailure = completion
    await completion
  }

  private async attachCallerStreamWhenReady(callId: string): Promise<boolean> {
    const deadline = Date.now() + CALLER_STREAM_TIMEOUT_MS
    while (
      this.state.call?.id === callId &&
      this.state.call.status === 'active' &&
      this.state.controlMode === 'ai'
    ) {
      const stream = this.phone?.getCallerStream()
      if (stream) {
        await this.live.setInputStream(stream)
        this.callerAudioReadyCallId = callId
        return true
      }
      if (Date.now() >= deadline) {
        throw new Error('Twilio caller audio did not become available in time')
      }
      await delay(CALLER_STREAM_POLL_MS)
    }
    return false
  }

  private async announceReadyCall(liveState: ReturnType<GptLiveSession['getState']>): Promise<void> {
    const call = this.state.call
    if (
      this.state.runtimeMode !== 'twilio' ||
      this.state.controlMode !== 'ai' ||
      call?.status !== 'active' ||
      call.id !== this.bridgedCallId ||
      call.id !== this.callerAudioReadyCallId ||
      liveState.connection.status !== 'ready' ||
      !liveState.outputStream?.getAudioTracks().some(({ readyState }) => readyState === 'live') ||
      this.greetedCallId === call.id ||
      this.announcingCallId === call.id
    ) {
      return
    }

    this.announcingCallId = call.id
    try {
      if (call.direction === 'outbound') {
        await delay(OUTBOUND_GREETING_DELAY_MS)
        const currentCall = this.state.call
        const currentLiveState = this.live.getState()
        if (
          currentCall?.id !== call.id ||
          currentCall.status !== 'active' ||
          this.state.controlMode !== 'ai' ||
          currentLiveState.connection.status !== 'ready' ||
          !currentLiveState.outputStream?.getAudioTracks().some(
            ({ readyState }) => readyState === 'live'
          )
        ) {
          return
        }
      }
      await this.live.speak(
        call.direction === 'outbound' ? OUTBOUND_READY_GREETING : INBOUND_READY_GREETING
      )
      this.greetedCallId = call.id
    } catch (error) {
      this.setState({
        ...this.state,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (this.announcingCallId === call.id) this.announcingCallId = undefined
    }
  }

  private appendMockConversation(): void {
    const now = Date.now()
    const entries: TranscriptEntry[] = [
      {
        id: `mock-caller-${this.bridgedCallId}`,
        speaker: 'caller',
        text: 'Hi, I am calling to check whether the assistant is available.',
        final: true,
        timestamp: now
      },
      {
        id: `mock-assistant-${this.bridgedCallId}`,
        speaker: 'assistant',
        text: 'Yes, I am here and ready to help.',
        final: true,
        timestamp: now + 1
      }
    ]
    this.setState({ ...this.state, transcript: [...this.state.transcript, ...entries] })
    for (const entry of entries) {
      void window.livePhone.reportTranscriptEntry(entry).catch(() => undefined)
    }
  }

  private upsertTranscript(entry: TranscriptEntry): void {
    const index = this.state.transcript.findIndex(({ id }) => id === entry.id)
    const transcript = [...this.state.transcript]
    if (index === -1) transcript.push(entry)
    else transcript[index] = entry
    this.setState({ ...this.state, transcript })
  }

  private readonly handlePhoneCommand = async (request: PhoneCommandRequest): Promise<void> => {
    let result: PhoneCommandResult
    try {
      switch (request.command.type) {
        case 'dial': {
          if (this.hasCallInProgress()) {
            throw new PhoneCommandHandlerError('CALL_IN_PROGRESS', 'A call is already in progress')
          }
          let peer: string
          try {
            peer = normalizePhoneNumber(request.command.peer)
          } catch (error) {
            throw new PhoneCommandHandlerError(
              'INVALID_NUMBER',
              error instanceof Error ? error.message : String(error)
            )
          }
          if (request.command.campaignId) {
            const campaign = await window.livePhone.getCampaign(request.command.campaignId)
            if (campaign.direction === 'inbound') {
              throw new PhoneCommandHandlerError(
                'GUARDRAIL_BLOCKED',
                'The requested campaign cannot place outbound calls'
              )
            }
            this.commandCampaignRestore = this.captureCampaignContext()
            this.setCallProfile(campaign)
            this.setCampaignSnapshot(campaign)
          }
          try {
            const guard = this.campaignSnapshot
              ? evaluateDialGuard(this.campaignSnapshot.policy, peer, new Date())
              : undefined
            if (guard && !guard.allowed) {
              await this.dial(peer).catch(() => undefined)
              throw new PhoneCommandHandlerError('GUARDRAIL_BLOCKED', guard.message)
            }
            await this.dial(peer, request.command.goal)
          } catch (error) {
            if (!this.hasCallInProgress()) this.restoreCommandCampaign()
            throw error
          }
          break
        }
        case 'hangup':
          this.requireActiveCall()
          await this.hangup()
          break
        case 'answer':
          this.requireRingingCall()
          await this.answer()
          break
        case 'reject':
          this.requireRingingCall()
          await this.reject()
          break
        case 'simulateIncoming':
          if (this.state.runtimeMode !== 'mock' || !this.phone?.simulateIncoming) {
            throw new PhoneCommandHandlerError('MOCK_ONLY', 'Simulated incoming calls are only available in mock mode')
          }
          await this.simulateIncoming(request.command.peer)
          break
        case 'simulateRemoteHangup':
          if (this.state.runtimeMode !== 'mock' || !this.phone?.simulateRemoteHangup) {
            throw new PhoneCommandHandlerError('MOCK_ONLY', 'Simulated remote hangup is only available in mock mode')
          }
          this.requireActiveCall()
          await this.simulateRemoteHangup()
          break
        case 'simulateRealtimeStartFailure':
          if (this.state.runtimeMode !== 'mock') {
            throw new PhoneCommandHandlerError(
              'MOCK_ONLY',
              'Simulated realtime failures are only available in mock mode'
            )
          }
          this.requireActiveCall()
          this.handleRealtimeConnection({ status: 'connecting' })
          this.handleRealtimeConnection({
            status: 'error',
            message: 'Mock realtime SDP startup failed'
          })
          await this.endCurrentCallAfterSessionFailure(
            new Error('Mock realtime SDP startup failed')
          )
          break
        case 'setControlMode':
          this.requireActiveCall()
          await this.setControlMode(request.command.mode)
          break
        case 'getStatus':
          break
      }
      result = { requestId: request.requestId, ok: true, status: this.toStatusSnapshot() }
    } catch (error) {
      result = {
        requestId: request.requestId,
        ok: false,
        code: error instanceof PhoneCommandHandlerError ? error.code : 'RENDERER_ERROR',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    window.livePhone.respondPhoneCommand?.(result)
  }

  private hasCallInProgress(): boolean {
    return Boolean(this.state.call && !['idle', 'ended', 'error'].includes(this.state.call.status))
  }

  private requireActiveCall(): void {
    if (!this.hasCallInProgress()) {
      throw new PhoneCommandHandlerError('NO_ACTIVE_CALL', 'There is no active call')
    }
  }

  private requireRingingCall(): void {
    if (this.state.call?.status !== 'ringing') {
      throw new PhoneCommandHandlerError('NO_ACTIVE_CALL', 'There is no ringing call')
    }
  }

  private toStatusSnapshot(): PhoneStatusSnapshot {
    if (this.state.runtimeMode === 'loading') {
      throw new PhoneCommandHandlerError('APP_NOT_READY', 'Phone controller is still loading')
    }
    return {
      runtimeMode: this.state.runtimeMode,
      phoneConnection: this.state.phoneConnection,
      codexConnection: this.state.codexConnection,
      ...(this.state.call ? { call: this.state.call } : {}),
      controlMode: this.state.controlMode,
      ...(this.campaignSnapshot ? { selectedCampaignId: this.campaignSnapshot.id } : {}),
      ...(this.state.configPath ? { configPath: this.state.configPath } : {}),
      ...(this.state.runtimeNotice ? { runtimeNotice: this.state.runtimeNotice } : {}),
      ...(this.state.codexCommand ? { codexCommand: this.state.codexCommand } : {}),
      ...(this.state.codexError ? { codexError: this.state.codexError } : {}),
      updatedAt: Date.now()
    }
  }

  private captureCampaignContext(): CampaignContext {
    return {
      configuredInboundInstructions: this.configuredInboundInstructions,
      configuredOutboundInstructions: this.configuredOutboundInstructions,
      configuredSystemPrompt: this.configuredSystemPrompt,
      configuredVoice: this.configuredVoice,
      campaignSnapshot: this.campaignSnapshot
    }
  }

  private restoreCommandCampaign(): void {
    const context = this.commandCampaignRestore
    if (!context) return
    this.commandCampaignRestore = undefined
    this.configuredInboundInstructions = context.configuredInboundInstructions
    this.configuredOutboundInstructions = context.configuredOutboundInstructions
    this.configuredSystemPrompt = context.configuredSystemPrompt
    this.configuredVoice = context.configuredVoice
    this.campaignSnapshot = context.campaignSnapshot
    this.publishStatus()
  }

  private setState(state: PhoneControllerState): void {
    this.state = state
    for (const listener of this.listeners) listener()
    this.publishStatus()
  }

  private publishStatus(): void {
    if (this.state.runtimeMode === 'loading') return
    try {
      window.livePhone.publishPhoneStatus?.(this.toStatusSnapshot())
    } catch {
      // The preload bridge can be absent in isolated renderer unit tests.
    }
  }
}

class PhoneCommandHandlerError extends Error {
  constructor(readonly code: PhoneCommandErrorCode, message: string) {
    super(message)
    this.name = 'PhoneCommandHandlerError'
  }
}

const recordingTransport: RecordingTransport = {
  start: (callId, mime) => window.livePhone.recordStart({ callId, mime }),
  chunk: (callId, seq, data) => window.livePhone.recordChunk({ callId, seq, data }),
  finish: (callId, durationMs) => window.livePhone.recordFinish({ callId, durationMs })
}

export const phoneController = new PhoneController()

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
