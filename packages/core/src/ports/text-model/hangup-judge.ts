import { systemClock, type Clock } from '../../clock.js'
import { normalizeTenantId } from '../../tenant.js'
import {
  DEFAULT_HANGUP_MODEL,
  DEFAULT_HANGUP_TIMEOUT_MS,
  HANGUP_REASONING_EFFORT,
  buildHangupResponsesBody,
  formatHangupJudgeLog,
  hangupTextFormat,
  hangupVerdictFromParsed,
  type HangupJudge,
  type HangupVerdict
} from '../../hangup.js'
import type { TextModelPort } from '../text-model.js'

export interface TextModelHangupJudgeOptions {
  port: TextModelPort
  tenantId: string
  model?: string
  timeoutMs?: number
  clock?: Clock
  log?: (line: string) => void
}

/**
 * Hangup judge over TextModelPort. Fail-closed: a port error, abort, empty
 * body, or non-boolean `end` never hangs up.
 */
export function createTextModelHangupJudge(options: TextModelHangupJudgeOptions): HangupJudge {
  const tenantId = normalizeTenantId(options.tenantId)
  const model = options.model ?? DEFAULT_HANGUP_MODEL
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANGUP_TIMEOUT_MS
  const clock = options.clock ?? systemClock
  const log = options.log
  return async (turns) => {
    const started = clock.now()
    const finish = (verdict: HangupVerdict, extra?: { errorCode?: string }): HangupVerdict => {
      log?.(formatHangupJudgeLog({
        end: verdict.end,
        reason: verdict.reason,
        ms: clock.now() - started,
        ...(extra?.errorCode ? { errorCode: extra.errorCode } : {})
      }))
      return verdict
    }
    if (turns.length === 0) return finish({ end: false, reason: 'empty' })
    const controller = new AbortController()
    const timeoutId = clock.setTimeout(() => controller.abort(), timeoutMs)
    try {
      const body = buildHangupResponsesBody(model, turns)
      const result = await options.port.complete({
        tenantId,
        model,
        input: body.input,
        text: hangupTextFormat(),
        reasoning: { effort: HANGUP_REASONING_EFFORT },
        signal: controller.signal
      })
      const content = result.outputText.trim()
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
    } finally {
      clock.clearTimeout(timeoutId)
    }
  }
}
