/**
 * Conservative product token estimator. This is not a vendor tokenizer.
 *
 * Method (documented for S2 payload bound):
 * - Each CJK (Han / Hiragana / Katakana / Hangul) character counts as 1 token.
 * - Remaining non-whitespace runs count as ceil(charCount / 2) tokens
 *   (stricter than the common ~4 Latin chars/token rule).
 * - Each contiguous whitespace-or-punctuation gap counts as 1 token.
 *
 * Overestimate on purpose so a 500-token append stays inside the official
 * per-append limit even if a real tokenizer is denser on mixed Chinese.
 */
import { CUT_MARKERS } from '../caller-input.js'

const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/u
const GAP_RE = /[\s\p{P}\p{S}]+/u

export function estimateTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  let latinRun = 0
  let inGap = false
  for (const char of text) {
    if (CJK_RE.test(char)) {
      if (latinRun > 0) {
        tokens += Math.ceil(latinRun / 2)
        latinRun = 0
      }
      inGap = false
      tokens += 1
      continue
    }
    if (GAP_RE.test(char)) {
      if (latinRun > 0) {
        tokens += Math.ceil(latinRun / 2)
        latinRun = 0
      }
      if (!inGap) {
        tokens += 1
        inGap = true
      }
      continue
    }
    inGap = false
    latinRun += 1
  }
  if (latinRun > 0) tokens += Math.ceil(latinRun / 2)
  return tokens
}

export const APPEND_TOKEN_LIMIT = 500
export const INSTRUCTIONS_TOKEN_BUDGET = 1500

export function truncateToTokenBudget(text: string, limit: number): { text: string; truncated: boolean; tokens: number } {
  const original = estimateTokens(text)
  if (original <= limit) return { text, truncated: false, tokens: original }
  let lo = 0
  let hi = text.length
  let best = ''
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const slice = text.slice(0, mid)
    if (estimateTokens(slice) <= limit) {
      best = slice
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  let cut = best
  const windowStart = Math.max(0, cut.length - 80)
  let markerAt = -1
  for (const marker of CUT_MARKERS) {
    const idx = cut.lastIndexOf(marker, cut.length - 1)
    if (idx >= windowStart && idx > markerAt) markerAt = idx
  }
  if (markerAt >= 0) cut = cut.slice(0, markerAt + 1)
  cut = `${cut.trimEnd()}\n[truncated to ${limit}-token safety bound]`
  // If the footer itself overflows, drop it and hard-cut.
  if (estimateTokens(cut) > limit) {
    cut = best.trimEnd()
    while (cut.length > 0 && estimateTokens(cut) > limit) cut = cut.slice(0, -1)
  }
  return { text: cut, truncated: true, tokens: estimateTokens(cut) }
}
