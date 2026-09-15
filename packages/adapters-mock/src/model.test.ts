import { describe, expect, it } from 'vitest'
import { FakeClock } from '@mishu/adapters-mock/clock'
import { describeTextModelPortContract } from '@mishu/adapters-mock/contract-tests'
import { MockTextModel } from '@mishu/adapters-mock/model'
import { waitFor } from '@mishu/core/clock'
import type { TextModelCompleteRequest } from '@mishu/core/ports'

describeTextModelPortContract(() => new MockTextModel())

describe('MockTextModel', () => {
  it('matches scripted output on input and records requests', async () => {
    const port = new MockTextModel({
      defaultOutputText: 'fallback',
      scripts: [
        {
          match: (request) => JSON.stringify(request.input).includes('hangup'),
          outputText: '{"end":true,"reason":"both_said_goodbye"}'
        }
      ]
    })
    const matched = await port.complete({
      tenantId: 'local',
      input: [{ role: 'user', content: 'hangup turns' }]
    })
    const other = await port.complete({
      tenantId: 'local',
      input: 'other'
    })
    expect(matched.outputText).toContain('both_said_goodbye')
    expect(other.outputText).toBe('fallback')
    expect(port.requests).toHaveLength(2)
    expect(port.requests[0]?.tenantId).toBe('local')
  })

  it('rejects requests that carry max_tokens or max_completion_tokens', async () => {
    const port = new MockTextModel()
    await expect(port.complete({
      tenantId: 'local',
      input: 'hi',
      max_tokens: 16
    } as TextModelCompleteRequest & { max_tokens: number })).rejects.toThrow(/max_tokens/)
    await expect(port.complete({
      tenantId: 'local',
      input: 'hi',
      max_completion_tokens: 16
    } as TextModelCompleteRequest & { max_completion_tokens: number })).rejects.toThrow(/max_completion_tokens/)
  })

  it('throws when configured so fail-closed callers can catch it', async () => {
    const port = new MockTextModel({ error: new Error('responses_http_400') })
    await expect(port.complete({ tenantId: 'local', input: 'x' })).rejects.toThrow('responses_http_400')
    expect(port.requests).toHaveLength(1)
  })

  it('hangs until abort so fail-closed callers can time out', async () => {
    const clock = new FakeClock(0)
    const port = new MockTextModel({ hang: true })
    const controller = new AbortController()
    const pending = port.complete({
      tenantId: 'local',
      input: 'x',
      signal: controller.signal
    })
    const abort = waitFor(clock, 5).then(() => controller.abort())
    clock.advance(5)
    await abort
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
