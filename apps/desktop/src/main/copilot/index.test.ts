import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { Campaign } from '../../shared/contracts.js'
import { DEFAULT_CAMPAIGN_POLICY } from '../../shared/policy.js'
import { CallStore, type CallStoreEvent } from '../call-store.js'
import type { MainModuleContext } from '../module-context.js'
import { delegationThreadOptions, register } from './index.js'
import { ToolRegistry } from './registry.js'

function campaign(id: string, enabled: boolean, persona: string, prompt: string): Campaign {
  return {
    id,
    name: id,
    direction: 'outbound',
    systemPrompt: persona,
    policy: {
      ...DEFAULT_CAMPAIGN_POLICY,
      persona,
      allowedTopics: [],
      forbiddenTopics: [],
      forbiddenClaims: [],
      doNotCall: [],
      blockedCallers: [],
      copilot: {
        enabled,
        mode: 'delegation',
        prompt,
        allowedToolIds: ['end_call'],
        autoExecuteRisks: ['read'],
        maxToolCallsPerTurn: 2,
        mayEndCall: true
      }
    },
    voice: 'sol',
    ephemeral: id === 'ephemeral',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('delegationThreadOptions', () => {
  it('uses the command-staged ephemeral campaign before call.started', () => {
    const selected = campaign('selected', false, 'Selected persona', 'selected prompt')
    const ephemeral = campaign('ephemeral', true, 'Ephemeral persona', 'ephemeral prompt')
    const forCampaign = vi.fn(() => [{
      id: 'end_call',
      spec: {
        type: 'function' as const,
        name: 'end_call',
        description: 'End the call',
        inputSchema: { type: 'object' }
      }
    }])
    const ctx = {
      campaignStore: {
        getCampaign: vi.fn((id: string) => id === ephemeral.id ? ephemeral : selected),
        getWorkspace: vi.fn(() => ({
          selectedCampaignId: selected.id,
          campaigns: [selected]
        }))
      },
      callStore: {
        getActiveCallId: vi.fn(() => undefined),
        getCall: vi.fn()
      },
      phoneGateway: {
        getStatus: vi.fn(() => ({ selectedCampaignId: ephemeral.id }))
      },
      toolRegistry: { forCampaign }
    } as unknown as MainModuleContext

    const options = delegationThreadOptions(ctx)

    expect(options?.dynamicTools).toEqual([
      expect.objectContaining({ name: 'end_call' })
    ])
    expect(options?.developerInstructions).toContain('Ephemeral persona')
    expect(options?.developerInstructions).toContain('ephemeral prompt')
    expect(options?.developerInstructions).not.toContain('Selected persona')
    expect(forCampaign).toHaveBeenCalledWith(ephemeral.policy.copilot)
  })

  it('claims a call before the async session start and records one started audit with a call id', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mishu-copilot-start-'))
    const store = new CallStore(join(directory, 'calls.sqlite3'))
    try {
      const configured = campaign('campaign-1', true, 'Test persona', 'Test prompt')
      configured.policy.copilot!.mode = 'transcript'
      store.report({
        call: {
          id: 'call-1',
          direction: 'outbound',
          peer: '+13125550198',
          status: 'active'
        },
        runtimeMode: 'mock',
        campaign: configured,
        threadId: 'mock-realtime-call-1'
      })
      let listener!: (event: CallStoreEvent) => void
      const callStore = {
        getDatabase: () => store.getDatabase(),
        getCall: (id: string) => store.getCall(id),
        getActiveCallId: () => store.getActiveCallId(),
        onEvent: (next: (event: CallStoreEvent) => void) => {
          listener = next
          return vi.fn()
        }
      }
      const ctx = {
        isMock: true,
        callStore,
        campaignStore: {
          getCampaign: vi.fn(() => configured),
          getWorkspace: vi.fn(() => ({
            selectedCampaignId: configured.id,
            campaigns: [configured]
          }))
        },
        phoneGateway: { getStatus: vi.fn(() => ({ selectedCampaignId: configured.id })) },
        toolRegistry: new ToolRegistry(),
        services: { contacts: { find: vi.fn(() => undefined) } },
        approvals: { request: vi.fn() },
        getWindow: vi.fn(() => undefined)
      } as unknown as MainModuleContext
      const handle = register(ctx)
      const started = store.getCall('call-1')
      if (!started) throw new Error('Expected seeded call')

      listener({ type: 'call.started', call: started })
      listener({ type: 'call.started', call: started })

      await vi.waitFor(() => {
        const row = store.getDatabase().prepare(`
          SELECT COUNT(*) AS count
          FROM audit_log
          WHERE action = 'copilot.session.started' AND call_id = ?
        `).get('call-1') as { count: number }
        expect(row.count).toBe(1)
      })
      const nullStarted = store.getDatabase().prepare(`
        SELECT COUNT(*) AS count
        FROM audit_log
        WHERE action = 'copilot.session.started' AND call_id IS NULL
      `).get() as { count: number }
      expect(nullStarted.count).toBe(0)
      handle.dispose()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
