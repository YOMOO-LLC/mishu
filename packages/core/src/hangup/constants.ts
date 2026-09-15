export const DEFAULT_HANGUP_MODEL = 'gpt-5.6-luna'
export const DEFAULT_HANGUP_TIMEOUT_MS = 2_500
/** Conservative per-call estimate so GPT-Live + judge stay under the spike USD cap. */
export const HANGUP_JUDGE_USD_ESTIMATE = 0.002
/** T9.7: gpt-5.6-luna accepts `none`, rejects `minimal`. */
export const HANGUP_REASONING_EFFORT = 'none' as const
export const HANGUP_SCHEMA_NAME = 'hangup_verdict'

export const HANGUP_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    end: { type: 'boolean' },
    reason: { type: 'string' }
  },
  required: ['end', 'reason'],
  additionalProperties: false
}

/** Transcript idle before a hangup check. Audio deltas must not reset this. */
export const DEFAULT_HANGUP_SILENCE_MS = 900
/** Max wait after end=true before endCall. pcm24k silence never drains the queue. */
export const DEFAULT_HANGUP_PLAYBACK_WAIT_MS = 500

export { BACKCHANNEL_TOKENS } from '../caller-input.js'
