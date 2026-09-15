import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CallLifecycleReport, PhoneCall } from '../shared/contracts'
import { CallStore } from './call-store'
import { RecordingWriter } from './recording-writer'

function call(status: PhoneCall['status'], id = 'call-1'): PhoneCall {
  return { id, direction: 'inbound', peer: '+13125550198', status }
}

function report(c: PhoneCall): CallLifecycleReport {
  return {
    call: c,
    runtimeMode: 'mock',
    campaign: {
      id: 'campaign-1',
      name: 'Default Campaign',
      direction: 'both',
      systemPrompt: 'Answer inbound calls politely',
      voice: 'juniper',
      policy: {
        persona: 'Answer inbound calls politely',
        allowedTopics: [],
        forbiddenTopics: [],
        forbiddenClaims: [],
        negativePrompt: '',
        recordingDisclosure: true,
        maxCallDurationSec: 600,
        callingHours: { timeZone: 'UTC', windows: [] },
        doNotCall: [],
        blockedCallers: []
      },
      createdAt: 1,
      updatedAt: 1
    },
    threadId: 'thread-1',
    sessionId: 'session-1'
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('RecordingWriter', () => {
  let directory: string
  let store: CallStore
  let writer: RecordingWriter

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mishu-rec-'))
    store = new CallStore(join(directory, 'calls.sqlite3'))
    store.report(report(call('ringing')))
    store.report(report(call('active')))
    writer = new RecordingWriter(store, join(directory, 'recordings'))
    writer.initialize()
  })

  afterEach(() => {
    writer.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('appends chunks in order and reports bytes and sha256 on finish', async () => {
    writer.start('call-1', 'audio/webm;codecs=opus')
    writer.chunk('call-1', 0, new Uint8Array([1, 2, 3]))
    writer.chunk('call-1', 1, new Uint8Array([4, 5]))
    writer.finish('call-1', 1200)

    const recording = store.getRecording('call-1')
    expect(recording).toMatchObject({
      callId: 'call-1',
      status: 'complete',
      bytes: 5,
      durationMs: 1200,
      mime: 'audio/webm;codecs=opus'
    })
    const file = join(directory, 'recordings', 'call-1.webm')
    expect(existsSync(file)).toBe(true)
    const content = readFileSync(file)
    expect(sha256(content)).toBe(recording?.sha256)
    expect(content).toEqual(Buffer.from([1, 2, 3, 4, 5]))
  })

  it('rejects chunks for a callId that is not the active call and audits them', () => {
    store.report(report(call('ringing', 'call-2')))
    store.report(report(call('active', 'call-2')))

    writer.chunk('call-2', 0, new Uint8Array([9]))

    expect(store.listAudit({ limit: 20 }).some(({ action }) => action === 'recording.chunk_rejected')).toBe(true)
  })

  it('marks a recording incomplete once the total size limit is exceeded', async () => {
    const limitedWriter = new RecordingWriter(store, join(directory, 'recordings'), 3)
    limitedWriter.initialize()
    limitedWriter.start('call-1', 'audio/webm')
    limitedWriter.chunk('call-1', 0, new Uint8Array([1, 2, 3]))
    limitedWriter.chunk('call-1', 1, new Uint8Array([4, 5]))

    expect(store.getRecording('call-1')?.status).toBe('incomplete')
    expect(store.listAudit({ limit: 20 }).some(({ action }) => action === 'recording.limit_exceeded')).toBe(true)
    limitedWriter.close()
  })

  it('marks stale recording rows as incomplete on initialization', () => {
    writer.start('call-1', 'audio/webm')
    writer.chunk('call-1', 0, new Uint8Array([7]))
    writer.close()

    store.report(report(call('ringing', 'call-1')))
    store.report(report(call('active', 'call-1')))
    writer = new RecordingWriter(store, join(directory, 'recordings'))
    writer.initialize()

    expect(store.getRecording('call-1')?.status).toBe('incomplete')
  })

  it('records a complete entry with file bytes greater than zero in mock mode', async () => {
    writer.start('call-1', 'audio/webm;codecs=opus')
    writer.chunk('call-1', 0, new Uint8Array(Array.from({ length: 64 }, (_, i) => i % 256)))
    writer.finish('call-1', 500)

    const recording = store.getRecording('call-1')
    expect(recording?.status).toBe('complete')
    expect(recording?.bytes ?? 0).toBeGreaterThan(0)
    expect(statSync(join(directory, 'recordings', 'call-1.webm')).size).toBe(recording?.bytes)
  })
})