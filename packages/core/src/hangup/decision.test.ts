import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HANGUP_PLAYBACK_WAIT_MS,
  DEFAULT_HANGUP_SILENCE_MS,
  HANGUP_REASONING_EFFORT,
  buildHangupResponsesBody,
  callerOnlyHangupHeuristic,
  extractHangupOutputText,
  extractOpenAiErrorCode,
  formatElapsedMs,
  formatHangupDecidedLog,
  formatHangupEndCallFailedLog,
  formatHangupEndCallOkLog,
  formatHangupJudgeLog,
  formatHangupPlaybackWaitLog,
  formatHangupSkippedLog,
  formatHangupTurnsLog,
  hangupEndCallErrorCode,
  hangupVerdictFromParsed,
  mergeTurnText,
  neverHangupJudge,
  normalizeHangupTurns,
  reasonCategory
} from '@mishu/core/hangup'

describe('@mishu/core/hangup decision', () => {
  it('uses transcript-idle 900ms and end=true playback wait 500ms', () => {
    expect(DEFAULT_HANGUP_SILENCE_MS).toBe(900)
    expect(DEFAULT_HANGUP_PLAYBACK_WAIT_MS).toBe(500)
  })

  it('never hangs up when the judge is disabled', async () => {
    expect(await neverHangupJudge()([])).toEqual({ end: false, reason: 'disabled' })
    expect(await neverHangupJudge()([{ role: 'caller', text: 'goodbye' }])).toEqual({
      end: false,
      reason: 'disabled'
    })
  })

  it('fail-closes unless parsed end is the boolean true', () => {
    expect(hangupVerdictFromParsed({ end: true, reason: 'both_said_goodbye' })).toEqual({
      end: true,
      reason: 'both_said_goodbye'
    })
    expect(hangupVerdictFromParsed({ end: false, reason: 'waiting' })).toEqual({
      end: false,
      reason: 'waiting'
    })
    expect(hangupVerdictFromParsed({ reason: 'farewell' }).end).toBe(false)
    expect(hangupVerdictFromParsed({ end: 'true', reason: 'farewell' }).end).toBe(false)
    expect(hangupVerdictFromParsed({ end: 1, reason: 'farewell' }).end).toBe(false)
    expect(hangupVerdictFromParsed({ end: true }).reason).toBe('farewell')
    expect(hangupVerdictFromParsed({ end: false }).reason).toBe('not_done')
  })

  it('falls back to caller-only farewell text when there is no assistant transcript', () => {
    expect(callerOnlyHangupHeuristic([{ role: 'caller', text: '先挂了啊再见' }])).toEqual({
      end: true,
      reason: 'caller_farewell'
    })
    expect(callerOnlyHangupHeuristic([{ role: 'caller', text: '明天下午方便吗' }])).toEqual({
      end: false,
      reason: 'no_farewell'
    })
    expect(callerOnlyHangupHeuristic([{ role: 'assistant', text: '再见' }]).end).toBe(false)
    expect(callerOnlyHangupHeuristic([{ role: 'caller', text: 'bye' }]).end).toBe(true)
    expect(callerOnlyHangupHeuristic([{ role: 'caller', text: 'goodbye' }]).end).toBe(true)
  })

  it('merges adjacent same-role fragments into alternating arrival-order turns', () => {
    expect(mergeTurnText('Hello', 'world')).toBe('Hello world')
    expect(mergeTurnText('好的', '再见')).toBe('好的再见')
    expect(mergeTurnText('hi ', 'there')).toBe('hi there')
    expect(mergeTurnText('', 'only')).toBe('only')
    const turns = normalizeHangupTurns([
      { role: 'assistant', text: '您好' },
      { role: 'assistant', text: '我是秘书' },
      { role: 'caller', text: '明天' },
      { role: 'caller', text: '有空吗' },
      { role: 'assistant', text: '有空' },
      { role: 'caller', text: '再见' },
      { role: 'caller', text: '   ' }
    ])
    expect(turns.map((turn) => turn.role)).toEqual(['assistant', 'caller', 'assistant', 'caller'])
    expect(turns.map((turn) => turn.text)).toEqual(['您好我是秘书', '明天有空吗', '有空', '再见'])
    expect(formatHangupTurnsLog(turns)).toBe('hangup-judge: input roles=A,C,A,C chars=6,5,2,2')
    expect(formatHangupTurnsLog(turns)).not.toContain('再见')
  })

  it('keeps request-builder fields aligned with the live judge', () => {
    const turns = [
      { role: 'caller' as const, text: '好的，那就这样，再见。' },
      { role: 'assistant' as const, text: '好的，再见。' }
    ]
    const body = buildHangupResponsesBody('gpt-5.6-luna', turns)
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('max_completion_tokens')
    expect(body.reasoning).toEqual({ effort: HANGUP_REASONING_EFFORT })
    expect(body.reasoning).toEqual({ effort: 'none' })
    expect(extractHangupOutputText({ output_text: '{"end":false}' })).toBe('{"end":false}')
    expect(extractHangupOutputText({
      output: [{ content: [{ text: '{"end":true}' }] }]
    })).toBe('{"end":true}')
    expect(extractHangupOutputText(null)).toBe('')
    expect(extractOpenAiErrorCode('{"error":{"code":"unsupported_parameter"}}')).toBe('unsupported_parameter')
    expect(extractOpenAiErrorCode('not-json')).toBeUndefined()
  })

  it('formats hangup execution logs without transcript text', () => {
    expect(formatHangupDecidedLog()).toBe('hangup: decided')
    expect(formatHangupPlaybackWaitLog(12.4)).toBe('hangup: playback-wait ms=12')
    expect(formatHangupEndCallOkLog(3)).toBe('hangup: endCall ok ms=3')
    expect(formatHangupEndCallFailedLog('20404')).toBe('hangup: endCall failed code=20404')
    expect(formatHangupSkippedLog('no_call_sid')).toBe('hangup: skipped reason=no_call_sid')
    expect(formatHangupSkippedLog('no_rest')).toBe('hangup: skipped reason=no_rest')
    expect(hangupEndCallErrorCode({ code: 20404, status: 404 })).toBe('20404')
    expect(hangupEndCallErrorCode({ status: 500 })).toBe('http_500')
    expect(hangupEndCallErrorCode(new Error('end failed'))).toBe('end_failed')
    expect(formatHangupJudgeLog({
      end: false,
      reason: 'judge_http',
      ms: 12,
      status: 400,
      errorCode: 'unsupported_parameter'
    })).toBe('hangup-judge: end=false reason=judge_http ms=12 status=400 error.code=unsupported_parameter')
    expect(reasonCategory('both_said_goodbye')).toBe('both_said_goodbye')
    expect(reasonCategory('含对话')).toBe('other')
    expect(formatElapsedMs(Number.NaN)).toBe(0)
  })
})
