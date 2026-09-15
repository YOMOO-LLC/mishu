import { describe, expect, it } from 'vitest'
import {
  emptyDecisionCounts,
  inputTranscriptHasExpectedName,
  serializeCallTrace,
  type CallTrace
} from './call-trace.js'

function sampleTrace(overrides: Partial<CallTrace> = {}): CallTrace {
  return {
    serverEvents: [],
    clientEvents: [],
    decisions: [],
    counts: emptyDecisionCounts(),
    inboundFrames: 0,
    outboundFrames: 0,
    outboundFramesAfterQuestion: 0,
    interruptSignals: [],
    interruptInstructionSent: false,
    estimatedUsdThisRun: 0,
    cumulativeEstimatedUsd: 0,
    runIndex: 1,
    questionEndedAtMs: 0,
    waitAfterQuestionMs: 0,
    ...overrides
  }
}

describe('inputTranscriptHasExpectedName', () => {
  it('matches the first token of a caller-supplied expected name', () => {
    expect(inputTranscriptHasExpectedName('hello, I am Ada from next door', 'Ada Example')).toBe(true)
    expect(inputTranscriptHasExpectedName('hello, I am Ada from next door', 'ada example')).toBe(true)
  })

  it('is false when the expected name is missing or the transcript has no match', () => {
    expect(inputTranscriptHasExpectedName('hello there', 'Ada Example')).toBe(false)
    expect(inputTranscriptHasExpectedName('hello, I am Ada', '')).toBe(false)
    expect(inputTranscriptHasExpectedName('hello, I am Ada', undefined)).toBe(false)
    expect(inputTranscriptHasExpectedName(undefined, 'Ada Example')).toBe(false)
  })
})

describe('serializeCallTrace', () => {
  it('persists expectedNameInInputTranscript without a hardcoded person', () => {
    const json = serializeCallTrace(sampleTrace({
      inputTranscript: 'hello, I am Ada',
      expectedNameInInputTranscript: inputTranscriptHasExpectedName('hello, I am Ada', 'Ada Example')
    }))
    const parsed = JSON.parse(json) as { expectedNameInInputTranscript?: boolean }
    expect(parsed.expectedNameInInputTranscript).toBe(true)
  })
})
