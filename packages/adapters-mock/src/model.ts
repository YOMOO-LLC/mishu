import type {
  TextModelCompleteRequest,
  TextModelCompleteResult,
  TextModelPort
} from '@mishu/core/ports'
import { requireTenantId } from './require-tenant.js'

/** Kept so the T12.14 stub suite still passes. */
export const ADAPTERS_MOCK_MODEL_TASK = 'T12.18'

export type MockTextModelMatch = (request: TextModelCompleteRequest) => boolean

export interface MockTextModelScript {
  match?: MockTextModelMatch
  outputText?: string
  output?: (request: TextModelCompleteRequest) => string | TextModelCompleteResult
  error?: Error
  hang?: boolean
}

export interface MockTextModelOptions {
  scripts?: MockTextModelScript[]
  defaultOutputText?: string
  error?: Error
  hang?: boolean
}

function rejectMaxTokens(request: object): void {
  if (Object.prototype.hasOwnProperty.call(request, 'max_tokens')) {
    throw new Error('max_tokens is not supported')
  }
  if (Object.prototype.hasOwnProperty.call(request, 'max_completion_tokens')) {
    throw new Error('max_completion_tokens is not supported')
  }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function hangUntilAborted(signal: AbortSignal | undefined): Promise<TextModelCompleteResult> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => {
      reject(abortError())
    }
    if (signal?.aborted) {
      fail()
      return
    }
    signal?.addEventListener('abort', fail, { once: true })
  })
}

/**
 * Deterministic TextModelPort. Scripts match on input; hang/throw cover
 * fail-closed callers. Completions never send max_tokens.
 */
export class MockTextModel implements TextModelPort {
  readonly requests: TextModelCompleteRequest[] = []
  readonly scripts: MockTextModelScript[]
  defaultOutputText: string
  error?: Error
  hang: boolean

  constructor(options: MockTextModelOptions = {}) {
    this.scripts = options.scripts ? [...options.scripts] : []
    this.defaultOutputText = options.defaultOutputText ?? '{"ok":true}'
    this.error = options.error
    this.hang = options.hang ?? false
  }

  script(entry: MockTextModelScript): void {
    this.scripts.push(entry)
  }

  async complete(request: TextModelCompleteRequest): Promise<TextModelCompleteResult> {
    requireTenantId(request.tenantId)
    rejectMaxTokens(request)
    this.requests.push(request)
    const script = this.scripts.find((entry) => (entry.match ? entry.match(request) : true))
    if (script?.hang || (!script && this.hang)) {
      return hangUntilAborted(request.signal)
    }
    const error = script?.error ?? (!script ? this.error : undefined)
    if (error) throw error
    if (script?.output) {
      const produced = script.output(request)
      return typeof produced === 'string' ? { outputText: produced } : produced
    }
    if (script?.outputText !== undefined) return { outputText: script.outputText }
    return { outputText: this.defaultOutputText }
  }
}
