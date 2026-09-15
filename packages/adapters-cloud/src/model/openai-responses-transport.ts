import type {
  TextModelCompleteResult,
  TextModelJsonSchemaFormat,
  TextModelPort,
  TextModelReasoningEffort
} from '@mishu/core/ports'
import { normalizeTenantId } from '@mishu/core/tenant'

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

export interface OpenAiResponsesTransportOptions {
  apiKey: string
  fetch?: typeof fetch
  url?: string
  defaultModel?: string
}

export interface OpenAiResponsesRequest {
  model: string
  input: unknown
  text?: { format: TextModelJsonSchemaFormat }
  reasoning?: { effort: string }
  signal?: AbortSignal
}

export interface OpenAiResponsesTransport {
  complete(request: OpenAiResponsesRequest): Promise<TextModelCompleteResult>
}

/**
 * Responses API client. Construct only after paid dual-confirm.
 * Usage fields `input_tokens` / `output_tokens` are from the Responses object
 * (https://developers.openai.com/api/docs/api-reference/responses/create , accessed 2026-09-12).
 * Never sends max_tokens / max_completion_tokens (T10.8).
 */
export function createOpenAiResponsesTransport(options: OpenAiResponsesTransportOptions): OpenAiResponsesTransport {
  const apiKey = options.apiKey
  const fetchImpl = options.fetch ?? fetch
  const url = options.url ?? OPENAI_RESPONSES_URL
  return {
    async complete(request: OpenAiResponsesRequest): Promise<TextModelCompleteResult> {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: request.model,
          input: request.input,
          text: request.text,
          ...(request.reasoning ? { reasoning: request.reasoning } : {})
        }),
        signal: request.signal,
        redirect: 'error'
      })
      const raw = await response.text()
      if (!response.ok) {
        throw new Error(`responses_http_${response.status}`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('responses_invalid_json')
      }
      return {
        outputText: extractOutputText(parsed),
        usage: extractUsage(parsed)
      }
    }
  }
}

/**
 * TextModelPort over Responses. tenantId is required by the port and is not
 * sent on the wire. reasoning.effort is forwarded only when present and is
 * limited to none | low | medium | high.
 */
export function createOpenAiTextModelPort(options: OpenAiResponsesTransportOptions): TextModelPort {
  const transport = createOpenAiResponsesTransport(options)
  return {
    async complete(request) {
      normalizeTenantId(request.tenantId)
      const model = request.model ?? options.defaultModel
      if (!model) throw new Error('model is required for the Responses adapter')
      const effort = request.reasoning?.effort
      if (effort !== undefined) assertPortEffort(effort)
      return transport.complete({
        model,
        input: request.input,
        ...(request.text ? { text: request.text } : {}),
        ...(request.reasoning ? { reasoning: request.reasoning } : {}),
        ...(request.signal ? { signal: request.signal } : {})
      })
    }
  }
}

const PORT_EFFORTS = new Set<TextModelReasoningEffort>(['none', 'low', 'medium', 'high'])

function assertPortEffort(effort: string): asserts effort is TextModelReasoningEffort {
  if (!PORT_EFFORTS.has(effort as TextModelReasoningEffort)) {
    throw new Error(`reasoning.effort must be none, low, medium, or high (got ${effort})`)
  }
}

export function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as {
    output_text?: unknown
    output?: unknown
  }
  if (typeof record.output_text === 'string' && record.output_text.length > 0) return record.output_text
  if (!Array.isArray(record.output)) return ''
  const chunks: string[] = []
  for (const item of record.output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text = (part as { text?: unknown; type?: unknown }).text
      if (typeof text === 'string') chunks.push(text)
    }
  }
  return chunks.join('')
}

export function extractUsage(payload: unknown): TextModelCompleteResult['usage'] {
  if (!payload || typeof payload !== 'object') return undefined
  const usage = (payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return undefined
  const inputTokens = (usage as { input_tokens?: unknown }).input_tokens
  const outputTokens = (usage as { output_tokens?: unknown }).output_tokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  return { inputTokens, outputTokens }
}
