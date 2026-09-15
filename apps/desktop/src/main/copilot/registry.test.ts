import { describe, expect, it } from 'vitest'
import type { CampaignCopilotPolicy } from '../../shared/policy.js'
import { ToolRegistry, type InCallTool } from './registry.js'

function tool(id: string, version: number): InCallTool<{ value: string }, string> {
  return {
    id,
    version,
    spec: {
      type: 'function',
      name: id.replaceAll('.', '_'),
      description: `Tool ${id}`,
      inputSchema: { type: 'object' }
    },
    risk: 'read',
    timeoutMs: 1_000,
    validate(args) {
      if (!args || typeof args !== 'object' || typeof (args as { value?: unknown }).value !== 'string') {
        throw new Error('value is required')
      }
      return args as { value: string }
    },
    async execute(_ctx, args) {
      return args.value
    },
    toModelText: (result) => result
  }
}

function policy(allowedToolIds: string[]): CampaignCopilotPolicy {
  return {
    enabled: true,
    mode: 'transcript',
    prompt: '',
    allowedToolIds,
    autoExecuteRisks: ['read'],
    maxToolCallsPerTurn: 3,
    mayEndCall: true
  }
}

describe('ToolRegistry', () => {
  it('registers, lists, and resolves the latest or requested version', () => {
    const registry = new ToolRegistry()
    const v1 = tool('crm.lookup', 1)
    const v2 = tool('crm.lookup', 2)
    registry.register(v1)
    registry.register(v2)

    expect(registry.list()).toEqual([v1, v2])
    expect(registry.resolve('crm.lookup')).toBe(v2)
    expect(registry.resolve('crm.lookup', 1)).toBe(v1)
    expect(registry.resolve('missing')).toBeUndefined()
  })

  it('rejects a duplicate id and version pair', () => {
    const registry = new ToolRegistry()
    registry.register(tool('crm.lookup', 1))
    expect(() => registry.register(tool('crm.lookup', 1))).toThrow(/already registered/i)
  })

  it('returns the latest allowed tools in campaign order', () => {
    const registry = new ToolRegistry()
    const lookupV1 = tool('crm.lookup', 1)
    const lookupV2 = tool('crm.lookup', 2)
    const note = tool('crm.note', 1)
    registry.register(lookupV1)
    registry.register(note)
    registry.register(lookupV2)

    expect(registry.forCampaign(policy(['crm.note', 'missing', 'crm.lookup']))).toEqual([
      note,
      lookupV2
    ])
    expect(registry.forCampaign(policy([]))).toEqual([])
  })

  it('hides end_call when the dedicated campaign policy disables it', () => {
    const registry = new ToolRegistry()
    const endCall = tool('end_call', 1)
    registry.register(endCall)

    expect(registry.forCampaign(policy(['end_call']))).toEqual([endCall])
    expect(registry.forCampaign({ ...policy(['end_call']), mayEndCall: false })).toEqual([])
  })
})
