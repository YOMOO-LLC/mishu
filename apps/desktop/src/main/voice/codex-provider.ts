import type { CodexAppServerClient } from '../codex/index.js'
import type { CodexNotification } from '../codex/types.js'
import type { StartRealtimeRequest, StartRealtimeResponse } from '../../shared/contracts.js'
import { VoiceEvents, type VoiceProvider } from './provider.js'

export class CodexVoiceProvider extends VoiceEvents implements VoiceProvider {
  private threadId?: string
  constructor(private readonly codex: () => CodexAppServerClient) { super() }
  async start(request: StartRealtimeRequest): Promise<StartRealtimeResponse> {
    const response = await this.codex().startRealtime(request)
    this.threadId = response.threadId
    return response
  }
  appendSpeech(text: string): Promise<void> { return this.codex().appendSpeech(text) }
  appendText(text: string): Promise<void> { return this.codex().appendText(text) }
  stop(): Promise<void> { return this.codex().stopRealtime() }
  notification(notification: CodexNotification): void {
    const p = (notification.params ?? {}) as Record<string, unknown>
    const threadId = typeof p.threadId === 'string' ? p.threadId : undefined
    switch (notification.method) {
      case 'thread/realtime/started':
        this.threadId = threadId
        this.publish({ type: 'started', threadId, sessionId: typeof p.realtimeSessionId === 'string' ? p.realtimeSessionId : undefined }); break
      case 'thread/realtime/transcript/delta':
      case 'thread/realtime/transcript/done': {
        const final = notification.method.endsWith('/done')
        this.publish({ type: 'transcript', threadId, role: p.role === 'assistant' ? 'assistant' : 'caller', final,
          ...(typeof p.delta === 'string' ? { delta: p.delta } : {}), ...(typeof p.text === 'string' ? { text: p.text } : {}) })
        if (final && p.role === 'assistant') this.publish({ type: 'turnDone' })
        break
      }
      case 'turn/completed':
        if (threadId && threadId === this.threadId) this.publish({ type: 'turnDone' })
        break
      case 'thread/realtime/closed': this.publish({ type: 'closed', reason: 'closed' }); break
      case 'thread/realtime/error': this.publish({ type: 'error', message: typeof p.message === 'string' ? p.message : 'GPT Live returned an error' }); break
    }
  }
}
