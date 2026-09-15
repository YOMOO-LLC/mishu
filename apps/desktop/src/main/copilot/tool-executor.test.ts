import { describe, expect, it, vi } from 'vitest'

import type { CampaignCopilotPolicy } from '../../shared/policy.js'
import { ToolRegistry, type InCallTool } from './registry.js'
import { ToolExecutor } from './tool-executor.js'

const basePolicy: CampaignCopilotPolicy = {
  enabled: true,
  mode: 'transcript',
  prompt: '',
  allowedToolIds: ['demo'],
  autoExecuteRisks: ['read'],
  maxToolCallsPerTurn: 3,
  mayEndCall: true
}

function setup(tool: InCallTool) {
  const registry = new ToolRegistry()
  registry.register(tool)
  const audits: Array<Record<string, unknown>> = []
  const requestApproval = vi.fn(async (request) => ({
    id: request.id,
    approved: true,
    decidedAt: Date.now()
  }))
  const executor = new ToolExecutor({
    registry,
    requestApproval,
    audit: {
      write(actor, action, callId, details) {
        audits.push({ actor, action, callId, ...details })
      }
    }
  })
  return { executor, audits, requestApproval }
}

function tool(overrides: Partial<InCallTool> = {}): InCallTool {
  return {
    id: 'demo',
    version: 1,
    spec: {
      type: 'function',
      name: 'demo',
      description: 'demo',
      inputSchema: { type: 'object' }
    },
    risk: 'read',
    timeoutMs: 100,
    validate(value) {
      if (!(value as { ok?: boolean })?.ok) throw new Error('invalid')
      return value
    },
    async execute() {
      return { value: 'safe result' }
    },
    toModelText() {
      return 'Got a safe result.'
    },
    ...overrides
  }
}

describe('ToolExecutor', () => {
  it('rejects invalid schema input and audits the result', async () => {
    const { executor, audits } = setup(tool())
    const result = await executor.execute({
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      toolId: 'demo',
      arguments: { ok: false, phone: '+14155550142' },
      policy: basePolicy
    })

    expect(result).toMatchObject({ success: false, code: 'invalid_arguments' })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      actor: 'copilot',
      action: 'copilot.tool.executed',
      callId: 'call-1',
      toolId: 'demo',
      code: 'invalid_arguments'
    })
    expect(JSON.stringify(audits[0])).not.toContain('+14155550142')
  })

  it('routes external writes through local approval', async () => {
    const { executor, requestApproval } = setup(tool({ risk: 'external-write' }))
    const result = await executor.execute({
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      toolId: 'demo',
      arguments: { ok: true },
      policy: basePolicy
    })

    expect(result.success).toBe(true)
    expect(requestApproval).toHaveBeenCalledOnce()
    expect(requestApproval.mock.calls[0][0]).toMatchObject({ kind: 'tool_execute' })
  })

  it('executes automatic tools without requesting local approval', async () => {
    const { executor, requestApproval } = setup(tool({ risk: 'automatic' }))
    const result = await executor.execute({
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      toolId: 'demo',
      arguments: { ok: true },
      policy: basePolicy
    })

    expect(result.success).toBe(true)
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('rejects end_call execution when the dedicated policy switch is off', async () => {
    const endCall = tool({ id: 'end_call' })
    const { executor, requestApproval } = setup(endCall)
    const result = await executor.execute({
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      toolId: 'end_call',
      arguments: { ok: true },
      policy: {
        ...basePolicy,
        allowedToolIds: ['end_call'],
        mayEndCall: false
      }
    })

    expect(result).toMatchObject({ success: false, code: 'not_allowed' })
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('gives the voice model an explicit explanation when approval is denied', async () => {
    const { executor, requestApproval, audits } = setup(tool({ risk: 'external-write' }))
    requestApproval.mockResolvedValueOnce({ id: 'denied', approved: false, decidedAt: Date.now() })

    const result = await executor.execute({
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      toolId: 'demo',
      arguments: { ok: true },
      policy: basePolicy
    })

    expect(result).toMatchObject({
      success: false,
      code: 'approval_denied',
      modelText: 'This action requires local approval and was not approved.'
    })
    expect(audits[0]).toMatchObject({ code: 'approval_denied', success: false })
  })

  it('caps model text at 600 characters and creates an app-owned injection template', async () => {
    const { executor } = setup(tool({ toModelText: () => 'x'.repeat(900) }))
    const result = await executor.execute({
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      toolId: 'demo',
      arguments: { ok: true, callerText: 'RAW_CALLER_SENTENCE' },
      policy: basePolicy
    })

    expect(result.modelText).toHaveLength(600)
    expect(result.injectionText).toMatch(/^System note: tool demo completed./)
    expect(result.injectionText).not.toContain('RAW_CALLER_SENTENCE')
  })

  it('passes AbortSignal to the tool and caches the same idempotency key for 60 seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'))
    const execute = vi.fn(async (ctx: { signal?: AbortSignal }) => ({
      aborted: ctx.signal?.aborted ?? false
    }))
    const { executor } = setup(tool({ execute }))
    const controller = new AbortController()
    const request = {
      campaignId: 'campaign-1',
      callSessionId: 'call-1',
      toolId: 'demo',
      arguments: { z: 1, ok: true },
      policy: basePolicy,
      signal: controller.signal
    }

    const first = await executor.execute(request)
    const second = await executor.execute({
      ...request,
      arguments: { ok: true, z: 1 }
    })

    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][0].signal).toBe(controller.signal)
    expect(first.idempotencyKey).toBe(second.idempotencyKey)
    expect(first.idempotencyKey).toMatch(/^call-1:demo:/)

    vi.advanceTimersByTime(60_001)
    await executor.execute(request)
    expect(execute).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
