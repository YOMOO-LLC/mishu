import type {
  RecordChunkRequest,
  RecordFinishRequest,
  RecordingInfo,
  RecordStartRequest
} from '../../shared/contracts.js'
import type { CallStore } from '../call-store.js'
import type { RecordingWriter } from '../recording-writer.js'
import { ServiceError } from './service-error.js'

export class RecordingService {
  constructor(private readonly store: CallStore, private readonly writer: RecordingWriter) {}

  start(request: RecordStartRequest): void {
    if (!request || typeof request.callId !== 'string' || typeof request.mime !== 'string') {
      throw new ServiceError('INVALID_ARGUMENT', 'Invalid recording start request')
    }
    this.writer.start(request.callId, request.mime)
  }

  chunk(request: RecordChunkRequest): void {
    if (!request || typeof request.callId !== 'string' || typeof request.seq !== 'number' || !(request.data instanceof Uint8Array)) {
      throw new ServiceError('INVALID_ARGUMENT', 'Invalid recording chunk request')
    }
    this.writer.chunk(request.callId, request.seq, request.data)
  }

  finish(request: RecordFinishRequest): void {
    if (!request || typeof request.callId !== 'string' || typeof request.durationMs !== 'number' || !Number.isFinite(request.durationMs) || request.durationMs < 0) {
      throw new ServiceError('INVALID_ARGUMENT', 'Invalid recording finish request')
    }
    this.writer.finish(request.callId, request.durationMs)
  }

  get(callId: string): RecordingInfo | undefined {
    return this.store.getRecording(callId)
  }
}
