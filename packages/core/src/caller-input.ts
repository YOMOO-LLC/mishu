/**
 * Caller- and retrieved-text lexicons for untrusted input matching.
 * Every CJK term here matches what a caller may say or what retrieved text may
 * contain. None of these strings are shown in the UI or sent as instructions.
 */

/** Matches backchannel / filler tokens a caller may say in Chinese or English. Never shown to users or sent as instructions. */
export const BACKCHANNEL_TOKENS = ['嗯', '啊', '哦', '呃', '唔', '唉', '嘿', '对', '好', '是', '行', '嗯嗯', '好的', '对对', '是的', '对的', '行行', 'ok', 'okay', 'yeah', 'yep', 'yup', 'uhhuh', 'huh', 'uh', 'mm', 'mhm', 'hmm'] as const

/** Matches farewell / hang-up phrases a caller may say in Chinese or English. Never shown to users or sent as instructions. */
export const CALLER_FAREWELL_PATTERN = /再见|拜拜|挂了|不用了|先挂|goodbye|\bbye\b/i

/** Matches leading filler a caller may say in Chinese or English before the real query. Never shown to users or sent as instructions. */
export const LEADING_FILLER = /^(嗯|那个|请问|你好|喂|哈喽|hello|hi)[，,。.\s]*/i

/** Matches caller- or retrieved-text function words in Chinese and English. Never shown to users or sent as instructions. */
export const STOPWORDS = new Set(['的', '了', '吗', '呢', '啊', '吧', '嘛', '嗯', '哦', '哈', '呀', '是', '有', '在', '和', '与', '或', '也', '都', '就', '还', '很', '你', '我', '他', '她', '它', '您', '你们', '我们', '他们', '这', '那', '什么', '怎么', '哪', '哪个', '哪些', '请问', '一下', '一下下', '告诉', '说说', '问', '想', '知道', '能否', '可以', 'the', 'a', 'an', 'is', 'are', 'am', 'was', 'were', 'be', 'to', 'of', 'and', 'or', 'on', 'in', 'for', 'at', 'what', 'when', 'where', 'who', 'how', 'your', 'you', 'me', 'please', 'tell', 'do', 'does'])

/** Matches prompt-injection attempts in retrieved or caller text in Chinese or English. Never shown to users or sent as instructions. */
export const INJECTION_PATTERNS = [/忽略以上规则[^。\n]*/g, /忽略之前的(?:所有)?(?:规则|指令)[^。\n]*/g, /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?[^. \n]*/gi, /disregard\s+(all\s+)?(previous|above)\s+instructions?[^. \n]*/gi, /you\s+are\s+now[^。.\n]*/gi, /system\s*prompt\s*override[^。.\n]*/gi]

/** Matches CJK and ASCII sentence punctuation in caller or retrieved text when truncating to a token budget. Never shown to users or sent as instructions. */
export const CUT_MARKERS = ['。', '！', '？', '\n', '.', '!', '?', '；', ';']

/** Wrong-number phrases a caller may say in Chinese or English. Never shown to users or sent as instructions. */
export const WRONG_NUMBER_PATTERN = /wrong number|打错|拨错|不是本人/i

/** Voicemail or answering-machine phrases a caller or recording may say in Chinese or English. Never shown to users or sent as instructions. */
export const VOICEMAIL_PATTERN = /voicemail|语音信箱|留言/i

/** Refusal / do-not-call phrases a caller may say in Chinese. Never shown to users or sent as instructions. */
export const REFUSAL_PATTERN = /不需要|没兴趣|不要再打|拒绝/i

/** Punctuation-only fragments, including CJK punctuation from multilingual speech. Never shown to users or sent as instructions. */
export const PUNCTUATION_ONLY_PATTERN = /^[\s.,!?;:'"()[\]{}，。！？；：、…—~～·•]+$/u
