/**
 * One-shot structured completion. Desktop Codex analysis and cloud OpenAI
 * Responses both satisfy this port; adapters map host differences.
 *
 * This is not an agent loop. The in-call copilot (`src/main/copilot/**`) is a
 * Codex thread with dynamic tools and `item/tool/call`. It has no cloud second
 * implementation, so under the rule of two it stays in the app and is not
 * expressed here.
 *
 * Host ignore semantics (never a vendor union):
 * - `tenantId` is required on every call. Adapters must not infer it from the
 *   process or a window.
 * - `model` may be omitted; the adapter uses its configured default.
 * - `reasoning` is optional. Codex threads have no per-request reasoning and
 *   MUST ignore it. Responses hosts send it when present and omit it otherwise.
 * - `text.format` is optional. Codex does not enforce json_schema; it still
 *   returns `outputText` and the caller validates. Responses sends `text.format`.
 * - `usage` is omitted when the host does not report token counts (Codex).
 * - Never send `max_tokens` or `max_completion_tokens` (Responses returns 400
 *   on the models we use; T10.8).
 * - `reasoning.effort` is only `none | low | medium | high`. `minimal` returns
 *   400 on gpt-5.6-luna (T9.7 / S2).
 */

export const TEXT_MODEL_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const
export type TextModelReasoningEffort = (typeof TEXT_MODEL_REASONING_EFFORTS)[number]

export interface TextModelJsonSchemaFormat {
  type: 'json_schema'
  name: string
  strict: boolean
  schema: Record<string, unknown>
}

export interface TextModelCompleteRequest {
  tenantId: string
  model?: string
  input: unknown
  text?: { format: TextModelJsonSchemaFormat }
  reasoning?: { effort: TextModelReasoningEffort }
  signal?: AbortSignal
}

export interface TextModelUsage {
  inputTokens: number
  outputTokens: number
}

export interface TextModelCompleteResult {
  outputText: string
  usage?: TextModelUsage
}

export interface TextModelPort {
  complete(request: TextModelCompleteRequest): Promise<TextModelCompleteResult>
}

export {
  createTextModelHangupJudge,
  type TextModelHangupJudgeOptions
} from './text-model/hangup-judge.js'
