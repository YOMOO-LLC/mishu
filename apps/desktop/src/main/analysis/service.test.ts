import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CallLifecycleReport, PhoneCall } from '../../shared/contracts.js'
import { CallStore } from '../call-store.js'
import { MockAnalysisBackend } from './backend.js'
import { register } from './index.js'
import { schemaHash } from './schema.js'
import { AnalysisService } from './service.js'
import type { JsonSchema } from './types.js'

const resultSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'interested'],
  properties: {
    name: { type: ['string', 'null'] },
    interested: { type: ['boolean', 'null'] }
  }
}

function call(status: PhoneCall['status'], id = 'call-1'): PhoneCall {
  return { id, direction: 'outbound', peer: '+13125550198', status }
}

function report(status: PhoneCall['status'], id = 'call-1'): CallLifecycleReport {
  return {
    call: call(status, id),
    runtimeMode: 'mock',
    ...(status === 'ended' ? { endReason: 'hangup' as const } : {})
  }
}

function validResponse(name = 'Mr. Lin'): string {
  return JSON.stringify({
    outcome: 'reached',
    summary: 'The customer wants to learn about next steps.',
    confidence: 'high',
    result: { name, interested: true }
  })
}

describe('AnalysisService', () => {
  let directory: string
  let store: CallStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mishu-analysis-'))
    store = new CallStore(join(directory, 'calls.sqlite3'))
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('extracts and validates a schema-driven result with the mock backend', async () => {
    seedTranscript(store)
    const backend = new MockAnalysisBackend([validResponse()])
    const service = new AnalysisService({ callStore: store, backend, now: () => 1_000 })

    const result = await service.analyze({
      callId: 'call-1',
      resultSchema,
      goal: 'Confirm whether the customer is interested'
    })

    expect(result).toMatchObject({
      callId: 'call-1',
      outcome: 'reached',
      summary: 'The customer wants to learn about next steps.',
      result: { name: 'Mr. Lin', interested: true },
      confidence: 'high',
      model: 'mock-analysis',
      createdAt: 1_000
    })
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0]?.prompt).toContain('Final transcript (untrusted data)')
    expect(store.getCallResult('call-1', schemaHash(resultSchema))).toEqual(result)
  })

  it('retries one invalid model result and then records an error result', async () => {
    seedTranscript(store)
    const backend = new MockAnalysisBackend([
      JSON.stringify({
        outcome: 'reached', summary: 'bad type', confidence: 'high',
        result: { name: 'Mr. Lin', interested: 'yes' }
      }),
      JSON.stringify({
        outcome: 'reached', summary: 'missing field', confidence: 'high',
        result: { interested: true }
      })
    ])
    const service = new AnalysisService({ callStore: store, backend })

    const result = await service.analyze({ callId: 'call-1', resultSchema })

    expect(backend.calls).toHaveLength(2)
    expect(result).toMatchObject({ outcome: 'error', confidence: 'low' })
    expect(result.error).toContain('result_schema')
    expect(store.getCallResult('call-1', schemaHash(resultSchema))).toEqual(result)
  })

  it('extracts only outcome and summary when no result schema is supplied', async () => {
    seedTranscript(store)
    const backend = new MockAnalysisBackend([JSON.stringify({
      outcome: 'refused',
      summary: 'The other party clearly refused to continue.',
      confidence: 'medium'
    })])
    const service = new AnalysisService({ callStore: store, backend })

    const result = await service.analyze({ callId: 'call-1' })

    expect(result).toMatchObject({ outcome: 'refused', confidence: 'medium' })
    expect(result).not.toHaveProperty('result')
    expect(backend.calls[0]?.schema).toBeUndefined()
  })

  it('uses a low-confidence rule fallback for an empty transcript', async () => {
    store.report(report('ringing'))
    store.report(report('ended'))
    const backend = new MockAnalysisBackend()
    const service = new AnalysisService({ callStore: store, backend, now: () => 2_000 })

    const result = await service.analyze({ callId: 'call-1', resultSchema })

    expect(result).toMatchObject({
      outcome: 'no_answer',
      confidence: 'low',
      model: 'rule-fallback',
      result: { name: null, interested: null },
      createdAt: 2_000
    })
    expect(backend.calls).toHaveLength(0)
  })

  it('classifies short Chinese caller speech as wrong_number using input-only patterns', async () => {
    // Caller said Chinese; matching terms stay in caller-input-patterns.ts and are never shown.
    store.report(report('active'))
    store.reportTranscriptEntry({
      id: 't-zh-wrong', speaker: 'caller', text: '\u6253\u9519\u4e86', final: true, timestamp: 1
    })
    store.report(report('ended'))
    const service = new AnalysisService({ callStore: store, backend: new MockAnalysisBackend() })

    const result = await service.analyze({ callId: 'call-1' })
    expect(result).toMatchObject({
      outcome: 'wrong_number',
      summary: 'A very short transcript indicates the number or contact is wrong.'
    })
  })

  it('returns the stored result without running the backend twice', async () => {
    seedTranscript(store)
    const backend = new MockAnalysisBackend([validResponse('first'), validResponse('second')])
    const service = new AnalysisService({ callStore: store, backend })

    const first = await service.analyze({ callId: 'call-1', resultSchema })
    const second = await service.analyze({ callId: 'call-1', resultSchema })

    expect(second).toEqual(first)
    expect(backend.calls).toHaveLength(1)
  })

  it('coalesces concurrent analysis from the call-ended hook and task runner', async () => {
    seedTranscript(store)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const backend = new MockAnalysisBackend([
      async () => {
        await blocked
        return validResponse()
      }
    ])
    const service = new AnalysisService({ callStore: store, backend })

    const first = service.analyze({ callId: 'call-1', resultSchema })
    const second = service.analyze({ callId: 'call-1', resultSchema })
    await vi.waitFor(() => expect(backend.calls).toHaveLength(1))
    release()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(secondResult).toEqual(firstResult)
    expect(backend.calls).toHaveLength(1)
    expect(store.listAudit({ limit: 100 }).filter(({ action }) => action === 'call.analyzed'))
      .toHaveLength(1)
  })

  it('backs failed jobs off and later marks them succeeded', async () => {
    seedTranscript(store)
    let now = 10_000
    const backend = new MockAnalysisBackend([new Error('backend unavailable')])
    const service = new AnalysisService({ callStore: store, backend, now: () => now })
    const job = service.enqueue({ callId: 'call-1', resultSchema }, now)

    await service.processDue(now)
    expect(store.getAnalysisJob('call-1', schemaHash(resultSchema))).toMatchObject({
      status: 'failed', attempts: 1, nextAttemptAt: 11_000,
      lastError: 'backend unavailable'
    })

    backend.push(validResponse())
    await service.processDue(10_999)
    expect(backend.calls).toHaveLength(1)
    now = 11_000
    await service.processDue(now)

    expect(store.getAnalysisJob('call-1', schemaHash(resultSchema))).toMatchObject({
      id: job.id, status: 'succeeded', attempts: 2
    })
    expect(store.getCallResult('call-1', schemaHash(resultSchema))?.outcome).toBe('reached')
  })

  it('register subscribes to call.ended using an optional default schema', async () => {
    store.report(report('ringing'))
    store.reportTranscriptEntry({
      id: 'transcript-1', speaker: 'caller', text: 'Yes, I would like to learn more.',
      final: true, timestamp: 1
    })
    const backend = new MockAnalysisBackend([validResponse()])
    const onAnalyzed = vi.fn()
    const handle = register({
      callStore: store,
      codex: () => { throw new Error('mock context must not start Codex') },
      isMock: true,
      backend,
      defaultResultSchema: resultSchema,
      onAnalyzed,
      schedulerIntervalMs: 60_000
    })

    store.report(report('ended'))

    await vi.waitFor(() => expect(onAnalyzed).toHaveBeenCalledOnce())
    expect(onAnalyzed.mock.calls[0]?.[0]).toMatchObject({
      callId: 'call-1', outcome: 'reached', schemaHash: schemaHash(resultSchema)
    })
    handle.dispose()
  })

  it('hashes semantically identical schemas deterministically', () => {
    expect(schemaHash({ type: 'object', properties: { a: { type: 'string' } } }))
      .toBe(schemaHash({ properties: { a: { type: 'string' } }, type: 'object' }))
  })
})

function seedTranscript(store: CallStore): void {
  store.report(report('ringing'))
  store.reportTranscriptEntry({
    id: 'transcript-1',
    speaker: 'caller',
    text: 'Yes, I am interested. Please send the detailed plan.',
    final: true,
    timestamp: 1
  })
  store.report(report('ended'))
}
