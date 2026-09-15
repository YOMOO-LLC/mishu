import type { LiveSocket } from '../voice/protocol/gpt-live.js'

type Listener = (data?: { toString(): string }) => void

/** Greeting token used by the spike fixture socket. Escaped so shipping sources stay ASCII. */
const FAKE_LIVE_GREETING = '\u60a8\u597d'

export class FakeLiveSocket implements LiveSocket {
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Listener[]>()

  on(event: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    if (event === 'open') queueMicrotask(() => listener())
  }

  send(data: string): void {
    this.sent.push(data)
    const event = JSON.parse(data) as { type?: string }
    if (event.type === 'session.start') this.emit('message', JSON.stringify({ type: 'session.started', session: { id: 'sess_fake' } }))
    if (event.type === 'session.commentary.append' || event.type === 'session.input_audio.append') {
      this.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: 'AA==' }))
      if (event.type === 'session.commentary.append') {
        this.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: FAKE_LIVE_GREETING }))
      }
    }
    if (event.type === 'session.close') {
      this.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 1.5 }, reason: 'close_requested' }))
    }
  }

  close(): void {
    this.emit('close')
  }

  private emit(event: string, payload?: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}
