import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { GptLiveApiVoiceProvider, type LiveSocket } from './gpt-live-api-provider.js'
import { CodexVoiceProvider } from './codex-provider.js'
import { CallStore } from '../call-store.js'
import type { CodexAppServerClient } from '../codex/index.js'
import type { VoiceEvent, VoiceProvider } from './provider.js'

class FakeSocket extends EventEmitter implements LiveSocket {
  sent: Array<Record<string, unknown>> = []
  send(data: string): void {
    const event = JSON.parse(data)
    this.sent.push(event)
    if (event.type === 'session.close') this.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 17.5 }, reason: 'close_requested' }))
  }
  close(): void { this.emit('close') }
  server(event: unknown): void { this.emit('message', JSON.stringify(event)) }
}
function apiHarness(autoStarted = true, audit = vi.fn(), segmentation: { silenceMs?: number; interruptionMs?: number } = {}) {
  const socket = new FakeSocket()
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify({ session: { id: 'live_test' }, transport: { sdp: 'answer', type: 'webrtc' } }), { status: 201 }))
  const provider = new GptLiveApiVoiceProvider({
    settings: { apiKey: () => 'fake-key-private-1234', headers: () => ({ Authorization: 'Bearer fake-key-private-1234' }) },
    voice: () => 'marin', fetch: fetcher, silenceMs: segmentation.silenceMs ?? 20,
    interruptionMs: segmentation.interruptionMs ?? 1, timeoutMs: 100,
    audit,
    socket: () => { setTimeout(() => { socket.emit('open'); if (autoStarted) socket.server({ type: 'session.started', session: { id: 'live_test' } }) }, 0); return socket }
  })
  return { provider, socket, fetcher, audit }
}

for (const kind of ['codex', 'api'] as const) describe(`${kind} voice provider contract`, () => {
  it('starts, appends, emits normalized transcript and closes', async () => {
    const events: VoiceEvent[] = []
    const api = kind === 'api' ? apiHarness() : undefined
    const client = { startRealtime: vi.fn(async () => ({ sdp: 'answer', threadId: 'thread', sessionId: 'session' })), appendSpeech: vi.fn(async () => {}), appendText: vi.fn(async () => {}), stopRealtime: vi.fn(async () => {}) }
    const provider: VoiceProvider = api?.provider ?? new CodexVoiceProvider(() => client as unknown as CodexAppServerClient)
    provider.subscribe((event) => events.push(event))
    expect((await provider.start({ sdp: 'offer', instructions: 'hello' })).sdp).toBe('answer')
    await provider.appendSpeech('speech')
    await provider.appendText('context')
    if (api) {
      api.socket.server({ type: 'session.input_transcript.delta', delta: 'hello', start_ms: 0, end_ms: 10 })
      api.socket.server({ type: 'session.output_transcript.delta', delta: 'yes', start_ms: 11, end_ms: 20 })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(api.socket.sent.map((e) => e.type)).toEqual(['session.commentary.append', 'session.thinking.append'])
      expect(JSON.parse(String(api.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ session: { model: 'gpt-live-1', delegation: { type: 'client' } }, transport: { type: 'webrtc', sdp: 'offer' } })
    } else {
      const codex = provider as CodexVoiceProvider
      codex.notification({ method: 'thread/realtime/transcript/done', params: { role: 'caller', text: 'hello' } })
      codex.notification({ method: 'thread/realtime/transcript/done', params: { role: 'assistant', text: 'yes' } })
      expect(client.appendText).toHaveBeenCalledWith('context')
    }
    expect(events.filter((e) => e.type === 'transcript' && e.final)).toHaveLength(2)
    expect(events).toContainEqual({ type: 'turnDone' })
    await provider.stop()
    if (api) expect(events).toContainEqual({ type: 'usage', seconds: 17.5 })
  })
})

it('drops punctuation-only API fragments and merges around a brief interruption', async () => {
  const { provider, socket } = apiHarness(true, vi.fn(), { silenceMs: 1_000, interruptionMs: 1_200 })
  const events: VoiceEvent[] = []
  provider.subscribe((event) => events.push(event))
  await provider.start({ sdp: 'offer' })
  socket.server({ type: 'session.input_transcript.delta', delta: 'Please', start_ms: 0, end_ms: 400 })
  socket.server({ type: 'session.output_transcript.delta', delta: 'okay', start_ms: 450, end_ms: 700 })
  socket.server({ type: 'session.input_transcript.delta', delta: 'continue', start_ms: 730, end_ms: 1_000 })
  socket.server({ type: 'session.output_transcript.delta', delta: '......', start_ms: 1_010, end_ms: 1_050 })

  const finals = events.filter((event): event is Extract<VoiceEvent, { type: 'transcript' }> => event.type === 'transcript' && event.final)
  expect(finals.map(({ role, text }) => ({ role, text }))).toEqual([
    { role: 'caller', text: 'Please continue' },
    { role: 'assistant', text: 'okay' }
  ])
  await provider.stop()
  expect(events.filter((event) => event.type === 'transcript' && event.final && event.text === '......')).toHaveLength(0)
})

it('API silence blocks subsequent injection and final usage survives graceful close', async () => {
  const { provider, socket } = apiHarness()
  const events: VoiceEvent[] = []
  provider.subscribe((event) => events.push(event))
  await provider.start({ sdp: 'offer' })
  await provider.silence()
  await provider.appendText('late tool result')
  expect(socket.sent).toHaveLength(1)
  expect(socket.sent[0]?.type).toBe('session.instructions.append')
  expect(socket.sent[0]?.content).toBe('Finish your current sentence, then stop speaking and do not start a new turn.')
  expect(socket.sent[0]?.delegation_id).toBeNull()
  await provider.stop()
  expect(events.at(-1)).toEqual({ type: 'closed', reason: 'close_requested' })
  expect(JSON.stringify(events)).not.toContain('fake-key-private')
})

it('declines each API client delegation once and audits only its id', async () => {
  const store = new CallStore(':memory:')
  const audit = vi.fn((action: string, details?: { delegationId: string }) => store.writeAudit(action, undefined, details))
  const { provider, socket } = apiHarness(true, audit)
  await provider.start({ sdp: 'offer' })
  const created = { type: 'session.delegation.created', delegation: { id: 'delegation-1' } }
  socket.server(created)
  socket.server(created)
  expect(socket.sent).toHaveLength(1)
  expect(socket.sent[0]).toMatchObject({
    type: 'session.commentary.append',
    delegation_id: 'delegation-1',
    content: 'This request cannot be handled during this call. Tell the caller briefly, in the language of the conversation, that you cannot do that right now, and continue the conversation.'
  })
  expect(audit).toHaveBeenCalledOnce()
  expect(audit).toHaveBeenCalledWith('voice.delegation.declined', { delegationId: 'delegation-1' })
  expect(store.listAudit()).toContainEqual(expect.objectContaining({
    action: 'voice.delegation.declined', details: { delegationId: 'delegation-1' }
  }))
  await provider.stop()
  store.close()
})

it('queues an API delegation decline until ready and ignores invalid payloads', async () => {
  const { provider, socket, audit } = apiHarness(false)
  await provider.start({ sdp: 'offer' })
  socket.server({ type: 'session.delegation.created' })
  socket.server({ type: 'session.delegation.created', delegation: null })
  socket.server({ type: 'session.delegation.created', delegation: { id: 123 } })
  socket.server({ type: 'session.delegation.created', delegation: { id: '' } })
  socket.server({ type: 'session.delegation.created', delegation: { id: 'delegation-queued' } })
  expect(socket.sent).toHaveLength(0)
  expect(audit).toHaveBeenCalledWith('voice.delegation.declined', { delegationId: 'delegation-queued' })
  provider.markStarted('live_test')
  expect(socket.sent).toHaveLength(1)
  expect(socket.sent[0]).toMatchObject({ type: 'session.commentary.append', delegation_id: 'delegation-queued' })
  await provider.stop()
})

it('does not decline API delegations while ending', async () => {
  const { provider, socket, audit } = apiHarness()
  await provider.start({ sdp: 'offer' })
  await provider.silence()
  socket.server({ type: 'session.delegation.created', delegation: { id: 'delegation-late' } })
  expect(socket.sent.map((event) => event.type)).toEqual(['session.instructions.append'])
  expect(audit).not.toHaveBeenCalledWith('voice.delegation.declined', expect.anything())
  await provider.stop()
})

it('sanitizes network and server errors', async () => {
  const provider = new GptLiveApiVoiceProvider({ settings: { apiKey: () => 'secret-test-9876', headers: () => ({}) }, voice: () => 'marin', fetch: async () => { throw new Error('secret-test-9876') } })
  await expect(provider.start({ sdp: 'offer' })).rejects.toThrow('GPT Live API session could not be started')
})

it('accepts renderer readiness only for the current session and drains queued context in order', async () => {
  const { provider, socket } = apiHarness(false)
  const events: VoiceEvent[] = []
  provider.subscribe((event) => events.push(event))
  await provider.start({ sdp: 'offer' })
  await provider.appendText('first')
  await provider.appendSpeech('second')
  expect(socket.sent).toHaveLength(0)
  expect(provider.markStarted('live_old')).toBe(false)
  expect(socket.sent).toHaveLength(0)
  expect(provider.markStarted('live_test')).toBe(true)
  socket.server({ type: 'session.started', session: { id: 'live_test' } })
  expect(events.filter((event) => event.type === 'started')).toHaveLength(1)
  expect(socket.sent.map((event) => event.content)).toEqual(['first', 'second'])
  await provider.stop()
})

it('bounds pending injections and uses silence as a barrier before readiness', async () => {
  const { provider, socket } = apiHarness(false)
  await provider.start({ sdp: 'offer' })
  for (let index = 0; index < 12; index++) await provider.appendText(String(index))
  provider.markStarted('live_test')
  expect(socket.sent.map((event) => event.content)).toEqual(['4', '5', '6', '7', '8', '9', '10', '11'])
  await provider.stop()
  const next = apiHarness(false)
  await next.provider.start({ sdp: 'offer' })
  await next.provider.appendText('stale')
  await next.provider.silence()
  await next.provider.appendSpeech('late')
  next.provider.markStarted('live_test')
  expect(next.socket.sent.map((event) => event.type)).toEqual(['session.instructions.append'])
  await next.provider.stop()
})

it('fails if neither connection reports session.started', async () => {
  const { provider } = apiHarness(false)
  const events: VoiceEvent[] = []
  provider.subscribe((event) => events.push(event))
  await provider.start({ sdp: 'offer' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(events).toContainEqual({ type: 'error', message: 'GPT Live API connection failed' })
  await provider.stop()
})

it('waits for API output finalization before end_call and persists final seconds after call.ended', async () => {
  const { bindVoiceUsage } = await import('./call-usage.js')
  const { createEndCallTool } = await import('../call-control/tools.js')
  const store = new CallStore(':memory:')
  const { provider, socket } = apiHarness()
  const unbind = bindVoiceUsage(provider, store, () => 'gpt-live-api')
  const call = { id: 'call-api', direction: 'outbound' as const, peer: '+14155550142', status: 'active' as const }
  store.report({ call, runtimeMode: 'mock' })
  await provider.start({ sdp: 'offer' })
  socket.server({ type: 'session.output_transcript.delta', delta: 'Goodbye.', start_ms: 1, end_ms: 10 })
  const turnDone = new Promise<void>((resolve) => provider.subscribe((event) => { if (event.type === 'turnDone') resolve() }))
  const hangup = vi.fn(async () => {
    store.report({ call: { ...call, status: 'ended' }, runtimeMode: 'mock' })
    await provider.stop()
  })
  const tool = createEndCallTool({ hangup, silence: () => provider.silence(), writeAudit: vi.fn() })
  const result = await tool.execute({ campaignId: 'campaign', callSessionId: call.id, actor: 'copilot', turnDone }, { reason: 'completed', farewell_said: true })
  expect(hangup).not.toHaveBeenCalled()
  await result.completion
  expect(hangup).toHaveBeenCalledOnce()
  expect(store.getCall(call.id)).toMatchObject({ voiceProvider: 'gpt-live-api', voiceSeconds: 17.5 })
  expect(socket.sent[0]?.type).toBe('session.instructions.append')
  unbind()
  store.close()
})
