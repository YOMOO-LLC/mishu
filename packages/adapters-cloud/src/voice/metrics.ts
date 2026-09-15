import { assertNoSensitiveTelemetry, redactSid } from './protocol/redact.js'

export interface TurnLatency {
  lastCallerFrameAt: number
  firstAssistantAudioAt: number
  ms: number
}

export type InterruptSource = 'energy' | 'transcript' | 'speech_started'

export interface BridgeMetrics {
  tenantId: string
  callId: string
  streamSidRedacted?: string
  answeredAt: number
  firstAnswerLatencyMs?: number
  turnLatencies: TurnLatency[]
  interruptStopMs: number[]
  interruptSignals: InterruptSource[]
  framesLost: number
  /** Inbound audio dropped because GPT-Live was not ready and the inbound queue capped. */
  inboundQueueDropped: number
  /** Outbound assistant audio dropped because the local play queue capped. */
  outboundDropped: number
  /** Twilio events with a sequence that did not parse (mark/dtmf still advance the cursor). */
  unparsedTwilioEvents: number
  framesReordered: number
  inboundFrames: number
  outboundFrames: number
  inputTranscriptChars: number
  outputTranscriptChars: number
  hangupRequested?: boolean
  hangupReason?: string
  /** Times the hangup judge ran for this call (failures included). */
  hangupChecks?: number
  /** Transcript barge-in candidates dropped as backchannel or too short. */
  interruptsFiltered?: number
  usageSeconds?: number
  closedReason?: string
  gptLiveFailed?: boolean
}

export function createMetrics(input: {
  tenantId: string
  callId: string
  answeredAt: number
  streamSid?: string
}): BridgeMetrics {
  return {
    tenantId: input.tenantId,
    callId: input.callId,
    streamSidRedacted: input.streamSid ? redactSid(input.streamSid) : undefined,
    answeredAt: input.answeredAt,
    turnLatencies: [],
    interruptStopMs: [],
    interruptSignals: [],
    framesLost: 0,
    inboundQueueDropped: 0,
    outboundDropped: 0,
    unparsedTwilioEvents: 0,
    framesReordered: 0,
    inboundFrames: 0,
    outboundFrames: 0,
    inputTranscriptChars: 0,
    outputTranscriptChars: 0,
    hangupChecks: 0,
    interruptsFiltered: 0
  }
}

export function exportMetricsJson(metrics: BridgeMetrics): string {
  const json = JSON.stringify(metrics)
  assertNoSensitiveTelemetry(JSON.parse(json))
  return json
}
