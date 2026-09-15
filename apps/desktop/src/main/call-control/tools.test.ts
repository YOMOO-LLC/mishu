import { describe, expect, it, vi } from 'vitest'

import {
  createEndCallTool,
  END_CALL_AUDIT_ACTION,
  END_CALL_TURN_WAIT_MS,
  END_CALL_WAIT_AUDIT_ACTION
} from './tools.js'

describe('end_call tool', () => {
  it('audits immediately, waits for turn completion, and hangs up without approval semantics', async () => {
    let finishTurn!: () => void
    const turnDone = new Promise<void>((resolve) => { finishTurn = resolve })
    const hangup = vi.fn(async () => undefined)
    const writeAudit = vi.fn()
    const tool = createEndCallTool({ hangup, writeAudit })

    const result = await tool.execute({
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      actor: 'copilot',
      turnDone
    }, { reason: 'callee_requested', farewell_said: true })

    expect(tool.risk).toBe('automatic')
    expect(writeAudit).toHaveBeenCalledWith(
      'copilot',
      END_CALL_AUDIT_ACTION,
      'call-1',
      { reason: 'callee_requested', farewell_said: true }
    )
    expect(hangup).not.toHaveBeenCalled()
    finishTurn()
    await result.completion
    expect(hangup).toHaveBeenCalledOnce()
    expect(writeAudit).toHaveBeenLastCalledWith(
      'copilot',
      END_CALL_WAIT_AUDIT_ACTION,
      'call-1',
      expect.objectContaining({ waitReason: 'turn_done', waitedMs: expect.any(Number) })
    )
  })

  it('uses the four second upper bound and audits a timeout when no realtime turn completion arrives', async () => {
    vi.useFakeTimers()
    const hangup = vi.fn(async () => undefined)
    const writeAudit = vi.fn()
    const tool = createEndCallTool({ hangup, writeAudit })
    const result = await tool.execute({
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      actor: 'copilot',
      turnDone: new Promise(() => undefined)
    }, { reason: 'completed', farewell_said: true })

    await vi.advanceTimersByTimeAsync(END_CALL_TURN_WAIT_MS - 1)
    expect(hangup).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await result.completion
    expect(hangup).toHaveBeenCalledOnce()
    expect(writeAudit).toHaveBeenLastCalledWith(
      'copilot',
      END_CALL_WAIT_AUDIT_ACTION,
      'call-1',
      { waitReason: 'timeout', waitedMs: END_CALL_TURN_WAIT_MS }
    )
    vi.useRealTimers()
  })

  it('keeps the hangup scheduled once end_requested is written even if the copilot turn aborts', async () => {
    let finishTurn!: () => void
    const turnDone = new Promise<void>((resolve) => { finishTurn = resolve })
    const controller = new AbortController()
    const hangup = vi.fn(async () => undefined)
    const writeAudit = vi.fn()
    const tool = createEndCallTool({ hangup, writeAudit })

    const result = await tool.execute({
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      actor: 'copilot',
      signal: controller.signal,
      turnDone
    }, { reason: 'callee_requested', farewell_said: true })
    controller.abort()
    finishTurn()
    await result.completion

    expect(writeAudit).toHaveBeenCalledWith(
      'copilot', END_CALL_AUDIT_ACTION, 'call-1', expect.any(Object)
    )
    expect(hangup).toHaveBeenCalledOnce()
  })

  it('rejects missing or invalid required arguments', () => {
    const tool = createEndCallTool({ hangup: vi.fn(), writeAudit: vi.fn() })
    expect(() => tool.validate({ reason: 'later', farewell_said: true })).toThrow()
    expect(() => tool.validate({ reason: 'policy', farewell_said: 'yes' })).toThrow()
  })
})
