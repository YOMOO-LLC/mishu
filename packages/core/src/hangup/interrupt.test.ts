import { describe, expect, it } from 'vitest'
import {
  classifyTranscriptInterrupt,
  formatInterruptLog,
  stripInterruptPunctuation
} from '@mishu/core/hangup'

describe('@mishu/core/hangup interrupt filter', () => {
  it('filters backchannels and echo-sized fragments', () => {
    expect(classifyTranscriptInterrupt('嗯')).toMatchObject({ action: 'filter', reason: 'too_short' })
    expect(classifyTranscriptInterrupt('好')).toMatchObject({ action: 'filter', reason: 'too_short' })
    expect(classifyTranscriptInterrupt('嗯嗯')).toMatchObject({ action: 'filter', reason: 'backchannel' })
    expect(classifyTranscriptInterrupt('好的')).toMatchObject({ action: 'filter', reason: 'backchannel' })
    expect(classifyTranscriptInterrupt('OK')).toMatchObject({ action: 'filter', reason: 'too_short' })
    expect(classifyTranscriptInterrupt('yeah')).toMatchObject({ action: 'filter', reason: 'too_short' })
    expect(classifyTranscriptInterrupt('uh-huh')).toMatchObject({ action: 'filter', reason: 'backchannel' })
    expect(classifyTranscriptInterrupt('He')).toMatchObject({ action: 'filter', reason: 'too_short' })
    expect(classifyTranscriptInterrupt('…')).toMatchObject({ action: 'filter', reason: 'too_short' })
    expect(stripInterruptPunctuation('嗯，好的！')).toBe('嗯 好的')
  })

  it('fires on a real barge-in phrase', () => {
    expect(classifyTranscriptInterrupt('等一下我想问')).toMatchObject({ action: 'fire', reason: 'speech', chars: 6 })
    expect(classifyTranscriptInterrupt('wait a second')).toMatchObject({ action: 'fire', reason: 'speech' })
    expect(classifyTranscriptInterrupt('不对，我改时间')).toMatchObject({ action: 'fire', reason: 'speech' })
    expect(formatInterruptLog('filtered', 'backchannel', 2)).toBe('interrupt: filtered reason=backchannel chars=2')
    expect(formatInterruptLog('fired', 'transcript', 6)).toBe('interrupt: fired reason=transcript chars=6')
    expect(formatInterruptLog('filtered', '含对话', 1)).toBe('interrupt: filtered reason=other chars=1')
  })
})
