export interface TranscriptTurn {
  role: 'caller' | 'assistant'
  text: string
}

export interface HangupVerdict {
  end: boolean
  reason: string
}

export type HangupJudge = (turns: TranscriptTurn[]) => Promise<HangupVerdict>

export type TranscriptInterruptFilterReason = 'too_short' | 'backchannel'

export interface TranscriptInterruptDecision {
  action: 'fire' | 'filter'
  reason: 'speech' | TranscriptInterruptFilterReason
  chars: number
}
