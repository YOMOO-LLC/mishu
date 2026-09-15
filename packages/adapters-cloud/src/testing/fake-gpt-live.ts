import type { GptLiveClientEvent, GptLiveTransport } from '../voice/protocol/gpt-live.js'

export class FakeGptLiveSession implements GptLiveTransport {
  readonly sent: GptLiveClientEvent[] = []
  private handler?: (raw: unknown) => void
  private onClose?: () => void
  closed = false
  failConnect = false
  slowOutput = false
  script: unknown[] = []

  send(event: GptLiveClientEvent): void {
    this.sent.push(event)
    if (event.type === 'session.start') {
      this.emit({ type: 'session.started', session: { id: 'sess_fake' } })
      for (const item of this.script) this.emit(item)
    }
    if (event.type === 'session.close') {
      this.emit({ type: 'session.closed', usage: { seconds: 2.5 }, reason: 'close_requested' })
    }
  }

  close(): void {
    this.closed = true
    this.onClose?.()
  }

  attach(handler: (raw: unknown) => void, onClose: () => void, _onError: () => void): void {
    this.handler = handler
    this.onClose = onClose
  }

  emit(raw: unknown): void {
    this.handler?.(raw)
  }

  disconnect(): void {
    this.closed = true
    this.onClose?.()
  }
}

export function audioDelta(payloadBase64: string): unknown {
  return { type: 'session.output_audio.delta', delta: payloadBase64 }
}

export function inputTranscript(delta: string, startMs = 0, endMs = 20): unknown {
  return { type: 'session.input_transcript.delta', delta, start_ms: startMs, end_ms: endMs }
}

export function outputTranscript(delta: string, startMs = 40, endMs = 80): unknown {
  return { type: 'session.output_transcript.delta', delta, start_ms: startMs, end_ms: endMs }
}
