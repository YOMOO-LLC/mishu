import {
  DEFAULT_HANGUP_MODEL,
  DEFAULT_HANGUP_TIMEOUT_MS,
  buildHangupResponsesBody,
  extractHangupOutputText,
  extractOpenAiErrorCode,
  formatHangupJudgeLog,
  hangupVerdictFromParsed,
  type HangupJudge,
  type HangupVerdict
} from '@mishu/core/hangup'
import { OPENAI_RESPONSES_URL } from './openai-responses-transport.js'

export function resolveHangupModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIVE_PHONE_HANGUP_MODEL?.trim() || DEFAULT_HANGUP_MODEL
}

/**
 * Direct Responses hangup judge. Fail-closed: HTTP errors, timeouts, empty
 * bodies, and non-boolean `end` never hang up.
 */
export function openAiHangupJudge(options: {
  apiKey: string
  model?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  log?: (line: string) => void
  now?: () => number
}): HangupJudge {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANGUP_TIMEOUT_MS
  const model = options.model ?? DEFAULT_HANGUP_MODEL
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? ((line: string) => { console.log(line) })
  const now = options.now ?? (() => Date.now())
  return async (turns) => {
    const started = now()
    const finish = (verdict: HangupVerdict, extra?: { status?: number; errorCode?: string }): HangupVerdict => {
      log(formatHangupJudgeLog({
        end: verdict.end,
        reason: verdict.reason,
        ms: now() - started,
        status: extra?.status,
        errorCode: extra?.errorCode
      }))
      return verdict
    }
    if (turns.length === 0) return finish({ end: false, reason: 'empty' })
    try {
      const body = buildHangupResponsesBody(model, turns)
      const response = await fetchImpl(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error'
      })
      const raw = await response.text()
      if (!response.ok) {
        return finish(
          { end: false, reason: 'judge_http' },
          { status: response.status, errorCode: extractOpenAiErrorCode(raw) }
        )
      }
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        return finish({ end: false, reason: 'judge_empty' })
      }
      const content = extractHangupOutputText(payload)
      if (!content) return finish({ end: false, reason: 'judge_empty' })
      let parsed: { end?: unknown; reason?: unknown }
      try {
        parsed = JSON.parse(content) as { end?: unknown; reason?: unknown }
      } catch {
        return finish({ end: false, reason: 'judge_failed' })
      }
      return finish(hangupVerdictFromParsed(parsed))
    } catch {
      return finish({ end: false, reason: 'judge_failed' })
    }
  }
}
