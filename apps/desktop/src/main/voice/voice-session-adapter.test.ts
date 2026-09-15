import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { VoiceSessionEvent, VoiceSessionPort } from '@mishu/core/ports'
import { FALLBACK_VOICEMAIL_NOTE } from '@mishu/core/ports'
import type { CodexAppServerClient } from '../codex/index.js'
import { CodexVoiceProvider } from './codex-provider.js'
import { GptLiveApiVoiceProvider, type LiveSocket } from './gpt-live-api-provider.js'
import {
  createDesktopVoiceSessionAdapter,
  DESKTOP_CODEX_VOICE_CAPABILITIES,
  DESKTOP_GPT_LIVE_VOICE_CAPABILITIES,
  DesktopVoiceSessionAdapter
} from './voice-session-adapter.js'

class FakeSocket extends EventEmitter implements LiveSocket {
  sent: Array<Record<string, unknown>> = []
  send(data: string): void {
    const event = JSON.parse(data)
    this.sent.push(event)
    if (event.type === 'session.close') {
      this.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 17.5 }, reason: 'close_requested' }))
    }
  }
  close(): void { this.emit('close') }
  server(event: unknown): void { this.emit('message', JSON.stringify(event)) }
}

function apiHarness(autoStarted = true) {
  const socket = new FakeSocket()
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(
    JSON.stringify({ session: { id: 'live_test' }, transport: { sdp: 'answer', type: 'webrtc' } }),
    { status: 201 }
  ))
  const provider = new GptLiveApiVoiceProvider({
    settings: { apiKey: () => 'fake-key-private-1234', headers: () => ({ Authorization: 'Bearer fake-key-private-1234' }) },
    voice: () => 'marin',
    fetch: fetcher,
    silenceMs: 20,
    interruptionMs: 1,
    timeoutMs: 100,
    socket: () => {
      setTimeout(() => {
        socket.emit('open')
        if (autoStarted) socket.server({ type: 'session.started', session: { id: 'live_test' } })
      }, 0)
      return socket
    }
  })
  return { provider, socket, fetcher }
}

function target() {
  return { tenantId: 'local', callId: 'call-1' }
}

function startInput(overrides: Partial<{ format: 'webrtc-sdp' | 'pcmu-8k' | 'pcm24k'; sdp: string; openingLine: string }> = {}) {
  return {
    ...target(),
    format: 'webrtc-sdp' as const,
    instructions: 'Be brief.',
    voice: 'marin',
    sdp: 'offer',
    ...overrides
  }
}

describe('DesktopVoiceSessionAdapter', () => {
  it('satisfies VoiceSessionPort and marks Codex as local-only', () => {
    const client = {
      startRealtime: vi.fn(async () => ({ sdp: 'answer', threadId: 'thread', sessionId: 'session' })),
      appendSpeech: vi.fn(async () => {}),
      appendText: vi.fn(async () => {}),
      stopRealtime: vi.fn(async () => {})
    }
    const adapter = createDesktopVoiceSessionAdapter(
      new CodexVoiceProvider(() => client as unknown as CodexAppServerClient),
      'codex'
    )
    const port: VoiceSessionPort = adapter
    expect(port.capabilities).toEqual(DESKTOP_CODEX_VOICE_CAPABILITIES)
    expect(port.capabilities.localOnly).toBe(true)
    expect(port.capabilities.sdp).toBe(true)
    expect(port.capabilities.websocketFrames).toBe(false)
  })

  it('starts a GPT Live API session, maps transcript/usage/close, and speaks fallback via appendSpeech', async () => {
    const { provider, socket, fetcher } = apiHarness()
    const adapter = new DesktopVoiceSessionAdapter(provider, DESKTOP_GPT_LIVE_VOICE_CAPABILITIES)
    const events: VoiceSessionEvent[] = []
    adapter.subscribe((event) => events.push(event))

    const result = await adapter.start(startInput({ openingLine: 'Hello, this is the secretary.' }))
    expect(result).toEqual({ sessionId: 'live_test', sdp: 'answer' })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      transport: { type: 'webrtc', sdp: 'offer' }
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    socket.server({ type: 'session.input_transcript.delta', delta: 'hello', start_ms: 0, end_ms: 10 })
    socket.server({ type: 'session.output_transcript.delta', delta: 'yes', start_ms: 11, end_ms: 20 })
    await new Promise((resolve) => setTimeout(resolve, 30))

    adapter.appendFallbackVoicemail(target())
    adapter.discardPlayback(target())
    expect(socket.sent.some((event) => event.type === 'session.instructions.append')).toBe(false)
    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'session.commentary.append', content: 'Hello, this is the secretary.' }),
      expect.objectContaining({ type: 'session.commentary.append', content: FALLBACK_VOICEMAIL_NOTE })
    ]))

    await adapter.close({ ...target(), reason: 'done' })

    expect(events).toContainEqual({ tenantId: 'local', callId: 'call-1', type: 'started', sessionId: 'live_test' })
    expect(events.filter((event) => event.type === 'transcript' && event.final)).toHaveLength(2)
    expect(events.some((event) => event.type === 'turnIdle' && event.tenantId === 'local' && event.callId === 'call-1')).toBe(true)
    expect(events).toContainEqual({ tenantId: 'local', callId: 'call-1', type: 'usage', observedSeconds: 17.5 })
    expect(events).toContainEqual({ tenantId: 'local', callId: 'call-1', type: 'closed', reason: 'close_requested' })
    expect(JSON.stringify(events)).not.toContain('fake-key-private')
    expect(JSON.stringify(events)).not.toContain('threadId')
  })

  it('rejects framed audio and missing SDP, and ignores actions for another call', async () => {
    const { provider, socket } = apiHarness()
    const adapter = createDesktopVoiceSessionAdapter(provider, 'gpt-live-api')
    await expect(adapter.start(startInput({ format: 'pcmu-8k' }))).rejects.toThrow('Desktop voice sessions only support webrtc-sdp')
    await expect(adapter.start(startInput({ sdp: '' }))).rejects.toThrow('A WebRTC SDP offer is required')
    await adapter.start(startInput())
    adapter.appendFallbackVoicemail({ tenantId: 'local', callId: 'other' })
    adapter.discardPlayback({ tenantId: 'other', callId: 'call-1' })
    expect(socket.sent).toHaveLength(0)
    await adapter.close({ tenantId: 'other', callId: 'call-1', reason: 'noop' })
    expect(socket.sent.some((event) => event.type === 'session.close')).toBe(false)
    await adapter.close({ ...target(), reason: 'done' })
  })

  it('maps Codex start/transcript/close without pretending to support websocket frames', async () => {
    const client = {
      startRealtime: vi.fn(async () => ({ sdp: 'answer', threadId: 'thread', sessionId: 'session' })),
      appendSpeech: vi.fn(async () => {}),
      appendText: vi.fn(async () => {}),
      stopRealtime: vi.fn(async () => {})
    }
    const provider = new CodexVoiceProvider(() => client as unknown as CodexAppServerClient)
    const adapter = createDesktopVoiceSessionAdapter(provider, 'codex')
    const events: VoiceSessionEvent[] = []
    adapter.subscribe((event) => events.push(event))

    expect(await adapter.start(startInput())).toEqual({ sessionId: 'session', sdp: 'answer' })
    expect(client.startRealtime).toHaveBeenCalledWith(expect.objectContaining({ sdp: 'offer', callId: 'call-1', instructions: 'Be brief.' }))

    provider.notification({ method: 'thread/realtime/transcript/done', params: { role: 'caller', text: 'hello' } })
    provider.notification({ method: 'thread/realtime/transcript/done', params: { role: 'assistant', text: 'yes' } })
    adapter.appendFallbackVoicemail(target())
    expect(client.appendSpeech).toHaveBeenCalledWith(FALLBACK_VOICEMAIL_NOTE)
    adapter.discardPlayback(target())
    expect(client.appendSpeech).toHaveBeenCalledTimes(1)

    await adapter.close({ ...target(), reason: 'done' })
    expect(client.stopRealtime).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === 'transcript' && event.final)).toEqual([
      expect.objectContaining({ tenantId: 'local', callId: 'call-1', role: 'caller', text: 'hello', final: true }),
      expect.objectContaining({ tenantId: 'local', callId: 'call-1', role: 'assistant', text: 'yes', final: true })
    ])
    expect(events.some((event) => event.type === 'turnIdle')).toBe(true)
  })

  it('requires tenantId on start and session methods', async () => {
    const { provider } = apiHarness()
    const adapter = createDesktopVoiceSessionAdapter(provider, 'gpt-live-api')
    await expect(adapter.start({
      tenantId: '',
      callId: 'call-1',
      format: 'webrtc-sdp',
      instructions: 'Be brief.',
      voice: 'marin',
      sdp: 'offer'
    })).rejects.toThrow()
    expect(() => adapter.discardPlayback({ tenantId: '', callId: 'call-1' })).toThrow()
    expect(() => adapter.appendFallbackVoicemail({ tenantId: '', callId: 'call-1' })).toThrow()
    await expect(adapter.close({ tenantId: '', callId: 'call-1', reason: 'done' })).rejects.toThrow()
  })
})
