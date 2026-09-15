import { describe, expect, it } from 'vitest'

import type { CodexNotification, StartThreadOptions, TurnInput } from '../codex/types.js'
import { CodexAnalysisBackend, type AnalysisThreadClient } from './backend.js'

class FakeThreadClient implements AnalysisThreadClient {
  options?: StartThreadOptions
  input?: TurnInput
  private listener?: (notification: CodexNotification) => void

  async startThread(options?: StartThreadOptions): Promise<string> {
    this.options = options
    return 'analysis-thread'
  }

  async startTurn(_threadId: string, input: TurnInput): Promise<string> {
    this.input = input
    queueMicrotask(() => {
      this.listener?.({
        method: 'item/completed',
        params: {
          threadId: 'analysis-thread', turnId: 'analysis-turn',
          item: { type: 'agentMessage', text: '{"outcome":"reached"}' }
        }
      })
      this.listener?.({
        method: 'turn/completed',
        params: { threadId: 'analysis-thread', turn: { id: 'analysis-turn', status: 'completed' } }
      })
    })
    return 'analysis-turn'
  }

  onThreadNotification(
    _threadId: string,
    listener: (notification: CodexNotification) => void
  ): () => void {
    this.listener = listener
    return () => { this.listener = undefined }
  }
}

describe('CodexAnalysisBackend', () => {
  it('uses an ephemeral tool-free text thread and returns its agent message', async () => {
    const client = new FakeThreadClient()
    const backend = new CodexAnalysisBackend(client, { model: 'test-codex' })

    await expect(backend.runExtraction('analyze this transcript')).resolves.toEqual({
      text: '{"outcome":"reached"}',
      model: 'test-codex'
    })
    expect(client.options).toMatchObject({ ephemeral: true })
    expect(client.options?.dynamicTools).toBeUndefined()
    expect(client.options?.developerInstructions).toContain('untrusted phone-call transcript')
    expect(client.input).toBe('analyze this transcript')
  })
})
