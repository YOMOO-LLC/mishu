import type {
  TextModelCompleteRequest,
  TextModelCompleteResult,
  TextModelPort
} from '@mishu/core/ports'
import { normalizeTenantId } from '@mishu/core/tenant'

import type { AnalysisBackend } from './types.js'

/**
 * Thin adapter: desktop Codex/mock analysis implements TextModelPort without
 * changing `AnalysisBackend.runExtraction` callers (T12.13 wires composition).
 *
 * Ignore semantics: `reasoning` is dropped (Codex threads have no per-request
 * effort). `model` on the request is ignored; the backend keeps its constructor
 * default. `usage` is omitted. `text.format.schema` is forwarded as the optional
 * extraction schema and is not enforced by the thread.
 */
export class AnalysisTextModelAdapter implements TextModelPort {
  constructor(private readonly backend: AnalysisBackend) {}

  async complete(request: TextModelCompleteRequest): Promise<TextModelCompleteResult> {
    normalizeTenantId(request.tenantId)
    throwIfAborted(request.signal)
    const prompt = serializeTextModelInput(request.input)
    const schema = request.text?.format.schema
    const extraction = this.backend.runExtraction(prompt, schema)
    const response = request.signal
      ? await Promise.race([extraction, whenAborted(request.signal)])
      : await extraction
    return { outputText: response.text }
  }
}

export function serializeTextModelInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (input == null) return ''
  if (typeof input === 'number' || typeof input === 'boolean') return String(input)
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return String(input)
  }
}

function abortedError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError()
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(abortedError())
    if (signal.aborted) {
      reject(abortedError())
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
