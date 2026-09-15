import { describe, expect, it } from 'vitest'

import type { DynamicToolCallParams } from '../codex/types.js'
import { MockCopilotBackend } from './runner.js'

function dynamicTool(name: string) {
  return {
    type: 'function' as const,
    name,
    description: name,
    inputSchema: { type: 'object' }
  }
}

describe('MockCopilotBackend', () => {
  it('calls the first available campaign tool with deterministic lookup arguments', async () => {
    const backend = new MockCopilotBackend()
    let resolveCall!: (params: DynamicToolCallParams) => void
    const called = new Promise<DynamicToolCallParams>((resolve) => { resolveCall = resolve })
    backend.setDynamicToolHandler(async (params) => {
      resolveCall(params)
      return { contentItems: [{ type: 'inputText', text: 'ok' }], success: true }
    })
    const threadId = await backend.startThread({
      dynamicTools: [dynamicTool('lookup_customer')]
    })

    await backend.startTurn(threadId, 'Please look up the customer')

    await expect(called).resolves.toMatchObject({
      tool: 'lookup_customer',
      arguments: { phone: '+14155550142' }
    })
  })

  it('provides a future business-hours slot to appointments_make', async () => {
    const backend = new MockCopilotBackend()
    let resolveCall!: (params: DynamicToolCallParams) => void
    const called = new Promise<DynamicToolCallParams>((resolve) => { resolveCall = resolve })
    backend.setDynamicToolHandler(async (params) => {
      resolveCall(params)
      return { contentItems: [{ type: 'inputText', text: 'ok' }], success: true }
    })
    const threadId = await backend.startThread({ dynamicTools: [dynamicTool('appointments_make')] })

    await backend.startTurn(threadId, 'Please help me book')

    const params = await called
    expect(params.tool).toBe('appointments_make')
    expect(params.arguments).toMatchObject({ time_zone: 'America/Chicago', duration_min: 30 })
    const args = params.arguments as Record<string, unknown>
    expect(Date.parse(String(args.start_at))).toBeGreaterThan(Date.now())
  })
})
