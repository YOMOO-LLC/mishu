import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { ClientEvent, LiveCreateParams, LiveCreateResponse } from './live-protocol.js'
import type { StartRealtimeRequest, StartRealtimeResponse } from '../../shared/contracts.js'
import type { OpenAiSettingsService } from '../services/openai-settings-service.js'
import { ServiceError } from '../services/service-error.js'
import { PUNCTUATION_ONLY_PATTERN } from '../../shared/caller-input-patterns.js'
import { VoiceEvents, type VoiceProvider } from './provider.js'

export interface LiveSocket {
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: { toString(): string }) => void): unknown
  on(event: 'close' | 'error', listener: () => void): unknown
  send(data: string): void
  close(): void
}
export interface GptLiveApiOptions {
  settings: Pick<OpenAiSettingsService, 'apiKey' | 'headers'>
  voice(): string
  fetch?: typeof fetch
  apiBaseUrl?: string
  socket?(url: string, headers: Record<string, string>): LiveSocket
  timeoutMs?: number
  silenceMs?: number
  interruptionMs?: number
  shortInterruptionChars?: number
  audit?(action: string, details?: { delegationId: string }): void
  disabled?: boolean
}

/** Control is main-owned; audio stays on the renderer's WebRTC tracks. */
export class GptLiveApiVoiceProvider extends VoiceEvents implements VoiceProvider {
  private starting?: Promise<StartRealtimeResponse>
  private socket?: LiveSocket
  private id?: string
  private failed = false
  private ready = false
  private opened = false
  private observedStarted = false
  private queue: ClientEvent[] = []
  private declinedDelegations = new Set<string>()
  private ending = false
  private closePromise?: Promise<void>
  private closed?: () => void
  private transcript?: { role: 'caller' | 'assistant'; text: string; start: number; end: number }
  private pendingTranscripts: Array<{ role: 'caller' | 'assistant'; text: string; start: number; end: number }> = []
  private transcriptTimer?: ReturnType<typeof setTimeout>
  private pendingTranscriptTimer?: ReturnType<typeof setTimeout>
  private startupTimer?: ReturnType<typeof setTimeout>
  constructor(private readonly options: GptLiveApiOptions) { super() }

  async start(request: StartRealtimeRequest): Promise<StartRealtimeResponse> {
    if (this.starting || this.socket) throw new ServiceError('CONFLICT', 'A voice session is already active')
    const pending = this.startInternal(request)
    this.starting = pending
    try { return await pending } finally { if (this.starting === pending) this.starting = undefined }
  }
  private async startInternal(request: StartRealtimeRequest): Promise<StartRealtimeResponse> {
    if (this.options.disabled) throw new ServiceError('MOCK_ONLY', 'API voice sessions are disabled in mock phone mode')
    if (this.socket) throw new ServiceError('CONFLICT', 'A voice session is already active')
    if (!this.options.settings.apiKey()) throw new ServiceError('INVALID_ARGUMENT', 'OpenAI API key is not configured')
    this.ending = false
    this.failed = false
    this.ready = false
    this.opened = false
    this.observedStarted = false
    this.queue = []
    this.declinedDelegations.clear()
    this.closePromise = undefined
    const base = this.options.apiBaseUrl ?? 'https://api.openai.com'
    const body: LiveCreateParams = {
      session: { model: 'gpt-live-1', instructions: request.instructions,
        audio: { output: { voice: this.options.voice() } }, delegation: { type: 'client' } },
      transport: { type: 'webrtc', sdp: request.sdp }
    }
    try {
      const response = await (this.options.fetch ?? fetch)(`${base}/v1/live/sessions`, {
        method: 'POST', headers: { ...this.options.settings.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000), redirect: 'error'
      })
      if (!response.ok) throw new Error('Session creation failed')
      const result = await response.json() as LiveCreateResponse
      if (typeof result.session?.id !== 'string' || typeof result.transport?.sdp !== 'string' || !result.transport.sdp) throw new Error('Invalid session response')
      this.id = result.session.id
      const url = `${base.replace(/^http/, 'ws')}/v1/live/sessions/${encodeURIComponent(this.id)}/attach`
      const socket = this.options.socket?.(url, this.options.settings.headers())
        ?? new WebSocket(url, { headers: this.options.settings.headers(), followRedirects: false, handshakeTimeout: this.options.timeoutMs ?? 15_000 })
      this.socket = socket
      socket.on('message', (data) => {
        if (this.socket !== socket) return
        try { this.receive(JSON.parse(data.toString())) } catch { this.fail() }
      })
      socket.on('error', () => { if (this.socket === socket) this.fail() })
      socket.on('close', () => {
        if (this.socket !== socket) return
        this.flush()
        this.drainTranscripts(true)
        this.publish({ type: 'closed', reason: 'connection_lost' })
        this.cleanup()
      })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Attach timed out')), this.options.timeoutMs ?? 15_000)
        socket.on('open', () => { clearTimeout(timer); this.opened = true; this.becomeReady(); resolve() })
        socket.on('error', () => { clearTimeout(timer); reject(new Error('Attach failed')) })
        socket.on('close', () => { clearTimeout(timer); reject(new Error('Attach closed')) })
      })
      // SDP must return before media can start; session.started is observed separately.
      this.startupTimer = setTimeout(() => { if (!this.ready) this.fail() }, this.options.timeoutMs ?? 10_000)
      return { sdp: result.transport.sdp, threadId: this.id, sessionId: this.id, provider: 'gpt-live-api' }
    } catch {
      this.cleanup()
      throw new ServiceError('INTERNAL_ERROR', 'GPT Live API session could not be started')
    }
  }
  async appendSpeech(text: string): Promise<void> { this.append('session.commentary.append', text) }
  async appendText(text: string): Promise<void> { this.append('session.thinking.append', text) }
  async silence(): Promise<void> {
    this.ending = true
    this.queue = []
    this.enqueue({ type: 'session.instructions.append', event_id: randomUUID(), delegation_id: null, content: 'Finish your current sentence, then stop speaking and do not start a new turn.' })
  }
  async stop(): Promise<void> {
    this.ending = true
    if (this.starting) await this.starting.catch(() => undefined)
    if (this.closePromise) return this.closePromise
    if (!this.socket) return
    this.ending = true
    this.closePromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.publish({ type: 'closed', reason: 'finalization_timeout' })
        this.cleanup()
      }, this.options.timeoutMs ?? 4_000)
      this.closed = () => { clearTimeout(timer); resolve() }
      // Install final listener before sending; preserve peer until this settles.
      try { this.send({ type: 'session.close' }) } catch { this.cleanup() }
    })
    return this.closePromise
  }
  private append(type: 'session.thinking.append' | 'session.commentary.append', text: string): void {
    if (this.ending || !text.trim()) return
    // At most 400 UTF-8 bytes is conservatively below the 500-token command limit.
    let chunk = ''
    for (const char of text) {
      if (Buffer.byteLength(chunk + char, 'utf8') > 400) {
        this.enqueue({ type, event_id: randomUUID(), delegation_id: null, content: chunk }); chunk = ''
      }
      chunk += char
    }
    if (chunk) this.enqueue({ type, event_id: randomUUID(), delegation_id: null, content: chunk })
  }
  markStarted(sessionId: string): boolean {
    if (!this.socket || sessionId !== this.id) return false
    this.observedStarted = true
    this.becomeReady()
    return this.ready
  }
  private becomeReady(): void {
    if (this.ready || !this.opened || !this.observedStarted) return
    this.ready = true
    clearTimeout(this.startupTimer)
    this.publish({ type: 'started', sessionId: this.id, threadId: this.id })
    for (const event of this.queue.splice(0)) this.send(event)
  }
  private enqueue(event: ClientEvent): void {
    if (this.ready) { this.send(event); return }
    if (this.queue.length === 8) { this.queue.shift(); this.options.audit?.('voice.queue.dropped') }
    this.queue.push(event)
  }
  private send(event: ClientEvent): void { this.socket?.send(JSON.stringify(event)) }
  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const event = value as Record<string, unknown>
    if (event.type === 'session.started') {
      const id = (event.session as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') this.markStarted(id)
    } else if (event.type === 'session.delegation.created') {
      const id = (event.delegation as { id?: unknown } | undefined)?.id
      if (this.ending || typeof id !== 'string' || !id || this.declinedDelegations.has(id)) return
      this.declinedDelegations.add(id)
      this.enqueue({
        type: 'session.commentary.append',
        event_id: randomUUID(),
        delegation_id: id,
        content: 'This request cannot be handled during this call. Tell the caller briefly, in the language of the conversation, that you cannot do that right now, and continue the conversation.'
      })
      this.options.audit?.('voice.delegation.declined', { delegationId: id })
    } else if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      if (typeof event.delta !== 'string' || typeof event.start_ms !== 'number' || typeof event.end_ms !== 'number') return
      const role = event.type === 'session.input_transcript.delta' ? 'caller' : 'assistant'
      if (this.transcript && (this.transcript.role !== role || event.start_ms - this.transcript.end > (this.options.silenceMs ?? 800))) this.flush()
      this.transcript ??= { role, text: '', start: event.start_ms, end: event.end_ms }
      this.transcript.text += event.delta
      this.transcript.end = event.end_ms
      this.publish({ type: 'transcript', threadId: this.id, role, delta: event.delta, final: false })
      clearTimeout(this.transcriptTimer)
      this.transcriptTimer = setTimeout(() => this.flush(), this.options.silenceMs ?? 800)
    } else if (event.type === 'session.usage.updated' || event.type === 'session.closed') {
      const seconds = (event.usage as { seconds?: unknown } | undefined)?.seconds
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) this.publish({ type: 'usage', seconds })
      if (event.type === 'session.closed') {
        this.flush()
        this.drainTranscripts(true)
        this.publish({ type: 'closed', reason: typeof event.reason === 'string' && ['close_requested', 'expired', 'content', 'remote_hangup', 'connection_lost'].includes(event.reason) ? event.reason : 'closed' })
        this.cleanup()
      }
    } else if (event.type === 'error') this.fail()
    // Reflected audio and private/raw events never enter IPC or logs.
  }
  private flush(): void {
    clearTimeout(this.transcriptTimer)
    const transcript = this.transcript
    this.transcript = undefined
    if (!transcript) return
    if (!isPunctuationOnly(transcript.text)) this.pendingTranscripts.push({ ...transcript, text: transcript.text.trim() })
    if (transcript.role === 'assistant') this.publish({ type: 'turnDone' })
    this.drainTranscripts()
  }
  private drainTranscripts(force = false): void {
    clearTimeout(this.pendingTranscriptTimer)
    this.pendingTranscriptTimer = undefined
    const interruptionMs = this.options.interruptionMs ?? 1_200
    const shortChars = this.options.shortInterruptionChars ?? 12
    while (this.pendingTranscripts.length >= 3) {
      const [before, interruption, after] = this.pendingTranscripts
      if (before && interruption && after
        && before.role === after.role && before.role !== interruption.role
        && interruption.end - interruption.start < interruptionMs
        && after.start - before.end < interruptionMs
        && Array.from(interruption.text).length <= shortChars) {
        this.pendingTranscripts.splice(0, 3)
        this.publishFinal({ ...before, text: joinTranscriptText(before.text, after.text), end: after.end })
        this.publishFinal(interruption)
      } else {
        this.publishFinal(this.pendingTranscripts.shift()!)
      }
    }
    if (force) {
      for (const transcript of this.pendingTranscripts.splice(0)) this.publishFinal(transcript)
    } else if (this.pendingTranscripts.length > 0) {
      this.pendingTranscriptTimer = setTimeout(() => this.drainTranscripts(true), interruptionMs)
    }
  }
  private publishFinal(transcript: { role: 'caller' | 'assistant'; text: string; start?: number; end?: number }): void {
    this.publish({ type: 'transcript', threadId: this.id, role: transcript.role, text: transcript.text, final: true })
  }
  private fail(): void {
    if (this.failed) return
    this.failed = true
    this.publish({ type: 'error', message: 'GPT Live API connection failed' })
    void this.stop().catch(() => undefined)
  }
  private cleanup(): void {
    clearTimeout(this.startupTimer)
    this.flush()
    this.drainTranscripts(true)
    this.ready = false
    this.opened = false
    this.queue = []
    const socket = this.socket
    this.socket = undefined
    socket?.close()
    this.closed?.()
    this.closed = undefined
  }
}

function isPunctuationOnly(text: string): boolean {
  return !text.trim() || PUNCTUATION_ONLY_PATTERN.test(text)
}

function joinTranscriptText(before: string, after: string): string {
  const separator = /[\p{L}\p{N}]$/u.test(before) && /^[\p{L}\p{N}]/u.test(after)
    && /[\u0000-\u007f]$/.test(before) && /^[\u0000-\u007f]/.test(after)
    ? ' '
    : ''
  return `${before}${separator}${after}`
}
