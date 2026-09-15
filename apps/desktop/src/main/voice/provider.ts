import type { StartRealtimeRequest, StartRealtimeResponse } from '../../shared/contracts.js'

export type VoiceEvent =
  | { type: 'started'; sessionId?: string; threadId?: string }
  | { type: 'transcript'; role: 'caller' | 'assistant'; delta?: string; text?: string; final: boolean; threadId?: string }
  | { type: 'turnDone' }
  | { type: 'usage'; seconds: number }
  | { type: 'closed'; reason: string }
  | { type: 'error'; message: string }

/** Desktop session control. Wave 2 wraps this with DesktopVoiceSessionAdapter (VoiceSessionPort); callers stay on VoiceProvider. */
export interface VoiceProvider {
  start(request: StartRealtimeRequest): Promise<StartRealtimeResponse>
  appendSpeech(text: string): Promise<void>
  appendText(text: string): Promise<void>
  stop(): Promise<void>
  silence?(): Promise<void>
  markStarted?(sessionId: string): boolean
  subscribe(listener: (event: VoiceEvent) => void): () => void
}

export class VoiceEvents {
  private readonly listeners = new Set<(event: VoiceEvent) => void>()
  subscribe = (listener: (event: VoiceEvent) => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  protected publish(event: VoiceEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
