import type { RealtimeVoice, StartRealtimeRequest, StartRealtimeResponse } from '../../shared/contracts.js'
import { REALTIME_VOICES } from '../../shared/contracts.js'
import type { CodexAppServerClient } from '../codex/index.js'
import { CodexVoiceProvider } from '../voice/codex-provider.js'
import { VoiceEvents, type VoiceProvider } from '../voice/provider.js'
import type { VoiceSettingsService } from './voice-settings-service.js'
import { ServiceError } from './service-error.js'

export class RealtimeService extends VoiceEvents {
  readonly codexProvider: CodexVoiceProvider
  private active: VoiceProvider
  private blocked = false
  private running = false
  isActive(): boolean { return this.running }
  constructor(
    codex: () => CodexAppServerClient,
    private readonly emitConnecting: () => void,
    private readonly apiProvider?: VoiceProvider,
    private readonly settings?: VoiceSettingsService
  ) {
    super()
    this.codexProvider = new CodexVoiceProvider(codex)
    this.active = this.codexProvider
    for (const provider of [this.codexProvider, apiProvider]) {
      provider?.subscribe((event) => {
        if (provider !== this.active) return
        if (event.type === 'closed') this.running = false
        this.publish(event)
      })
    }
  }

  markStarted(sessionId: unknown): boolean {
    return typeof sessionId === 'string' && sessionId.length <= 200 ? this.active.markStarted?.(sessionId) ?? false : false
  }
  async silence(): Promise<void> { this.blocked = true; await this.active.silence?.() }

  async start(request: StartRealtimeRequest): Promise<StartRealtimeResponse> {
    if (!request || typeof request.sdp !== 'string' || !request.sdp) {
      throw new ServiceError('INVALID_ARGUMENT', 'A WebRTC SDP offer is required')
    }
    const instructions = typeof request.instructions === 'string' ? request.instructions.trim() : undefined
    if (instructions && instructions.length > 12_000) {
      throw new ServiceError('UNPROCESSABLE_ENTITY', 'Realtime instructions are too long')
    }
    if (request.voice && !REALTIME_VOICES.includes(request.voice as RealtimeVoice)) {
      throw new ServiceError('INVALID_ARGUMENT', 'Realtime voice is invalid')
    }
    this.running = true
    this.blocked = false
    this.active = this.settings?.get().provider === 'gpt-live-api' && this.apiProvider ? this.apiProvider : this.codexProvider
    this.emitConnecting()
    try {
      return await this.active.start({
      ...(request.callId ? { callId: request.callId } : {}),
      sdp: request.sdp,
      ...(request.threadId ? { threadId: request.threadId } : {}),
      ...(request.voice ? { voice: request.voice } : {}),
      ...(instructions ? { instructions } : {})
      })
    } catch (error) {
      this.running = false
      throw error
    }
  }

  async appendSpeech(text: unknown): Promise<void> {
    if (!this.blocked && typeof text === 'string' && text.trim()) await this.active.appendSpeech(text)
  }

  async appendText(text: unknown): Promise<void> {
    if (!this.blocked && typeof text === 'string' && text.trim()) await this.active.appendText(text)
  }

  async stop(): Promise<void> { try { await this.active.stop() } finally { this.running = false } }
}
