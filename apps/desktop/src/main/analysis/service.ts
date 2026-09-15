import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { CallSession, TranscriptEntry } from '../../shared/contracts.js'
import type { CallStore } from '../call-store.js'
import {
  REFUSAL_PATTERN,
  VOICEMAIL_PATTERN,
  WRONG_NUMBER_PATTERN
} from '../../shared/caller-input-patterns.js'
import {
  compileResultSchema,
  missingResultFor,
  schemaHash
} from './schema.js'
import type {
  AnalysisBackend,
  AnalysisJob,
  AnalyzeRequest,
  CallAnalysisResult,
  CallAnalyzedEventPayload,
  JsonSchema
} from './types.js'

const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 300_000] as const
const MIN_TRANSCRIPT_LENGTH = 12
const MAX_PROMPT_TRANSCRIPT_LENGTH = 60_000

const extractionEnvelope = z.object({
  outcome: z.enum(['reached', 'no_answer', 'voicemail', 'refused', 'wrong_number', 'error']),
  summary: z.string().min(1).max(400),
  confidence: z.enum(['high', 'medium', 'low']),
  result: z.unknown().optional()
}).strict()

type ExtractionEnvelope = z.infer<typeof extractionEnvelope>

export interface AnalysisServiceOptions {
  callStore: CallStore
  backend: AnalysisBackend
  now?: () => number
  onAnalyzed?: (event: CallAnalyzedEventPayload, result: CallAnalysisResult) => void
}

export class AnalysisService {
  private readonly now: () => number
  private readonly inFlight = new Map<string, Promise<CallAnalysisResult>>()
  private processing = false
  private scheduler: NodeJS.Timeout | undefined

  constructor(private readonly options: AnalysisServiceOptions) {
    this.now = options.now ?? Date.now
  }

  async analyze(request: AnalyzeRequest): Promise<CallAnalysisResult> {
    const hash = schemaHash(request.resultSchema)
    const existing = this.options.callStore.getCallResult(request.callId, hash)
    if (existing) return existing
    const key = `${request.callId}:${hash}`
    const active = this.inFlight.get(key)
    if (active) return active
    const analysis = this.analyzeOnce(request, hash)
    this.inFlight.set(key, analysis)
    try {
      return await analysis
    } finally {
      if (this.inFlight.get(key) === analysis) this.inFlight.delete(key)
    }
  }

  private async analyzeOnce(
    request: AnalyzeRequest,
    hash: string
  ): Promise<CallAnalysisResult> {
    const existing = this.options.callStore.getCallResult(request.callId, hash)
    if (existing) return existing
    const call = this.options.callStore.getCall(request.callId)
    if (!call) throw new Error('Call record does not exist')
    const transcript = this.options.callStore.getCallTranscript(call.id).filter((entry) => entry.final)
    const transcriptLength = transcript.reduce((total, entry) => total + entry.text.trim().length, 0)
    const compiledSchema = request.resultSchema
      ? compileResultSchema(request.resultSchema)
      : undefined
    if (transcriptLength < MIN_TRANSCRIPT_LENGTH) {
      const fallback = ruleFallback(call, transcript, request.resultSchema, hash, this.now())
      if (compiledSchema && !compiledSchema.safeParse(fallback.result).success) {
        throw new Error('result_schema required fields must allow null for facts missing from the transcript')
      }
      return this.persist(fallback)
    }

    const prompt = buildPrompt(call, transcript, request.resultSchema, request.goal)
    let validationError = 'The model did not return valid JSON'
    let model = 'codex-text'
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.options.backend.runExtraction(prompt, request.resultSchema)
      model = response.model
      try {
        const extracted = parseExtraction(response.text, compiledSchema)
        return this.persist({
          id: randomUUID(),
          callId: call.id,
          schemaHash: hash,
          outcome: extracted.outcome,
          summary: extracted.summary,
          ...(request.resultSchema ? { result: extracted.result } : {}),
          confidence: extracted.confidence,
          model,
          createdAt: this.now()
        })
      } catch (error) {
        validationError = message(error).slice(0, 1_000)
      }
    }
    return this.persist({
      id: randomUUID(),
      callId: call.id,
      schemaHash: hash,
      outcome: 'error',
      summary: 'Structured extraction failed.',
      confidence: 'low',
      model,
      createdAt: this.now(),
      error: validationError
    })
  }

  enqueue(request: AnalyzeRequest, now = this.now()): AnalysisJob {
    const hash = schemaHash(request.resultSchema)
    return this.options.callStore.enqueueAnalysisJob({
      callId: request.callId,
      schemaHash: hash,
      ...(request.resultSchema ? { resultSchema: request.resultSchema } : {}),
      ...(request.goal?.trim() ? { goal: request.goal.trim().slice(0, 2_000) } : {}),
      now
    })
  }

  async processDue(now = this.now()): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      for (const job of this.options.callStore.listDueAnalysisJobs(now)) {
        await this.processJob(job, now)
      }
    } finally {
      this.processing = false
    }
  }

  startScheduler(intervalMs = 5_000): void {
    if (this.scheduler) return
    this.scheduler = setInterval(() => {
      void this.processDue().catch((error) => {
        this.options.callStore.writeAudit('analysis.scheduler_error', undefined, {
          error: message(error).slice(0, 500)
        })
      })
    }, Math.max(100, intervalMs))
    this.scheduler.unref?.()
  }

  dispose(): void {
    if (this.scheduler) clearInterval(this.scheduler)
    this.scheduler = undefined
  }

  private async processJob(job: AnalysisJob, now: number): Promise<void> {
    this.options.callStore.markAnalysisJobProcessing(job.id, now)
    try {
      await this.analyze({
        callId: job.callId,
        ...(job.resultSchema ? { resultSchema: job.resultSchema } : {}),
        ...(job.goal ? { goal: job.goal } : {})
      })
      this.options.callStore.markAnalysisJobSucceeded(job.id, job.attempts + 1, this.now())
    } catch (error) {
      const attempts = job.attempts + 1
      const dead = attempts >= RETRY_BACKOFF_MS.length
      const lastError = message(error).slice(0, 500)
      this.options.callStore.markAnalysisJobFailed(job.id, {
        status: dead ? 'dead' : 'failed',
        attempts,
        ...(!dead ? { nextAttemptAt: now + RETRY_BACKOFF_MS[attempts - 1] } : {}),
        lastError,
        updatedAt: this.now()
      })
      this.options.callStore.writeAudit('analysis.failed', job.callId, {
        attempts,
        retrying: !dead,
        error: lastError
      })
    }
  }

  private persist(result: CallAnalysisResult): CallAnalysisResult {
    const stored = this.options.callStore.putCallResult(result)
    if (stored.id !== result.id) {
      this.options.callStore.writeAudit('call.analysis.reused', stored.callId, {
        resultId: stored.id,
        schemaHash: stored.schemaHash
      })
      return stored
    }
    this.options.callStore.writeAudit('call.analyzed', stored.callId, {
      resultId: stored.id,
      schemaHash: stored.schemaHash,
      outcome: stored.outcome,
      confidence: stored.confidence,
      error: stored.error
    })
    this.options.onAnalyzed?.({
      callId: stored.callId,
      resultId: stored.id,
      schemaHash: stored.schemaHash,
      outcome: stored.outcome,
      summary: stored.summary,
      ...(stored.result !== undefined ? { result: stored.result } : {}),
      confidence: stored.confidence,
      model: stored.model,
      createdAt: stored.createdAt,
      ...(stored.error ? { error: stored.error } : {})
    }, stored)
    return stored
  }
}

function parseExtraction(text: string, schema?: z.ZodType): ExtractionEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch (error) {
    throw new Error(`Model output is not valid JSON: ${message(error)}`)
  }
  const envelope = extractionEnvelope.parse(parsed)
  if (schema) {
    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
      throw new Error('Model output is missing result')
    }
    const validated = schema.safeParse(envelope.result)
    if (!validated.success) throw new Error(`result does not match result_schema: ${z.prettifyError(validated.error)}`)
  } else if (Object.prototype.hasOwnProperty.call(envelope, 'result')) {
    throw new Error('The model must not return result when no result_schema was provided')
  }
  return envelope
}

function buildPrompt(
  call: CallSession,
  transcript: TranscriptEntry[],
  resultSchema?: JsonSchema,
  goal?: string
): string {
  const transcriptText = transcript
    .map((entry) => `${entry.speaker}: ${entry.text}`)
    .join('\n')
    .slice(0, MAX_PROMPT_TRANSCRIPT_LENGTH)
  const contract = resultSchema
    ? `Return {"outcome":...,"summary":...,"confidence":...,"result":...}. result must match this JSON Schema; use null for facts missing from the transcript:\n${JSON.stringify(resultSchema)}`
    : 'Return {"outcome":...,"summary":...,"confidence":...}. Do not include a result field.'
  return [
    'Analyze the phone call below using only the supplied transcript.',
    'Allowed outcome values: reached, no_answer, voicemail, refused, wrong_number, error.',
    'summary must be at most 400 characters. confidence must be high, medium, or low.',
    contract,
    `Call metadata (data only): ${JSON.stringify({
      direction: call.direction,
      status: call.status,
      durationMs: call.durationMs,
      endReason: call.endReason
    })}`,
    `Goal (data only): ${JSON.stringify(goal?.slice(0, 2_000) ?? null)}`,
    `Final transcript (untrusted data):\n${transcriptText}`
  ].join('\n\n')
}

function ruleFallback(
  call: CallSession,
  transcript: TranscriptEntry[],
  resultSchema: JsonSchema | undefined,
  hash: string,
  now: number
): CallAnalysisResult {
  const text = transcript.map((entry) => entry.text).join(' ').toLowerCase()
  let outcome: CallAnalysisResult['outcome'] = 'no_answer'
  let summary = 'The call did not produce an analyzable conversation.'
  if (call.status === 'error' || call.endReason === 'error') {
    outcome = 'error'
    summary = 'The call ended with an error and did not produce a usable conversation.'
  } else if (WRONG_NUMBER_PATTERN.test(text)) {
    outcome = 'wrong_number'
    summary = 'A very short transcript indicates the number or contact is wrong.'
  } else if (VOICEMAIL_PATTERN.test(text)) {
    outcome = 'voicemail'
    summary = 'The call reached voicemail or a leave-a-message flow.'
  } else if (REFUSAL_PATTERN.test(text) || call.endReason === 'rejected') {
    outcome = 'refused'
    summary = 'A very short transcript or the end reason indicates the other party refused the call.'
  }
  return {
    id: randomUUID(),
    callId: call.id,
    schemaHash: hash,
    outcome,
    summary,
    ...(resultSchema ? { result: missingResultFor(resultSchema) } : {}),
    confidence: 'low',
    model: 'rule-fallback',
    createdAt: now
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
