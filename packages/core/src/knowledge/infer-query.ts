import { LEADING_FILLER } from '../caller-input.js'
import { normalizeText } from './normalize.js'
import type { QueryInferFn } from './types.js'

/**
 * Deterministic query inference from caller finals.
 * The real copilot can be injected later via `QueryInferFn`; this spike never
 * calls a model.
 */
export const inferQueryFromTranscripts: QueryInferFn = (finals, partial) => {
  const last = (finals.length > 0 ? finals[finals.length - 1] : partial) ?? ''
  return normalizeText(last.replace(LEADING_FILLER, ''))
}

export function defaultQueryInfer(): QueryInferFn {
  return inferQueryFromTranscripts
}
