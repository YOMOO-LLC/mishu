import type { BridgeDecision, BridgeDecisionKind } from './media-bridge.js'
import { assertNoSensitiveTelemetry } from './protocol/redact.js'

export interface TimedType {
  tMs: number
  type: string
}

export interface TimedDecision {
  tMs: number
  kind: BridgeDecisionKind
  reason?: string
  source?: string
}

export interface DecisionCounts {
  forward: number
  drop: number
  interrupt: number
  unsuppress: number
}

export interface CallTrace {
  serverEvents: TimedType[]
  clientEvents: TimedType[]
  decisions: TimedDecision[]
  counts: DecisionCounts
  inboundFrames: number
  outboundFrames: number
  outboundFramesAfterQuestion: number
  greetingOutboundFrames?: number
  firstAnswerLatencyMsAfterQuestion?: number
  interruptSignals: string[]
  interruptInstructionSent: boolean
  audioFormat?: string
  inputTranscript?: string
  outputTranscript?: string
  expectedNameInInputTranscript?: boolean
  outputTranscriptEvents?: number
  nativeWavPath?: string
  phoneHeardWavPath?: string
  usageSeconds?: number
  estimatedUsdThisRun: number
  cumulativeEstimatedUsd: number
  runIndex: number
  closedReason?: string
  questionEndedAtMs: number
  waitAfterQuestionMs: number
  /** Stripped before serialize; never persist audio in traces. */
  nativeAudioChunks?: string[]
  phoneHeardChunks?: string[]
  turnLatencies?: Array<{ lastCallerFrameAt: number; firstAssistantAudioAt: number; ms: number }>
  framesLost?: number
  hangupRequested?: boolean
  hangupChecks?: number
  hangupReason?: string
  hangupRestEnded?: number
  farewellEndedAtMs?: number
  hangupAfterFarewellMs?: number
}

export function emptyDecisionCounts(): DecisionCounts {
  return { forward: 0, drop: 0, interrupt: 0, unsuppress: 0 }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when `expectedName` (or its first whitespace token) appears in the
 * input transcript. Callers supply the name from config or fixture input;
 * this helper never hardcodes a person.
 */
export function inputTranscriptHasExpectedName(
  inputTranscript: string | undefined,
  expectedName: string | undefined
): boolean {
  const name = expectedName?.trim()
  if (!name) return false
  const haystack = inputTranscript ?? ''
  if (!haystack) return false
  const token = name.split(/\s+/)[0] ?? name
  return new RegExp(escapeRegExp(token), 'i').test(haystack)
}

export function relativeMs(origin: number, at: number): number {
  return at - origin
}

export function recordDecision(
  origin: number,
  counts: DecisionCounts,
  decision: BridgeDecision
): TimedDecision {
  counts[decision.kind] += 1
  return {
    tMs: relativeMs(origin, decision.at),
    kind: decision.kind,
    reason: decision.reason,
    source: decision.source
  }
}

export function serializeCallTrace(trace: CallTrace): string {
  const { nativeAudioChunks: _native, phoneHeardChunks: _phone, ...safe } = trace
  const json = JSON.stringify(safe, null, 2)
  assertNoSensitiveTelemetry(JSON.parse(json) as unknown)
  return json
}

export function rawEventType(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return 'unknown'
  const type = (raw as { type?: unknown }).type
  return typeof type === 'string' && type.length > 0 ? type : 'unknown'
}
