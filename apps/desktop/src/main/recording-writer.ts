import { createHash, type Hash } from 'node:crypto'
import { closeSync, openSync, statSync, writeSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CallStore } from './call-store.js'

const MAX_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

interface ActiveRecording {
  callId: string
  path: string
  fd: number
  bytes: number
  hash: Hash
}

function fileExtension(mime: string): string {
  if (mime.startsWith('audio/webm') || mime.startsWith('video/webm')) return 'webm'
  if (mime.startsWith('audio/mp4') || mime.startsWith('audio/aac')) return 'm4a'
  if (mime.startsWith('audio/ogg')) return 'ogg'
  if (mime.startsWith('audio/wav') || mime.startsWith('audio/x-wav')) return 'wav'
  return 'bin'
}

export class RecordingWriter {
  private readonly directory: string
  private readonly store: CallStore
  private readonly active = new Map<string, ActiveRecording>()
  private maximumTotalBytes: number
  private closed = false

  constructor(store: CallStore, recordingsDirectory: string, maximumTotalBytes = MAX_TOTAL_BYTES) {
    this.store = store
    this.directory = recordingsDirectory
    this.maximumTotalBytes = maximumTotalBytes
  }

  initialize(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    for (const { callId } of this.store.listIncompleteRecordings()) {
      this.store.updateRecordingStatus(callId, 'incomplete')
      this.store.writeAudit('recording.incomplete', callId, { reason: 'stale on startup' })
    }
  }

  getRecordingsPath(): string {
    return this.directory
  }

  start(callId: string, mime: string): void {
    if (this.closed) throw new Error('Recording writer is closed')
    const activeCallId = this.store.getActiveCallId()
    if (activeCallId !== callId) {
      this.store.writeAudit('recording.start_rejected', callId, {
        reason: 'call is not the active session',
        activeCallId: activeCallId ?? null
      })
      throw new Error('Call is not the active session; cannot start recording')
    }
    if (this.active.has(callId)) return
    const extension = fileExtension(mime)
    const filePath = join(this.directory, `${callId}.${extension}`)
    const fd = openSync(filePath, 'w', 0o600)
    this.active.set(callId, { callId, path: filePath, fd, bytes: 0, hash: createHash('sha256') })
    this.store.putRecording({
      callId,
      path: filePath,
      mime,
      status: 'recording'
    })
    this.store.writeAudit('recording.started', callId, { mime, path: filePath })
  }

  chunk(callId: string, seq: number, data: Uint8Array): void {
    if (this.closed) return
    const recording = this.active.get(callId)
    if (!recording) {
      this.store.writeAudit('recording.chunk_rejected', callId, {
        seq,
        reason: 'no active recording for call'
      })
      return
    }
    if (data.byteLength > MAX_CHUNK_BYTES) {
      this.abort(recording, 'chunk_too_large', { seq, bytes: data.byteLength })
      return
    }
    const next = recording.bytes + data.byteLength
    if (next > this.maximumTotalBytes) {
      this.abort(recording, 'limit_exceeded', {
        seq,
        bytes: data.byteLength,
        totalBytes: next
      })
      return
    }
    writeSync(recording.fd, data, 0, data.byteLength)
    recording.hash.update(data)
    recording.bytes = next
  }

  finish(callId: string, durationMs: number): void {
    const recording = this.active.get(callId)
    if (!recording) return
    this.active.delete(callId)
    closeSync(recording.fd)
    const size = statSync(recording.path).size
    const digest = recording.hash.digest('hex')
    this.store.updateRecordingStatus(callId, 'complete', {
      bytes: size,
      sha256: digest,
      durationMs
    })
    this.store.writeAudit('recording.complete', callId, { bytes: size, durationMs })
  }

  close(): void {
    for (const recording of this.active.values()) {
      closeSync(recording.fd)
      this.store.updateRecordingStatus(recording.callId, 'incomplete')
      this.store.writeAudit('recording.incomplete', recording.callId, {
        reason: 'writer closed before finish'
      })
    }
    this.active.clear()
    this.closed = true
  }

  private abort(recording: ActiveRecording, action: string, details: unknown): void {
    this.active.delete(recording.callId)
    closeSync(recording.fd)
    this.store.updateRecordingStatus(recording.callId, 'incomplete')
    this.store.writeAudit(`recording.${action}`, recording.callId, details)
  }
}