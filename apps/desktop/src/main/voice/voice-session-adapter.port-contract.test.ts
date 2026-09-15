import { describeVoiceSessionPortContract } from '@mishu/adapters-mock/contract-tests'
import type { StartRealtimeRequest, StartRealtimeResponse } from '../../shared/contracts.js'
import {
  createDesktopVoiceSessionAdapter,
  DESKTOP_GPT_LIVE_VOICE_CAPABILITIES
} from './voice-session-adapter.js'
import type { VoiceEvent, VoiceProvider } from './provider.js'

/** In-memory VoiceProvider: start/stop emit port events; no network. */
class MockVoiceProvider implements VoiceProvider {
  private readonly listeners = new Set<(event: VoiceEvent) => void>()

  async start(_request: StartRealtimeRequest): Promise<StartRealtimeResponse> {
    const sessionId = 'sess_desktop_mock'
    this.publish({ type: 'started', sessionId })
    return { sessionId, threadId: 'thread_desktop_mock', sdp: 'answer' }
  }

  async appendSpeech(_text: string): Promise<void> {}

  async appendText(_text: string): Promise<void> {}

  async stop(): Promise<void> {
    this.publish({ type: 'closed', reason: 'done' })
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(event: VoiceEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

describeVoiceSessionPortContract(
  () => createDesktopVoiceSessionAdapter(new MockVoiceProvider(), 'gpt-live-api'),
  {
    formats: ['webrtc-sdp'],
    capabilities: DESKTOP_GPT_LIVE_VOICE_CAPABILITIES
  }
)
