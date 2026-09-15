import { BACKCHANNEL_TOKENS } from './constants.js'
import type { TranscriptInterruptDecision } from './types.js'

const BACKCHANNEL_SET = new Set<string>(BACKCHANNEL_TOKENS)
const BACKCHANNEL_PREFIXES = [...BACKCHANNEL_TOKENS].sort((a, b) => b.length - a.length)

export function stripInterruptPunctuation(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function classifyTranscriptInterrupt(text: string): TranscriptInterruptDecision {
  const stripped = stripInterruptPunctuation(text)
  const compact = stripped.replace(/\s+/g, '').toLowerCase()
  const chars = compact.length
  if (!meetsMinLength(stripped, compact)) {
    return { action: 'filter', reason: 'too_short', chars }
  }
  if (isBackchannelOnly(stripped, compact)) {
    return { action: 'filter', reason: 'backchannel', chars }
  }
  return { action: 'fire', reason: 'speech', chars }
}

export function formatInterruptLog(action: 'fired' | 'filtered', reason: string, chars: number): string {
  const safeReason = /^[a-z][a-z0-9_]{0,47}$/i.test(reason) ? reason : 'other'
  const n = Number.isFinite(chars) ? Math.max(0, Math.round(chars)) : 0
  return `interrupt: ${action} reason=${safeReason} chars=${n}`
}

function meetsMinLength(stripped: string, compact: string): boolean {
  const han = (compact.match(/\p{Script=Han}/gu) ?? []).length
  const latinWords = stripped
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => /^[a-z]+(?:'[a-z]+)?$/.test(word)).length
  return han >= 2 || latinWords >= 2
}

function isBackchannelOnly(stripped: string, compact: string): boolean {
  if (compact.length === 0) return true
  const words = stripped.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length > 0 && words.every((word) => BACKCHANNEL_SET.has(word.replace(/-/g, '')))) {
    return true
  }
  let rest = compact
  while (rest.length > 0) {
    const hit = BACKCHANNEL_PREFIXES.find((token) => rest.startsWith(token))
    if (!hit) return false
    rest = rest.slice(hit.length)
  }
  return true
}
