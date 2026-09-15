import { STOPWORDS } from '../caller-input.js'

const FULLWIDTH_OFFSET = 0xfee0

/**
 * Normalize for lexical retrieval:
 * - fullwidth ASCII → halfwidth
 * - Unicode case fold (toLocaleLowerCase('en'))
 * - collapse whitespace
 * Explicitly does **not** convert between simplified and traditional Chinese.
 */
export function normalizeText(input: string): string {
  let out = ''
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - FULLWIDTH_OFFSET)
      continue
    }
    if (code === 0x3000) {
      out += ' '
      continue
    }
    out += char
  }
  return out.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim()
}

const CJK_CHAR = /[\u3400-\u9fff]/u
const LATIN_WORD = /[a-z0-9]+/g

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token)
}

export function chineseBigrams(text: string): string[] {
  const chars: string[] = []
  for (const char of text) {
    if (CJK_CHAR.test(char)) chars.push(char)
  }
  if (chars.length === 0) return []
  if (chars.length === 1) return chars
  const grams: string[] = []
  for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars[i]! + chars[i + 1]!)
  return grams
}

export function englishWords(text: string): string[] {
  return text.match(LATIN_WORD) ?? []
}

export interface LexicalTokens {
  bigrams: string[]
  words: string[]
  aliases: string[]
  contentNormalized: string
}

export function tokenize(text: string): LexicalTokens {
  const contentNormalized = normalizeText(text)
  return {
    bigrams: chineseBigrams(contentNormalized),
    words: englishWords(contentNormalized).filter((word) => !STOPWORDS.has(word) && word.length > 1),
    aliases: [],
    contentNormalized
  }
}

function isWeakGram(gram: string): boolean {
  if (STOPWORDS.has(gram)) return true
  const chars = [...gram]
  return chars.length > 0 && chars.every((ch) => STOPWORDS.has(ch))
}

export function significantQueryTokens(query: string): { bigrams: string[]; words: string[]; raw: string } {
  const raw = normalizeText(query)
  const bigrams = chineseBigrams(raw).filter((gram) => !isWeakGram(gram))
  const words = englishWords(raw).filter((word) => !STOPWORDS.has(word) && word.length > 1)
  return { bigrams, words, raw }
}
