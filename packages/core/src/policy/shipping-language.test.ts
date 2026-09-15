import { describe, expect, it } from 'vitest'
import callBriefSource from './call-brief.ts?raw'
import campaignPolicySource from './campaign-policy.ts?raw'
import guardrailsSource from './guardrails.ts?raw'
import instructionsSource from './instructions.ts?raw'
import secretaryInstructionsSource from './secretary-instructions.ts?raw'
import policyBarrelSource from '../policy.ts?raw'

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/

const ENGLISH_SOURCES: Array<{ file: string; source: string }> = [
  { file: 'packages/core/src/policy.ts', source: policyBarrelSource },
  { file: 'packages/core/src/policy/campaign-policy.ts', source: campaignPolicySource },
  { file: 'packages/core/src/policy/guardrails.ts', source: guardrailsSource },
  { file: 'packages/core/src/policy/instructions.ts', source: instructionsSource },
  { file: 'packages/core/src/policy/call-brief.ts', source: callBriefSource },
  { file: 'packages/core/src/policy/secretary-instructions.ts', source: secretaryInstructionsSource }
]

describe('policy shipping language', () => {
  it('keeps English policy sources free of CJK', () => {
    const failures: string[] = []
    for (const { file, source } of ENGLISH_SOURCES) {
      source.split('\n').forEach((line, index) => {
        if (CJK.test(line)) failures.push(`${file}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})
