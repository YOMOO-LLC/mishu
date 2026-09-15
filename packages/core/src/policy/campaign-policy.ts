export type PolicyDirection = 'inbound' | 'outbound'

export type CopilotToolRisk = 'read' | 'draft-write' | 'external-write'

export interface CampaignCopilotPolicy {
  enabled: boolean
  mode: 'transcript' | 'delegation'
  prompt: string
  allowedToolIds: string[]
  autoExecuteRisks: Array<Exclude<CopilotToolRisk, 'external-write'>>
  maxToolCallsPerTurn: number
  mayEndCall: boolean
}

export interface CallingWindow {
  days: number[]
  start: string
  end: string
}

export interface CallingHours {
  timeZone: string
  windows: CallingWindow[]
}

export interface CampaignPolicy {
  persona: string
  allowedTopics: string[]
  forbiddenTopics: string[]
  forbiddenClaims: string[]
  negativePrompt: string
  opening?: string
  openingInbound?: string
  openingOutbound?: string
  recordingDisclosure: boolean
  maxCallDurationSec: number
  callingHours: CallingHours
  doNotCall: string[]
  blockedCallers: string[]
  onForbiddenClaim?: 'report' | 'handoff'
  copilot?: CampaignCopilotPolicy
}

export interface CampaignPolicyNormalizationOptions {
  onWarning?: (message: string) => void
}

export const DEFAULT_COPILOT_POLICY: CampaignCopilotPolicy = {
  enabled: false,
  mode: 'transcript',
  prompt: '',
  allowedToolIds: [],
  autoExecuteRisks: ['read'],
  maxToolCallsPerTurn: 3,
  mayEndCall: true
}

export const MAX_CALL_DURATION_SEC = 600
export const MIN_CALL_DURATION_SEC = 30
export const MAX_CALL_DURATION_BOUND_SEC = 3600

const MAX_PERSONA_LENGTH = 8_000
const MAX_CLAIM_LENGTH = 200
const MAX_LIST_LENGTH = 100
const MAX_NEGATIVE_PROMPT_LENGTH = 4_000
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const E164_PATTERN = /^\+[1-9]\d{6,14}$/

export const DEFAULT_CAMPAIGN_POLICY: CampaignPolicy = {
  persona: '',
  allowedTopics: [],
  forbiddenTopics: [],
  forbiddenClaims: [],
  negativePrompt: '',
  recordingDisclosure: true,
  maxCallDurationSec: MAX_CALL_DURATION_SEC,
  callingHours: { timeZone: 'UTC', windows: [] },
  doNotCall: [],
  blockedCallers: [],
  onForbiddenClaim: 'report',
  copilot: {
    ...DEFAULT_COPILOT_POLICY,
    allowedToolIds: [],
    autoExecuteRisks: [...DEFAULT_COPILOT_POLICY.autoExecuteRisks]
  }
}

export function policyFromLegacyPrompt(systemPrompt: string): CampaignPolicy {
  const persona = typeof systemPrompt === 'string' ? systemPrompt.trim() : ''
  return {
    ...DEFAULT_CAMPAIGN_POLICY,
    persona: persona || DEFAULT_CAMPAIGN_POLICY.persona
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeOptionalString(
  value: unknown,
  label: string,
  maxLength: number,
  options: CampaignPolicyNormalizationOptions
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    warnPolicyField(options, label, 'must be a string; using the default')
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    warnPolicyField(options, label, `cannot exceed ${maxLength} characters; truncated`)
    return trimmed.slice(0, maxLength)
  }
  return trimmed
}

function normalizeStringList(
  value: unknown,
  label: string,
  maxLength: number,
  options: CampaignPolicyNormalizationOptions
): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnPolicyField(options, label, 'must be an array of strings; using the default')
    return []
  }
  if (value.length > MAX_LIST_LENGTH) {
    warnPolicyField(options, label, `cannot exceed ${MAX_LIST_LENGTH} items; truncated`)
  }
  const out: string[] = []
  for (const [index, item] of value.slice(0, MAX_LIST_LENGTH).entries()) {
    if (typeof item !== 'string') {
      warnPolicyField(options, `${label}[${index}]`, 'must be a string; ignored')
      continue
    }
    const trimmed = item.trim()
    if (!trimmed) continue
    if (trimmed.length > maxLength) {
      warnPolicyField(options, `${label}[${index}]`, `cannot exceed ${maxLength} characters; truncated`)
      out.push(trimmed.slice(0, maxLength))
      continue
    }
    out.push(trimmed)
  }
  return out
}

function normalizePhoneList(
  value: unknown,
  label: string,
  options: CampaignPolicyNormalizationOptions
): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnPolicyField(options, label, 'must be an array of strings; using the default')
    return []
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      warnPolicyField(options, `${label}[${index}]`, 'must be a string; ignored')
      continue
    }
    const normalized = item.replace(/[\s().-]/g, '')
    if (!E164_PATTERN.test(normalized)) {
      warnPolicyField(options, `${label}[${index}]`, 'is not a valid E.164 number; ignored')
      continue
    }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      out.push(normalized)
    }
  }
  return out
}

const MAX_COPILOT_PROMPT_LENGTH = 8_000
const MIN_TOOL_CALLS_PER_TURN = 1
const MAX_TOOL_CALLS_PER_TURN = 10

function normalizeCopilot(
  value: unknown,
  options: CampaignPolicyNormalizationOptions
): CampaignCopilotPolicy {
  const base: CampaignCopilotPolicy = {
    ...DEFAULT_COPILOT_POLICY,
    allowedToolIds: [],
    autoExecuteRisks: [...DEFAULT_COPILOT_POLICY.autoExecuteRisks]
  }
  if (value === undefined || value === null) return base
  if (!isPlainObject(value)) {
    warnPolicyField(options, 'copilot', 'must be an object; using the default')
    return base
  }

  let enabled = false
  if (value.enabled !== undefined) {
    if (typeof value.enabled === 'boolean') enabled = value.enabled
    else warnPolicyField(options, 'copilot.enabled', 'must be a boolean; using default false')
  }
  let mode: CampaignCopilotPolicy['mode'] = 'transcript'
  if (value.mode === 'transcript' || value.mode === 'delegation') mode = value.mode
  else if (value.mode !== undefined) {
    warnPolicyField(options, 'copilot.mode', 'must be transcript or delegation; using default transcript')
  }

  const prompt = normalizeOptionalString(
    value.prompt,
    'copilot.prompt',
    MAX_COPILOT_PROMPT_LENGTH,
    options
  ) ?? ''

  const allowedToolIds = normalizeStringList(
    value.allowedToolIds,
    'copilot.allowedToolIds',
    200,
    options
  )

  const autoExecuteRisks: CampaignCopilotPolicy['autoExecuteRisks'] = []
  if (value.autoExecuteRisks !== undefined && value.autoExecuteRisks !== null) {
    if (!Array.isArray(value.autoExecuteRisks)) {
      warnPolicyField(options, 'copilot.autoExecuteRisks', 'must be an array; using the default')
      autoExecuteRisks.push(...DEFAULT_COPILOT_POLICY.autoExecuteRisks)
    } else {
      for (const [index, item] of value.autoExecuteRisks.entries()) {
        if (item === 'read' || item === 'draft-write') autoExecuteRisks.push(item)
        else warnPolicyField(options, `copilot.autoExecuteRisks[${index}]`, 'risk value is invalid; ignored')
      }
    }
  } else {
    autoExecuteRisks.push('read')
  }

  let maxToolCallsPerTurn = DEFAULT_COPILOT_POLICY.maxToolCallsPerTurn
  if (value.maxToolCallsPerTurn !== undefined && value.maxToolCallsPerTurn !== null) {
    const raw = value.maxToolCallsPerTurn
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      warnPolicyField(
        options,
        'copilot.maxToolCallsPerTurn',
        `must be an integer; using default ${DEFAULT_COPILOT_POLICY.maxToolCallsPerTurn}`
      )
    } else {
      maxToolCallsPerTurn = Math.min(
        MAX_TOOL_CALLS_PER_TURN,
        Math.max(MIN_TOOL_CALLS_PER_TURN, raw)
      )
      if (maxToolCallsPerTurn !== raw) {
        warnPolicyField(
          options,
          'copilot.maxToolCallsPerTurn',
          `must be between ${MIN_TOOL_CALLS_PER_TURN} and ${MAX_TOOL_CALLS_PER_TURN}; clamped to ${maxToolCallsPerTurn}`
        )
      }
    }
  }

  let mayEndCall = DEFAULT_COPILOT_POLICY.mayEndCall
  if (value.mayEndCall !== undefined) {
    if (typeof value.mayEndCall === 'boolean') mayEndCall = value.mayEndCall
    else warnPolicyField(options, 'copilot.mayEndCall', 'must be a boolean; using default true')
  }

  return {
    enabled,
    mode,
    prompt: prompt.trim(),
    allowedToolIds,
    autoExecuteRisks,
    maxToolCallsPerTurn,
    mayEndCall
  }
}

function warnPolicyField(
  options: CampaignPolicyNormalizationOptions,
  field: string,
  message: string
): void {
  const warning = `Campaign policy field ${field} is invalid: ${message}`
  if (options.onWarning) options.onWarning(warning)
  else console.warn(warning)
}

function normalizeCallingHours(
  value: unknown,
  options: CampaignPolicyNormalizationOptions
): CallingHours {
  if (value === undefined || value === null) return { timeZone: 'UTC', windows: [] }
  if (!isPlainObject(value)) {
    warnPolicyField(options, 'callingHours', 'must be an object; using the default')
    return { timeZone: 'UTC', windows: [] }
  }
  const rawZone = value.timeZone
  let timeZone = 'UTC'
  if (typeof rawZone === 'string' && rawZone.trim()) {
    const candidate = rawZone.trim()
    try {
      void new Intl.DateTimeFormat('en-US', { timeZone: candidate })
      timeZone = candidate
    } catch {
      warnPolicyField(options, 'callingHours.timeZone', 'time zone is invalid; using default UTC')
    }
  } else if (rawZone !== undefined) {
    warnPolicyField(options, 'callingHours.timeZone', 'cannot be empty; using default UTC')
  }
  const rawWindows = value.windows
  if (rawWindows === undefined || rawWindows === null) return { timeZone, windows: [] }
  if (!Array.isArray(rawWindows)) {
    warnPolicyField(options, 'callingHours.windows', 'must be an array; using the default')
    return { timeZone, windows: [] }
  }
  const windows: CallingWindow[] = []
  for (const [index, w] of rawWindows.entries()) {
    const label = `callingHours.windows[${index}]`
    if (!isPlainObject(w)) {
      warnPolicyField(options, label, 'must be an object; ignored')
      continue
    }
    const days = w.days
    if (!Array.isArray(days) || days.length === 0 || days.some(
      (day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6
    )) {
      warnPolicyField(options, `${label}.days`, 'must be a non-empty array of integers 0-6; window ignored')
      continue
    }
    if (typeof w.start !== 'string' || !TIME_PATTERN.test(w.start)) {
      warnPolicyField(options, `${label}.start`, 'time is invalid; window ignored')
      continue
    }
    if (typeof w.end !== 'string' || !TIME_PATTERN.test(w.end)) {
      warnPolicyField(options, `${label}.end`, 'time is invalid; window ignored')
      continue
    }
    windows.push({ days: [...days] as number[], start: w.start, end: w.end })
  }
  return { timeZone, windows }
}

export function normalizeCampaignPolicy(
  input: unknown,
  options: CampaignPolicyNormalizationOptions = {}
): CampaignPolicy {
  if (!isPlainObject(input)) throw new Error('Campaign policy config is invalid')

  const persona = normalizeOptionalString(input.persona, 'persona', MAX_PERSONA_LENGTH, options) ?? ''
  const negativePrompt = normalizeOptionalString(
    input.negativePrompt,
    'negativePrompt',
    MAX_NEGATIVE_PROMPT_LENGTH,
    options
  ) ?? ''

  const allowedTopics = normalizeStringList(input.allowedTopics, 'allowedTopics', MAX_CLAIM_LENGTH, options)
  const forbiddenTopics = normalizeStringList(input.forbiddenTopics, 'forbiddenTopics', MAX_CLAIM_LENGTH, options)
  const forbiddenClaims = normalizeStringList(input.forbiddenClaims, 'forbiddenClaims', MAX_CLAIM_LENGTH, options)

  const opening = normalizeOptionalString(input.opening, 'opening', MAX_NEGATIVE_PROMPT_LENGTH, options)
  const openingInbound = normalizeOptionalString(input.openingInbound, 'openingInbound', MAX_NEGATIVE_PROMPT_LENGTH, options)
  const openingOutbound = normalizeOptionalString(input.openingOutbound, 'openingOutbound', MAX_NEGATIVE_PROMPT_LENGTH, options)

  let recordingDisclosure = true
  if (input.recordingDisclosure !== undefined) {
    if (typeof input.recordingDisclosure === 'boolean') recordingDisclosure = input.recordingDisclosure
    else warnPolicyField(options, 'recordingDisclosure', 'must be a boolean; using default true')
  }

  let maxCallDurationSec = MAX_CALL_DURATION_SEC
  if (input.maxCallDurationSec !== undefined && input.maxCallDurationSec !== null) {
    const raw = input.maxCallDurationSec
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      warnPolicyField(options, 'maxCallDurationSec', `must be an integer number of seconds; using default ${MAX_CALL_DURATION_SEC}`)
    } else {
      maxCallDurationSec = Math.min(
        MAX_CALL_DURATION_BOUND_SEC,
        Math.max(MIN_CALL_DURATION_SEC, raw)
      )
      if (maxCallDurationSec !== raw) {
        warnPolicyField(
          options,
          'maxCallDurationSec',
          `must be between ${MIN_CALL_DURATION_SEC} and ${MAX_CALL_DURATION_BOUND_SEC}; clamped to ${maxCallDurationSec}`
        )
      }
    }
  }

  const callingHours = normalizeCallingHours(input.callingHours, options)
  const doNotCall = normalizePhoneList(input.doNotCall, 'doNotCall', options)
  const blockedCallers = normalizePhoneList(input.blockedCallers, 'blockedCallers', options)
  let onForbiddenClaim: CampaignPolicy['onForbiddenClaim'] = 'report'
  if (input.onForbiddenClaim === 'handoff' || input.onForbiddenClaim === 'report') {
    onForbiddenClaim = input.onForbiddenClaim
  } else if (input.onForbiddenClaim !== undefined) {
    warnPolicyField(options, 'onForbiddenClaim', 'must be report or handoff; using default report')
  }
  const copilot = normalizeCopilot(input.copilot, options)

  return {
    persona: persona.trim(),
    allowedTopics,
    forbiddenTopics,
    forbiddenClaims,
    negativePrompt: negativePrompt.trim(),
    ...(opening ? { opening } : {}),
    ...(openingInbound ? { openingInbound } : {}),
    ...(openingOutbound ? { openingOutbound } : {}),
    recordingDisclosure,
    maxCallDurationSec,
    callingHours,
    doNotCall,
    blockedCallers,
    onForbiddenClaim,
    copilot
  }
}
