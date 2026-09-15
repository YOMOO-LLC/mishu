import { randomUUID } from 'node:crypto'
import { systemClock, type Clock } from '@mishu/core/clock'
import {
  classifyTranscriptInterrupt,
  formatHangupDecidedLog,
  formatHangupEndCallFailedLog,
  formatHangupEndCallOkLog,
  formatHangupPlaybackWaitLog,
  formatHangupSkippedLog,
  formatHangupTurnsLog,
  formatInterruptLog,
  hangupEndCallErrorCode,
  mergeTurnText,
  normalizeHangupTurns,
  type HangupJudge,
  type TranscriptTurn
} from '@mishu/core/hangup'
import type { TwilioRestPort } from '../telephony/twilio-rest-port.js'
import {
  mulawFrameToPcm24kBase64,
  Pcm24kOutboundAssembler,
  type LiveAudioFormatName
} from './protocol/audio-transcode.js'
import {
  buildCommentaryAppend,
  buildFallbackVoicemailInstruction,
  buildInputAudioAppend,
  buildSessionClose,
  buildSessionStart,
  isCallerSpeechSignal,
  parseGptLiveServerEvent,
  type GptLiveClientEvent
} from './protocol/gpt-live.js'
import {
  extractSequenceNumber,
  outboundClearMessage,
  outboundMarkMessage,
  outboundMediaMessage,
  parseTwilioMessage,
  sequenceDelta,
  type TwilioStartMessage
} from './protocol/twilio-media.js'
import { FRAME_DURATION_MS, isSpeechFrame } from './protocol/mulaw.js'
import { redactSid } from './protocol/redact.js'
import { createMetrics, exportMetricsJson, type BridgeMetrics, type InterruptSource } from './metrics.js'

const DEFAULT_INBOUND_CAP = 50
const DEFAULT_OUTBOUND_CAP = 25
/** 25 × 20 ms of inbound silence after barge-in before assistant audio may resume. */
export const DEFAULT_UNSUPPRESS_SILENCE_FRAMES = 25
const CALLER_UTTERANCE_SILENCE_FRAMES = 15
/** Transcript idle before a hangup check. Audio deltas must not reset this. */
export const DEFAULT_HANGUP_SILENCE_MS = 900
/** Max wait after end=true before endCall. pcm24k silence never drains the queue. */
export const DEFAULT_HANGUP_PLAYBACK_WAIT_MS = 500
const GREETING_GUARD_TIMEOUT_MS = 8_000

export interface BridgeIdentity {
  tenantId: string
  callId: string
}

export type BridgeObservation =
  | { tenantId: string; callId: string; type: 'started'; sessionId: string }
  | { tenantId: string; callId: string; type: 'interrupt'; at: number; source: InterruptSource }
  | { tenantId: string; callId: string; type: 'usage'; seconds: number }
  | { tenantId: string; callId: string; type: 'hangup'; reason: string }
  | { tenantId: string; callId: string; type: 'closed'; reason: string; usageSeconds?: number }
  | { tenantId: string; callId: string; type: 'error'; reason: string }

export type BridgeDecisionKind = 'forward' | 'drop' | 'interrupt' | 'unsuppress'

export interface BridgeDecision {
  kind: BridgeDecisionKind
  at: number
  reason?: string
  source?: InterruptSource
}

export interface MediaBridgeOptions {
  identity: BridgeIdentity
  instructions: string
  voice: string
  sendToTwilio: (json: string) => void
  sendToGptLive: (event: GptLiveClientEvent) => void
  clock?: Clock
  inboundCap?: number
  outboundCap?: number
  energyBargeIn?: boolean
  energyThreshold?: number
  energyFrames?: number
  unsuppressSilenceFrames?: number
  audioFormat?: LiveAudioFormatName
  openingLine?: string
  twilioRest?: TwilioRestPort
  judgeHangup?: HangupJudge
  hangupSilenceMs?: number
  hangupPlaybackWaitMs?: number
  observe?: (event: BridgeObservation) => void
  onDecision?: (decision: BridgeDecision) => void
  log?: (line: string) => void
}

export class MediaBridge {
  readonly identity: BridgeIdentity
  private streamSid?: string
  private twilioCallSid?: string
  private gptReady = false
  private closing = false
  private closed = false
  private gptFailed = false
  private suppressOutbound = false
  private awaitingNewAssistantTurn = false
  private lastTwilioSeq?: number
  private markSeq = 0
  private unackedMarks = 0
  private marksHeard = 0
  private inboundQueue: string[] = []
  private outboundQueue: string[] = []
  private energyRun = 0
  private postInterruptSilenceRun = 0
  private lastInboundWasSpeech = false
  private greetingGuard = false
  private greetingAudioFlushed = false
  private greetingTimer?: unknown
  private callerWasSpeaking = false
  private callerSilenceRun = 0
  private callerUtteranceEndedAt?: number
  private turnRecordedForUtterance = false
  private callerBuf = ''
  private assistantBuf = ''
  private bargeInBuf = ''
  private turns: TranscriptTurn[] = []
  private hangupTimer?: unknown
  private hangupInFlight = false
  private hangupRecheckNeeded = false
  private lastTranscriptAt = 0
  private hangupRequested = false
  private readonly pcm24kOut = new Pcm24kOutboundAssembler()
  private readonly metrics: BridgeMetrics
  private readonly options: Required<Pick<MediaBridgeOptions, 'clock' | 'inboundCap' | 'outboundCap' | 'energyBargeIn' | 'energyThreshold' | 'energyFrames' | 'unsuppressSilenceFrames' | 'audioFormat' | 'hangupSilenceMs' | 'hangupPlaybackWaitMs'>> & MediaBridgeOptions

  constructor(options: MediaBridgeOptions) {
    this.options = {
      clock: options.clock ?? systemClock,
      inboundCap: options.inboundCap ?? DEFAULT_INBOUND_CAP,
      outboundCap: options.outboundCap ?? DEFAULT_OUTBOUND_CAP,
      energyBargeIn: options.energyBargeIn ?? false,
      energyThreshold: options.energyThreshold ?? 400,
      energyFrames: options.energyFrames ?? 2,
      unsuppressSilenceFrames: options.unsuppressSilenceFrames ?? DEFAULT_UNSUPPRESS_SILENCE_FRAMES,
      audioFormat: options.audioFormat ?? 'pcmu',
      hangupSilenceMs: options.hangupSilenceMs ?? DEFAULT_HANGUP_SILENCE_MS,
      hangupPlaybackWaitMs: options.hangupPlaybackWaitMs ?? DEFAULT_HANGUP_PLAYBACK_WAIT_MS,
      ...options
    }
    this.identity = options.identity
    this.metrics = createMetrics({
      tenantId: options.identity.tenantId,
      callId: options.identity.callId,
      answeredAt: this.options.clock.now()
    })
  }

  handleTwilioRaw(raw: unknown): void {
    const seq = extractSequenceNumber(raw)
    const parsed = parseTwilioMessage(raw)
    if (seq !== undefined) {
      const delta = sequenceDelta(this.lastTwilioSeq, seq)
      // Shared Twilio sequence includes start/mark/dtmf/stop. Count a gap only
      // when the next *media* frame arrives, after the cursor already advanced
      // through those non-media events — so marks are not "lost frames".
      if (parsed.ok && parsed.value.event === 'media') this.metrics.framesLost += delta.lost
      if (delta.reordered) this.metrics.framesReordered += 1
      else this.lastTwilioSeq = seq
      if (!parsed.ok) this.metrics.unparsedTwilioEvents += 1
    }
    if (!parsed.ok) return
    const message = parsed.value
    if (message.event === 'start') this.onStart(message)
    else if (message.event === 'media') this.onTwilioMedia(message.media.payload, message.media.track)
    else if (message.event === 'mark') this.onTwilioMark(message.mark.name)
    else if (message.event === 'stop') this.close('twilio_stop')
  }

  handleGptLiveRaw(raw: unknown): void {
    const parsed = parseGptLiveServerEvent(raw)
    if (!parsed.ok) return
    const event = parsed.value
    if (event.type === 'session.started') {
      this.gptReady = true
      this.flushInbound()
      this.emit({ type: 'started', sessionId: event.session.id, ...this.identity })
      this.startGreeting()
    } else if (event.type === 'session.output_audio.delta') {
      this.onAssistantAudio(event.delta)
    } else if (isCallerSpeechSignal(event)) {
      if (event.type === 'session.input_transcript.delta') {
        this.appendTranscript('caller', event.delta)
        this.bargeInBuf += event.delta
        this.metrics.inputTranscriptChars += event.delta.length
        this.noteTranscriptActivity()
      }
      if (this.greetingGuard) return
      if (event.type === 'session.input_transcript.delta'
        && !this.lastInboundWasSpeech
        && this.metrics.interruptSignals.length > 0) {
        return
      }
      if (event.type === 'session.input_transcript.delta') {
        this.considerTranscriptInterrupt()
        return
      }
      this.interrupt('speech_started')
    } else if (event.type === 'session.output_transcript.delta') {
      this.appendTranscript('assistant', event.delta)
      this.metrics.outputTranscriptChars += event.delta.length
      this.noteTranscriptActivity()
      if (this.awaitingNewAssistantTurn && !this.lastInboundWasSpeech) {
        this.releaseSuppress('output_transcript.delta')
      }
    } else if (event.type === 'session.usage.updated') {
      this.metrics.usageSeconds = event.usage.seconds
      this.emit({ type: 'usage', seconds: event.usage.seconds, ...this.identity })
    } else if (event.type === 'session.closed') {
      if (event.usage) this.metrics.usageSeconds = event.usage.seconds
      this.finish('gpt_live_closed', event.reason)
    } else if (event.type === 'error') {
      this.fail('gpt_live_error')
    }
  }

  onGptLiveDisconnect(): void {
    this.fail('gpt_live_disconnect')
  }

  onGptLiveTimeout(): void {
    this.fail('gpt_live_timeout')
  }

  get callerCallSid(): string | undefined {
    return this.twilioCallSid
  }

  get closeReason(): string | undefined {
    return this.metrics.closedReason
  }

  get transcriptTurns(): TranscriptTurn[] {
    return this.turns.map((turn) => ({ ...turn }))
  }

  appendFallbackVoicemail(): void {
    if (this.closed) return
    this.options.sendToGptLive(buildFallbackVoicemailInstruction(randomUUID()))
  }

  close(reason: string): void {
    if (this.closing || this.closed) return
    this.closing = true
    this.clearHangupTimer()
    this.options.sendToGptLive(buildSessionClose())
    this.metrics.closedReason ??= reason
  }

  exportMetrics(): BridgeMetrics {
    return JSON.parse(exportMetricsJson(this.metrics)) as BridgeMetrics
  }

  private onStart(message: TwilioStartMessage): void {
    this.streamSid = message.streamSid
    this.twilioCallSid = message.start.callSid
    this.metrics.streamSidRedacted = redactSid(message.streamSid)
    this.metrics.answeredAt = this.options.clock.now()
    this.options.sendToGptLive(buildSessionStart({
      eventId: randomUUID(),
      instructions: this.options.instructions,
      voice: this.options.voice,
      audioFormat: this.options.audioFormat
    }))
  }

  private startGreeting(): void {
    const opening = this.options.openingLine?.trim()
    if (!opening) return
    this.greetingGuard = true
    this.options.sendToGptLive(buildCommentaryAppend(randomUUID(), opening))
    this.greetingTimer = this.options.clock.setTimeout(() => {
      this.greetingGuard = false
    }, GREETING_GUARD_TIMEOUT_MS)
  }

  private onTwilioMedia(payload: string, track: 'inbound' | 'outbound'): void {
    if (track !== 'inbound' || this.closing || this.closed) return
    this.metrics.inboundFrames += 1
    this.noteInboundEnergy(payload)
    this.noteCallerUtterance()
    this.detectEnergy()
    this.releaseIfCallerSilent()
    const liveAudio = this.options.audioFormat === 'pcm24k'
      ? mulawFrameToPcm24kBase64(Buffer.from(payload, 'base64'))
      : payload
    if (this.gptReady) this.options.sendToGptLive(buildInputAudioAppend(liveAudio))
    else this.enqueueInbound(liveAudio)
  }

  private onAssistantAudio(deltaBase64: string): void {
    if (this.closing || this.closed) {
      this.decide({ kind: 'drop', reason: 'closing' })
      return
    }
    if (this.suppressOutbound) {
      this.decide({ kind: 'drop', reason: 'suppressed' })
      return
    }
    const frames = this.options.audioFormat === 'pcm24k'
      ? this.pcm24kOut.pushDelta(deltaBase64)
      : [deltaBase64]
    if (frames.length === 0) return
    this.decide({ kind: 'forward' })
    for (const frame of frames) this.enqueueOutbound(frame)
    this.flushOutbound()
  }

  private noteInboundEnergy(payload: string): void {
    let bytes: Buffer
    try { bytes = Buffer.from(payload, 'base64') } catch { return }
    this.lastInboundWasSpeech = isSpeechFrame(bytes, this.options.energyThreshold)
  }

  private noteCallerUtterance(): void {
    if (this.lastInboundWasSpeech) {
      this.callerWasSpeaking = true
      this.callerSilenceRun = 0
      this.turnRecordedForUtterance = false
      this.callerUtteranceEndedAt = undefined
      return
    }
    if (!this.callerWasSpeaking) return
    this.callerSilenceRun += 1
    if (this.callerSilenceRun >= CALLER_UTTERANCE_SILENCE_FRAMES) {
      this.callerUtteranceEndedAt = this.options.clock.now() - CALLER_UTTERANCE_SILENCE_FRAMES * FRAME_DURATION_MS
      this.callerWasSpeaking = false
    }
  }

  private detectEnergy(): void {
    if (!this.options.energyBargeIn || this.greetingGuard) return
    if (!this.hasPlayback()) {
      this.energyRun = 0
      return
    }
    if (this.lastInboundWasSpeech) this.energyRun += 1
    else this.energyRun = 0
    if (this.energyRun >= this.options.energyFrames) this.interrupt('energy')
  }

  private releaseIfCallerSilent(): void {
    if (this.greetingGuard && this.greetingAudioFlushed && !this.lastInboundWasSpeech) {
      this.postInterruptSilenceRun += 1
      if (this.postInterruptSilenceRun >= this.options.unsuppressSilenceFrames) {
        this.releaseGreetingGuard()
      }
      return
    }
    if (!this.suppressOutbound || !this.awaitingNewAssistantTurn) return
    if (this.lastInboundWasSpeech) {
      this.postInterruptSilenceRun = 0
      return
    }
    this.postInterruptSilenceRun += 1
    if (this.postInterruptSilenceRun >= this.options.unsuppressSilenceFrames) {
      this.releaseSuppress('caller_silence')
    }
  }

  private hasPlayback(): boolean {
    return this.outboundQueue.length > 0 || this.unackedMarks > 0
  }

  private considerTranscriptInterrupt(): void {
    if (!this.canInterrupt()) return
    const decision = classifyTranscriptInterrupt(this.bargeInBuf)
    if (decision.action === 'filter') {
      this.metrics.interruptsFiltered = (this.metrics.interruptsFiltered ?? 0) + 1
      this.logLine(formatInterruptLog('filtered', decision.reason, decision.chars))
      if (decision.reason === 'backchannel') this.bargeInBuf = ''
      return
    }
    this.interrupt('transcript', decision.chars)
  }

  private canInterrupt(): boolean {
    return !this.closing && !this.closed && Boolean(this.streamSid) && !this.greetingGuard
      && this.hasPlayback() && !this.suppressOutbound
  }

  private interrupt(source: InterruptSource, chars = 0): void {
    if (!this.canInterrupt()) return
    const at = this.options.clock.now()
    this.suppressOutbound = true
    this.awaitingNewAssistantTurn = true
    this.outboundQueue = []
    this.pcm24kOut.reset()
    this.unackedMarks = 0
    this.energyRun = 0
    this.postInterruptSilenceRun = 0
    this.bargeInBuf = ''
    this.options.sendToTwilio(outboundClearMessage(this.streamSid!))
    this.metrics.interruptStopMs.push(0)
    this.metrics.interruptSignals.push(source)
    this.decide({ kind: 'interrupt', at, source })
    this.emit({ type: 'interrupt', at, source, ...this.identity })
    this.logLine(formatInterruptLog('fired', source, chars))
  }

  private logLine(line: string): void {
    (this.options.log ?? console.log)(line)
  }

  private releaseGreetingGuard(): void {
    this.greetingGuard = false
    if (this.greetingTimer !== undefined) this.options.clock.clearTimeout(this.greetingTimer)
    this.greetingTimer = undefined
  }

  private releaseSuppress(reason: string): void {
    if (!this.suppressOutbound && !this.awaitingNewAssistantTurn) return
    this.awaitingNewAssistantTurn = false
    this.suppressOutbound = false
    this.decide({ kind: 'unsuppress', reason })
  }

  private onTwilioMark(_name: string): void {
    this.marksHeard += 1
    if (this.unackedMarks > 0) this.unackedMarks -= 1
    if (this.greetingGuard && this.greetingAudioFlushed && this.unackedMarks === 0) {
      this.releaseGreetingGuard()
    }
    if (this.metrics.interruptStopMs.length > 0 && this.suppressOutbound) {
      const last = this.metrics.interruptStopMs.length - 1
      if (this.metrics.interruptStopMs[last] === 0) {
        this.metrics.interruptStopMs[last] = 0
      }
    }
  }

  private enqueueInbound(payload: string): void {
    this.inboundQueue.push(payload)
    while (this.inboundQueue.length > this.options.inboundCap) {
      this.inboundQueue.shift()
      this.metrics.inboundQueueDropped += 1
    }
  }

  private flushInbound(): void {
    for (const payload of this.inboundQueue.splice(0)) {
      this.options.sendToGptLive(buildInputAudioAppend(payload))
    }
  }

  private enqueueOutbound(payload: string): void {
    this.outboundQueue.push(payload)
    while (this.outboundQueue.length > this.options.outboundCap) {
      this.outboundQueue.shift()
      this.metrics.outboundDropped += 1
    }
  }

  private flushOutbound(): void {
    if (!this.streamSid || this.suppressOutbound) {
      this.outboundQueue = []
      return
    }
    for (const payload of this.outboundQueue.splice(0)) {
      const now = this.options.clock.now()
      if (this.metrics.firstAnswerLatencyMs === undefined) {
        this.metrics.firstAnswerLatencyMs = now - this.metrics.answeredAt
      }
      if (this.callerUtteranceEndedAt !== undefined && !this.turnRecordedForUtterance) {
        this.metrics.turnLatencies.push({
          lastCallerFrameAt: this.callerUtteranceEndedAt,
          firstAssistantAudioAt: now,
          ms: now - this.callerUtteranceEndedAt
        })
        this.turnRecordedForUtterance = true
        this.callerUtteranceEndedAt = undefined
      }
      this.metrics.outboundFrames += 1
      this.greetingAudioFlushed = true
      this.options.sendToTwilio(outboundMediaMessage(this.streamSid, payload))
      this.markSeq += 1
      this.unackedMarks += 1
      this.options.sendToTwilio(outboundMarkMessage(this.streamSid, `play-${this.markSeq}`))
    }
  }

  private noteTranscriptActivity(): void {
    this.lastTranscriptAt = this.options.clock.now()
    this.scheduleHangupCheck()
  }

  private appendTranscript(role: 'caller' | 'assistant', delta: string): void {
    if (!delta) return
    if (role === 'caller') {
      if (this.assistantBuf.trim()) {
        this.pushTurn('assistant', this.assistantBuf)
        this.assistantBuf = ''
      }
      this.callerBuf += delta
      return
    }
    if (this.callerBuf.trim()) {
      this.pushTurn('caller', this.callerBuf)
      this.callerBuf = ''
    }
    this.assistantBuf += delta
  }

  private pushTurn(role: 'caller' | 'assistant', text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const last = this.turns[this.turns.length - 1]
    if (last && last.role === role) last.text = mergeTurnText(last.text, trimmed)
    else this.turns.push({ role, text: trimmed })
  }

  private clearHangupTimer(): void {
    if (this.hangupTimer === undefined) return
    this.options.clock.clearTimeout(this.hangupTimer)
    this.hangupTimer = undefined
  }

  private scheduleHangupCheck(): void {
    if (!this.options.judgeHangup) return
    if (this.hangupRequested || this.closing || this.closed) return
    if (this.hangupInFlight) this.hangupRecheckNeeded = true
    this.clearHangupTimer()
    this.hangupTimer = this.options.clock.setTimeout(() => {
      this.hangupTimer = undefined
      void this.considerHangup()
    }, this.options.hangupSilenceMs)
  }

  private flushTranscriptBuffers(): void {
    if (this.callerBuf.trim()) {
      this.pushTurn('caller', this.callerBuf)
      this.callerBuf = ''
    }
    if (this.assistantBuf.trim()) {
      this.pushTurn('assistant', this.assistantBuf)
      this.assistantBuf = ''
    }
    this.turns = normalizeHangupTurns(this.turns)
  }

  private async considerHangup(): Promise<void> {
    if (this.hangupRequested || this.closing || this.closed) return
    if (this.hangupInFlight) {
      this.hangupRecheckNeeded = true
      return
    }
    const judge = this.options.judgeHangup
    if (!judge) return
    this.flushTranscriptBuffers()
    const turns = this.turns.map((turn) => ({ ...turn }))
    if (turns.length === 0) return
    this.logLine(formatHangupTurnsLog(turns))
    this.hangupInFlight = true
    this.hangupRecheckNeeded = false
    try {
      const verdict = await judge(turns)
      this.metrics.hangupChecks = (this.metrics.hangupChecks ?? 0) + 1
      this.metrics.hangupReason = verdict.reason
      if (!verdict.end) return
      this.hangupRequested = true
      this.metrics.hangupRequested = true
      this.clearHangupTimer()
      this.emit({ type: 'hangup', reason: verdict.reason, ...this.identity })
      this.logLine(formatHangupDecidedLog())
      const waitStarted = this.options.clock.now()
      await this.waitForPlaybackIdle()
      this.logLine(formatHangupPlaybackWaitLog(this.options.clock.now() - waitStarted))
      await this.executeHangup()
    } catch {
      this.metrics.hangupChecks = (this.metrics.hangupChecks ?? 0) + 1
      this.metrics.hangupReason = 'judge_failed'
      this.hangupRequested = false
    } finally {
      this.hangupInFlight = false
      if (this.hangupRecheckNeeded && !this.hangupRequested && !this.closing && !this.closed) {
        this.hangupRecheckNeeded = false
        const elapsed = this.options.clock.now() - this.lastTranscriptAt
        if (elapsed >= this.options.hangupSilenceMs) {
          void this.considerHangup()
        } else if (this.hangupTimer === undefined) {
          this.hangupTimer = this.options.clock.setTimeout(() => {
            this.hangupTimer = undefined
            void this.considerHangup()
          }, this.options.hangupSilenceMs - elapsed)
        }
      }
    }
  }

  private playbackBusy(): boolean {
    return this.outboundQueue.length > 0 || (this.marksHeard > 0 && this.unackedMarks > 0)
  }

  private async waitForPlaybackIdle(): Promise<void> {
    const waitMs = Math.max(0, this.options.hangupPlaybackWaitMs)
    if (waitMs === 0 || !this.playbackBusy()) return
    await new Promise<void>((resolve) => {
      this.options.clock.setTimeout(resolve, waitMs)
    })
  }

  private async executeHangup(): Promise<void> {
    const callSid = this.twilioCallSid
    if (!callSid) {
      this.logLine(formatHangupSkippedLog('no_call_sid'))
      return
    }
    const rest = this.options.twilioRest
    if (!rest) {
      this.logLine(formatHangupSkippedLog('no_rest'))
      return
    }
    const started = this.options.clock.now()
    try {
      await rest.endCall(callSid)
      this.logLine(formatHangupEndCallOkLog(this.options.clock.now() - started))
    } catch (error) {
      this.metrics.hangupReason = 'end_failed'
      this.logLine(formatHangupEndCallFailedLog(hangupEndCallErrorCode(error)))
    }
  }

  private fail(reason: string): void {
    if (this.gptFailed) return
    this.gptFailed = true
    this.metrics.gptLiveFailed = true
    this.emit({ type: 'error', reason, ...this.identity })
    this.close(reason)
  }

  private finish(reason: string, gptReason?: string): void {
    if (this.closed) return
    this.closed = true
    this.closing = true
    this.gptReady = false
    this.clearHangupTimer()
    this.inboundQueue = []
    this.outboundQueue = []
    this.metrics.closedReason = gptReason ?? reason
    this.emit({
      type: 'closed',
      reason: this.metrics.closedReason,
      usageSeconds: this.metrics.usageSeconds,
      ...this.identity
    })
  }

  private emit(event: BridgeObservation): void {
    this.options.observe?.(event)
  }

  private decide(decision: Omit<BridgeDecision, 'at'> & { at?: number }): void {
    this.options.onDecision?.({
      ...decision,
      at: decision.at ?? this.options.clock.now()
    })
  }
}
