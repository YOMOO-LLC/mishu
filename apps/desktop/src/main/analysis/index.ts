import type { CallStore } from '../call-store.js'
import {
  CodexAnalysisBackend,
  MockAnalysisBackend,
  type AnalysisThreadClient
} from './backend.js'
import { AnalysisService } from './service.js'
import type {
  AnalysisBackend,
  CallAnalysisResult,
  CallAnalyzedEventPayload,
  JsonSchema
} from './types.js'

export interface AnalysisRegistrationContext {
  callStore: CallStore
  codex(): AnalysisThreadClient
  isMock: boolean
  backend?: AnalysisBackend
  defaultResultSchema?: JsonSchema | (() => JsonSchema | undefined)
  defaultGoal?: string | (() => string | undefined)
  onAnalyzed?: (event: CallAnalyzedEventPayload, result: CallAnalysisResult) => void
  schedulerIntervalMs?: number
}

export interface AnalysisModuleHandle {
  service: AnalysisService
  dispose(): void
}

/** Creates the post-call subscription; integration into main/index.ts is intentionally deferred. */
export function register(ctx: AnalysisRegistrationContext): AnalysisModuleHandle {
  const backend = ctx.backend ?? (ctx.isMock
    ? new MockAnalysisBackend()
    : new CodexAnalysisBackend(ctx.codex()))
  const service = new AnalysisService({
    callStore: ctx.callStore,
    backend,
    ...(ctx.onAnalyzed ? { onAnalyzed: ctx.onAnalyzed } : {})
  })
  const unsubscribe = ctx.callStore.onEvent((event) => {
    if (event.type !== 'call.ended') return
    const resultSchema = typeof ctx.defaultResultSchema === 'function'
      ? ctx.defaultResultSchema()
      : ctx.defaultResultSchema
    const goal = typeof ctx.defaultGoal === 'function' ? ctx.defaultGoal() : ctx.defaultGoal
    const now = Date.now()
    service.enqueue({
      callId: event.call.id,
      ...(resultSchema ? { resultSchema } : {}),
      ...(goal ? { goal } : {})
    }, now)
    void service.processDue(now).catch((error) => {
      ctx.callStore.writeAudit('analysis.scheduler_error', event.call.id, {
        error: error instanceof Error ? error.message : String(error)
      })
    })
  })
  service.startScheduler(ctx.schedulerIntervalMs)
  return {
    service,
    dispose() {
      unsubscribe()
      service.dispose()
    }
  }
}

export { CodexAnalysisBackend, MockAnalysisBackend } from './backend.js'
export { AnalysisService } from './service.js'
export { schemaHash } from './schema.js'
export { AnalysisTextModelAdapter, serializeTextModelInput } from './text-model-adapter.js'
export type * from './types.js'
