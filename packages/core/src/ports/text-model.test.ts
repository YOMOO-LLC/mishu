import { describe, expect, it, expectTypeOf } from 'vitest'
import {
  DEFAULT_HANGUP_MODEL,
  HANGUP_REASONING_EFFORT,
  type HangupJudge
} from '@mishu/core/hangup'
import {
  TEXT_MODEL_REASONING_EFFORTS,
  createTextModelHangupJudge,
  type TextModelCompleteRequest,
  type TextModelPort,
  type TextModelReasoningEffort
} from '@mishu/core/ports'
import type { Clock } from '@mishu/core/clock'

const TURNS = [
  { role: 'caller' as const, text: 'Alright, that is all. Goodbye.' },
  { role: 'assistant' as const, text: 'Goodbye.' }
]

function failingPort(error: Error = new Error('responses_http_400')): TextModelPort {
  return {
    async complete() {
      throw error
    }
  }
}

function scriptedPort(
  handler: (request: TextModelCompleteRequest) => string | Promise<string>
): { port: TextModelPort; requests: TextModelCompleteRequest[] } {
  const requests: TextModelCompleteRequest[] = []
  return {
    requests,
    port: {
      async complete(request) {
        requests.push(request)
        return { outputText: await handler(request) }
      }
    }
  }
}

function createManualClock(start = 0): Clock & { fireAll(): void } {
  const pending = new Map<unknown, () => void>()
  let nextId = 1
  return {
    now: () => start,
    setTimeout(fn) {
      const id = nextId++
      pending.set(id, fn)
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    fireAll() {
      for (const [id, fn] of pending) {
        pending.delete(id)
        fn()
      }
    }
  }
}

describe('TextModelPort', () => {
  it('allows only none | low | medium | high reasoning effort', () => {
    expect(TEXT_MODEL_REASONING_EFFORTS).toEqual(['none', 'low', 'medium', 'high'])
    expect(TEXT_MODEL_REASONING_EFFORTS).not.toContain('minimal')
    expectTypeOf<TextModelReasoningEffort>().toEqualTypeOf<'none' | 'low' | 'medium' | 'high'>()
    const allowed: TextModelReasoningEffort = 'none'
    expect(allowed).toBe('none')
    // @ts-expect-error gpt-5.6-luna rejects minimal (400)
    const _minimal: TextModelReasoningEffort = 'minimal'
    void _minimal
  })

  it('requires tenantId on complete and omits max_tokens from the request type', async () => {
    const { port, requests } = scriptedPort(() => '{"ok":true}')
    const typed: TextModelPort = port
    await typed.complete({
      tenantId: 'local',
      model: 'gpt-5.6-luna',
      input: [{ role: 'user', content: 'hi' }],
      text: { format: { type: 'json_schema', name: 'probe', strict: true, schema: {} } },
      reasoning: { effort: 'none' }
    })
    expect(requests[0]?.tenantId).toBe('local')
    expect(requests[0]).not.toHaveProperty('max_tokens')
    expect(requests[0]).not.toHaveProperty('max_completion_tokens')
  })
})

describe('createTextModelHangupJudge', () => {
  it('fail-closes when the TextModelPort throws', async () => {
    const judge: HangupJudge = createTextModelHangupJudge({
      port: failingPort(),
      tenantId: 'local'
    })
    expect(await judge(TURNS)).toEqual({ end: false, reason: 'judge_failed' })
  })

  it('fail-closes on abort/timeout, empty output, and invalid JSON', async () => {
    const clock = createManualClock()
    const hanging: TextModelPort = {
      complete(request) {
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      }
    }
    const timeoutJudge = createTextModelHangupJudge({
      port: hanging,
      tenantId: 'local',
      timeoutMs: 5,
      clock
    })
    const pending = timeoutJudge(TURNS)
    clock.fireAll()
    expect(await pending).toEqual({ end: false, reason: 'judge_failed' })

    const empty = createTextModelHangupJudge({
      port: { async complete() { return { outputText: '   ' } } },
      tenantId: 'local'
    })
    expect(await empty(TURNS)).toEqual({ end: false, reason: 'judge_empty' })

    const invalid = createTextModelHangupJudge({
      port: { async complete() { return { outputText: 'not-json' } } },
      tenantId: 'local'
    })
    expect(await invalid(TURNS)).toEqual({ end: false, reason: 'judge_failed' })
  })

  it('hangs up only on literal end true and sends json_schema with effort none', async () => {
    const { port, requests } = scriptedPort(() => JSON.stringify({
      end: true,
      reason: 'both_said_goodbye'
    }))
    const judge = createTextModelHangupJudge({
      port,
      tenantId: 'local',
      model: DEFAULT_HANGUP_MODEL
    })
    expect(await judge(TURNS)).toEqual({ end: true, reason: 'both_said_goodbye' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tenantId).toBe('local')
    expect(requests[0]?.model).toBe(DEFAULT_HANGUP_MODEL)
    expect(requests[0]?.reasoning).toEqual({ effort: HANGUP_REASONING_EFFORT })
    expect(requests[0]?.reasoning).toEqual({ effort: 'none' })
    expect(requests[0]?.text?.format).toMatchObject({
      type: 'json_schema',
      name: 'hangup_verdict',
      strict: true
    })
    expect(requests[0]).not.toHaveProperty('max_tokens')
    expect(requests[0]).not.toHaveProperty('max_completion_tokens')
  })

  it('never hangs up on an empty transcript', async () => {
    const judge = createTextModelHangupJudge({
      port: failingPort(new Error('should not be called')),
      tenantId: 'local'
    })
    expect(await judge([])).toEqual({ end: false, reason: 'empty' })
  })
})
