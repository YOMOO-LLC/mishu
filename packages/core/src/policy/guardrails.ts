import type { CampaignPolicy } from './campaign-policy'

const E164_PATTERN = /^\+[1-9]\d{6,14}$/

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function isHourMinuteAfter(start: string, end: string, nowMinutes: number): boolean {
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s === e) return false
  if (s < e) {
    return nowMinutes >= s && nowMinutes < e
  }
  return nowMinutes >= s || nowMinutes < e
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
}

export function isWithinCallingHours(policy: CampaignPolicy, now: number): boolean {
  const at = new Date(now)
  const { timeZone, windows } = policy.callingHours
  if (!timeZone || windows.length === 0) return true
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at)
  const weekday = WEEKDAYS[short.toLowerCase()] ?? -1
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  const nowMinutes = Number(map.hour) * 60 + Number(map.minute)
  return windows.some(
    (w) => w.days.includes(weekday) && isHourMinuteAfter(w.start, w.end, nowMinutes)
  )
}

export function isDoNotCall(policy: CampaignPolicy, peer: string): boolean {
  return policy.doNotCall.some((entry) => normalizePhone(entry) === normalizePhone(peer))
}

export function matchForbiddenClaims(policy: CampaignPolicy, text: string): string[] {
  if (policy.forbiddenClaims.length === 0 || !text) return []
  const haystack = text.toLocaleLowerCase()
  return policy.forbiddenClaims.filter((claim) => claim && haystack.includes(claim.toLocaleLowerCase()))
}

export function hasExceededMaxDuration(
  policy: CampaignPolicy,
  answeredAt: number,
  now: number
): boolean {
  if (!answeredAt || answeredAt <= 0 || now <= answeredAt) return false
  return now - answeredAt >= policy.maxCallDurationSec * 1000
}

export type DialGuardResult =
  | { allowed: true }
  | { allowed: false; reason: 'dnc' | 'outside_calling_hours'; message: string }

export function evaluateDialGuard(
  policy: CampaignPolicy,
  peer: string,
  now: number
): DialGuardResult {
  if (isDoNotCall(policy, peer)) {
    return { allowed: false, reason: 'dnc', message: `Number ${peer} is on the DNC list; outbound call refused` }
  }
  if (!isWithinCallingHours(policy, now)) {
    return {
      allowed: false,
      reason: 'outside_calling_hours',
      message: 'Outside the allowed calling window; outbound call refused'
    }
  }
  return { allowed: true }
}

export type InboundGuardResult =
  | { allowed: true }
  | { allowed: false; reason: 'blocked_caller'; message: string }

export function evaluateInboundGuard(
  policy: CampaignPolicy,
  peer: string
): InboundGuardResult {
  const blocked = policy.blockedCallers.some(
    (entry) => normalizePhone(entry) === normalizePhone(peer)
  )
  if (blocked) {
    return { allowed: false, reason: 'blocked_caller', message: `Caller ${peer} is on the block list; inbound call refused` }
  }
  return { allowed: true }
}

function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/[\s().-]/g, '')
  return E164_PATTERN.test(cleaned) ? cleaned : phone
}
