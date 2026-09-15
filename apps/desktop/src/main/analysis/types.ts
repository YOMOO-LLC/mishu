export type AnalysisOutcome =
  | 'reached'
  | 'no_answer'
  | 'voicemail'
  | 'refused'
  | 'wrong_number'
  | 'error'

export type AnalysisConfidence = 'high' | 'medium' | 'low'

export type JsonSchema = Record<string, unknown>

export interface AnalysisBackendResponse {
  text: string
  model: string
}

export interface AnalysisBackend {
  runExtraction(prompt: string, schema?: JsonSchema): Promise<AnalysisBackendResponse>
}

export interface AnalyzeRequest {
  callId: string
  resultSchema?: JsonSchema
  goal?: string
}

export interface CallAnalysisResult {
  id: string
  callId: string
  schemaHash: string
  outcome: AnalysisOutcome
  summary: string
  result?: unknown
  confidence: AnalysisConfidence
  model: string
  createdAt: number
  error?: string
}

export type AnalysisJobStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead'

export interface AnalysisJob {
  id: number
  callId: string
  schemaHash: string
  resultSchema?: JsonSchema
  goal?: string
  status: AnalysisJobStatus
  attempts: number
  nextAttemptAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface EnqueueAnalysisJobInput {
  callId: string
  schemaHash: string
  resultSchema?: JsonSchema
  goal?: string
  now: number
}

export interface AnalysisJobFailure {
  status: 'failed' | 'dead'
  attempts: number
  nextAttemptAt?: number
  lastError: string
  updatedAt: number
}

/** Payload reserved for the webhook bridge integration owned by T6.1. */
export interface CallAnalyzedEventPayload {
  callId: string
  resultId: string
  schemaHash: string
  outcome: AnalysisOutcome
  summary: string
  result?: unknown
  confidence: AnalysisConfidence
  model: string
  createdAt: number
  error?: string
}
