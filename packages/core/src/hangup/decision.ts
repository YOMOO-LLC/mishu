import { CALLER_FAREWELL_PATTERN } from '../caller-input.js'
import type { HangupJudge, HangupVerdict, TranscriptTurn } from './types.js'
import {
  HANGUP_JSON_SCHEMA,
  HANGUP_REASONING_EFFORT,
  HANGUP_SCHEMA_NAME
} from './constants.js'

const SYSTEM_PROMPT =
  'You are a phone hang-up judge. Decide only from the transcript whether both parties have already said goodbye, or whether the caller has clearly asked to end the call. ' +
  'Do not end the call because of silence, waiting, or a lone "okay". reason must be a short English category (such as both_said_goodbye, caller_asked_to_end, waiting, not_done); never restate the conversation.'

export function mergeTurnText(left: string, right: string): string {
  if (!left) return right
  if (!right) return left
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right
  if (/[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)) return `${left} ${right}`
  return left + right
}

/** Arrival-order turns, adjacent same-role fragments merged so roles alternate. */
export function normalizeHangupTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = []
  for (const turn of turns) {
    const text = turn.text.trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && last.role === turn.role) last.text = mergeTurnText(last.text, text)
    else out.push({ role: turn.role, text })
  }
  return out
}

export function formatHangupTurnsLog(turns: readonly TranscriptTurn[]): string {
  const roles = turns.map((turn) => (turn.role === 'caller' ? 'C' : 'A')).join(',')
  const chars = turns.map((turn) => String(turn.text.length)).join(',')
  return `hangup-judge: input roles=${roles} chars=${chars}`
}

export function callerOnlyHangupHeuristic(turns: TranscriptTurn[]): HangupVerdict {
  const caller = turns.filter((turn) => turn.role === 'caller').map((turn) => turn.text).join('')
  if (CALLER_FAREWELL_PATTERN.test(caller)) {
    return { end: true, reason: 'caller_farewell' }
  }
  return { end: false, reason: 'no_farewell' }
}

export function neverHangupJudge(): HangupJudge {
  return async () => ({ end: false, reason: 'disabled' })
}

export function hangupTextFormat(): {
  format: {
    type: 'json_schema'
    name: string
    strict: boolean
    schema: Record<string, unknown>
  }
} {
  return {
    format: {
      type: 'json_schema',
      name: HANGUP_SCHEMA_NAME,
      strict: true,
      schema: HANGUP_JSON_SCHEMA
    }
  }
}

export function buildHangupResponsesBody(model: string, turns: TranscriptTurn[]): Record<string, unknown> {
  return {
    model,
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(turns.map((turn) => ({ role: turn.role, text: turn.text }))) }
    ],
    text: hangupTextFormat(),
    reasoning: { effort: HANGUP_REASONING_EFFORT }
  }
}

/** Safe token for serve logs: never dump transcript, keys, or numbers. */
export function reasonCategory(reason: string): string {
  const trimmed = reason.trim()
  if (/^[a-z][a-z0-9_]{0,47}$/i.test(trimmed)) return trimmed
  return 'other'
}

/**
 * Fail-closed: only a literal `end === true` hangs up. Missing, false, or
 * non-boolean `end` values never end the call.
 */
export function hangupVerdictFromParsed(parsed: { end?: unknown; reason?: unknown }): HangupVerdict {
  const reason = typeof parsed.reason === 'string' ? reasonCategory(parsed.reason) : undefined
  if (parsed.end === true) {
    return { end: true, reason: reason ?? 'farewell' }
  }
  return { end: false, reason: reason ?? 'not_done' }
}

export function formatHangupJudgeLog(input: {
  end: boolean
  reason: string
  ms: number
  status?: number
  errorCode?: string
}): string {
  const ms = Number.isFinite(input.ms) ? Math.max(0, Math.round(input.ms)) : 0
  let line = `hangup-judge: end=${input.end} reason=${reasonCategory(input.reason)} ms=${ms}`
  if (input.status !== undefined) line += ` status=${input.status}`
  if (input.errorCode) line += ` error.code=${input.errorCode}`
  return line
}

export function formatElapsedMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
}

/** Twilio RestException uses numeric `code`; fall back to a short category. */
export function hangupEndCallErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; status?: unknown }
    const code = record.code
    if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code < 1_000_000) {
      return String(code)
    }
    if (typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(code)) return code
    const status = record.status
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) {
      return `http_${status}`
    }
  }
  if (error instanceof Error) {
    const name = error.name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 48)
    if (name && name !== 'Error') return name
  }
  return 'end_failed'
}

export function formatHangupDecidedLog(): string {
  return 'hangup: decided'
}

export function formatHangupPlaybackWaitLog(ms: number): string {
  return `hangup: playback-wait ms=${formatElapsedMs(ms)}`
}

export function formatHangupEndCallOkLog(ms: number): string {
  return `hangup: endCall ok ms=${formatElapsedMs(ms)}`
}

export function formatHangupEndCallFailedLog(code: string): string {
  const safe = /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : 'end_failed'
  return `hangup: endCall failed code=${safe}`
}

export function formatHangupSkippedLog(reason: 'no_call_sid' | 'no_rest'): string {
  return `hangup: skipped reason=${reason}`
}

export function extractHangupOutputText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as { output_text?: unknown; output?: unknown }
  if (typeof record.output_text === 'string' && record.output_text.length > 0) return record.output_text
  if (!Array.isArray(record.output)) return ''
  const chunks: string[] = []
  for (const item of record.output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') chunks.push(text)
    }
  }
  return chunks.join('')
}

export function extractOpenAiErrorCode(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown } }
    const code = parsed.error?.code
    if (typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(code)) return code
  } catch {
    return undefined
  }
  return undefined
}
