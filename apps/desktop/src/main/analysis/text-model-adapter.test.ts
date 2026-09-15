import { describe, expect, it } from 'vitest'

import type { CodexNotification, StartThreadOptions, TurnInput } from '../codex/types.js'
import type { TextModelPort } from '@mishu/core/ports'
import { CodexAnalysisBackend, MockAnalysisBackend, type AnalysisThreadClient } from './backend.js'
import { AnalysisTextModelAdapter, serializeTextModelInput } from './text-model-adapter.js'

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

describe('AnalysisTextModelAdapter', () => {
  it('wraps CodexAnalysisBackend as TextModelPort without requiring SDP or thread ids on the port', async () => {
    const client = new FakeThreadClient()
    const backend = new CodexAnalysisBackend(client, { model: 'test-codex' })
    const port: TextModelPort = new AnalysisTextModelAdapter(backend)

    const result = await port.complete({
      tenantId: 'local',
      model: 'ignored-by-codex',
      input: 'analyze this transcript',
      text: {
        format: {
          type: 'json_schema',
          name: 'call_extraction',
          strict: true,
          schema: { type: 'object' }
        }
      },
      reasoning: { effort: 'none' }
    })

    expect(result).toEqual({ outputText: '{"outcome":"reached"}' })
    expect(result.usage).toBeUndefined()
    expect(client.input).toBe('analyze this transcript')
    expect(client.options).toMatchObject({ ephemeral: true })
  })

  it('forwards schema to MockAnalysisBackend and ignores reasoning', async () => {
    const backend = new MockAnalysisBackend(['{"ok":true}'])
    const port: TextModelPort = new AnalysisTextModelAdapter(backend)
    const schema = { type: 'object', properties: { name: { type: 'string' } } }

    const result = await port.complete({
      tenantId: 'local',
      input: [{ role: 'user', content: 'extract' }],
      text: { format: { type: 'json_schema', name: 'call_extraction', strict: true, schema } },
      reasoning: { effort: 'high' }
    })

    expect(result.outputText).toBe('{"ok":true}')
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0]?.schema).toEqual(schema)
    expect(backend.calls[0]?.prompt).toBe(JSON.stringify([{ role: 'user', content: 'extract' }]))
  })

  it('rejects an already-aborted signal without calling the backend', async () => {
    const backend = new MockAnalysisBackend(['{"ok":true}'])
    const port = new AnalysisTextModelAdapter(backend)
    const signal = AbortSignal.abort()
    await expect(port.complete({
      tenantId: 'local',
      input: 'prompt',
      signal
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(backend.calls).toHaveLength(0)
  })

  it('serializes string input unchanged', () => {
    expect(serializeTextModelInput('plain prompt')).toBe('plain prompt')
    expect(serializeTextModelInput(null)).toBe('')
    expect(serializeTextModelInput({ role: 'user', content: 'hi' })).toBe('{"role":"user","content":"hi"}')
  })
})
