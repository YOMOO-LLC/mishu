import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as corePolicy from '@mishu/core/policy'
import { CallStore } from '../call-store.js'
import { CampaignStore } from '../campaign-store.js'
import { ApprovalService } from './approval-service.js'
import { CampaignService } from './campaign-service.js'
import { ServiceError } from './service-error.js'
import { TaskService } from './task-service.js'

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'live-phone-task-service-'))
  const calls = new CallStore(join(directory, 'calls.sqlite3'))
  const campaigns = new CampaignStore(join(directory, 'campaigns.sqlite3'))
  return { directory, calls, campaigns }
}

function createTasks(now?: () => number) {
  const value = setup()
  const campaigns = new CampaignService(value.campaigns)
  const approvals = new ApprovalService()
  const status = {
    runtimeMode: 'mock' as const,
    phoneConnection: 'ready' as const,
    codexConnection: { status: 'ready' as const },
    controlMode: 'ai' as const,
    updatedAt: 1
  }
  const gateway = {
    getStatus: vi.fn(() => status),
    send: vi.fn(async () => ({ requestId: 'r', ok: true as const, status }))
  }
  const tasks = new TaskService({
    store: value.calls,
    campaigns,
    approvals,
    gateway: gateway as never,
    ...(now ? { now } : {})
  })
  return { campaigns, gateway, tasks, status }
}

describe('TaskService dial guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses @mishu/core/policy evaluateDialGuard with the numeric now', async () => {
    const now = Date.UTC(2026, 8, 7, 13, 0)
    const spy = vi.spyOn(corePolicy, 'evaluateDialGuard')
    const { campaigns, tasks } = createTasks(() => now)
    const campaign = campaigns.get(campaigns.workspace({ reveal: true }).selectedCampaignId, { reveal: true })

    const pending = tasks.startManagedDial({
      peer: '+14155550199',
      idempotencyKey: 'core-guard',
      actor: 'http',
      requireApproval: false
    })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(campaign.policy, '+14155550199', now)
    expect(spy.mock.results[0]?.value).toEqual({ allowed: true })
    await pending.completion
  })

  it('blocks a DNC peer with the core guard message', () => {
    const { campaigns, gateway, tasks } = createTasks()
    const campaign = campaigns.get(campaigns.workspace({ reveal: true }).selectedCampaignId, { reveal: true })
    campaigns.update(campaign.id, {
      policy: { ...campaign.policy, doNotCall: ['+1 (415) 555-0199'] }
    })

    try {
      tasks.startManagedDial({
        peer: '+14155550199',
        idempotencyKey: 'dnc',
        actor: 'http',
        requireApproval: false
      })
      throw new Error('Expected managed dial to be blocked')
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError)
      expect(error).toMatchObject({
        code: 'GUARDRAIL_BLOCKED',
        message: 'Number +14155550199 is on the DNC list; outbound call refused'
      })
    }
    expect(gateway.send).not.toHaveBeenCalled()
  })

  it('blocks a peer outside calling hours with the core guard message', () => {
    const now = Date.UTC(2026, 8, 13, 13, 0)
    const { campaigns, gateway, tasks } = createTasks(() => now)
    const campaign = campaigns.get(campaigns.workspace({ reveal: true }).selectedCampaignId, { reveal: true })
    campaigns.update(campaign.id, {
      policy: {
        ...campaign.policy,
        callingHours: {
          timeZone: 'America/New_York',
          windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }]
        }
      }
    })

    try {
      tasks.startManagedDial({
        peer: '+14155550199',
        idempotencyKey: 'hours',
        actor: 'http',
        requireApproval: false
      })
      throw new Error('Expected managed dial to be blocked')
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError)
      expect(error).toMatchObject({
        code: 'GUARDRAIL_BLOCKED',
        message: 'Outside the allowed calling window; outbound call refused'
      })
    }
    expect(gateway.send).not.toHaveBeenCalled()
  })

  it('allows a non-DNC peer inside calling hours', async () => {
    const now = Date.UTC(2026, 8, 7, 13, 0)
    const { campaigns, gateway, tasks, status } = createTasks(() => now)
    const campaign = campaigns.get(campaigns.workspace({ reveal: true }).selectedCampaignId, { reveal: true })
    campaigns.update(campaign.id, {
      policy: {
        ...campaign.policy,
        callingHours: {
          timeZone: 'America/New_York',
          windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }]
        }
      }
    })

    const pending = tasks.startManagedDial({
      peer: '+14155550199',
      idempotencyKey: 'allowed',
      actor: 'http',
      requireApproval: false
    })
    await expect(pending.completion).resolves.toEqual(status)
    expect(gateway.send).toHaveBeenCalledWith(
      { type: 'dial', peer: '+14155550199', campaignId: campaign.id },
      { actor: 'http' }
    )
  })
})
