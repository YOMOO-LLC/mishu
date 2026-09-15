import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallTaskSubmitInput, PhoneCommand, PhoneStatusSnapshot } from '../../shared/contracts.js'
import { MockAnalysisBackend } from '../analysis/backend.js'
import { AnalysisService } from '../analysis/service.js'
import { CallStore } from '../call-store.js'
import { CampaignStore } from '../campaign-store.js'
import { ApprovalService } from '../services/approval-service.js'
import { BudgetService } from '../services/budget-service.js'
import { CampaignService } from '../services/campaign-service.js'
import { TaskService } from '../services/task-service.js'
import {
  TaskRunner,
  TASK_RETRY_BACKOFF_MS,
  shouldRetryTaskOutcome,
  taskOutcomeForAgentHangup
} from './runner.js'

interface Harness {
  directory: string
  store: CallStore
  approvals: ApprovalService
  tasks: TaskService
  budget: BudgetService
  runner: TaskRunner
  backend: MockAnalysisBackend
  sent: PhoneCommand[]
  now: { value: number }
}

const harnesses: Harness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.runner.dispose()
    harness.approvals.dispose()
    harness.store.close()
    rmSync(harness.directory, { recursive: true, force: true })
  }
})

function setup(options: { approvalTimeoutMs?: number; responses?: ConstructorParameters<typeof MockAnalysisBackend>[0] } = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'live-phone-task-runner-'))
  const store = new CallStore(join(directory, 'calls.sqlite3'))
  const campaignStore = new CampaignStore(join(directory, 'campaigns.sqlite3'))
  const campaigns = new CampaignService(campaignStore)
  const approvals = new ApprovalService({ timeoutMs: options.approvalTimeoutMs ?? 1_000 })
  const now = { value: Date.UTC(2030, 0, 2, 12) }
  const sent: PhoneCommand[] = []
  let current: PhoneStatusSnapshot = {
    runtimeMode: 'mock', phoneConnection: 'ready', codexConnection: { status: 'ready' },
    controlMode: 'ai', updatedAt: now.value
  }
  let callSequence = 0
  const gateway = {
    getStatus: vi.fn(() => current),
    send: vi.fn(async (command: PhoneCommand) => {
      sent.push(command)
      if (command.type === 'dial') {
        callSequence += 1
        const call = { id: `call-${callSequence}`, direction: 'outbound' as const, peer: command.peer, status: 'active' as const, startedAt: now.value }
        current = { ...current, call, updatedAt: now.value }
        store.report({ call, runtimeMode: 'mock', campaign: campaigns.get(command.campaignId, { reveal: true }) })
        store.reportTranscriptEntry({ id: `caller-${callSequence}`, speaker: 'caller', text: 'We discussed the requested goal in enough detail.', final: true, timestamp: now.value })
      } else if (command.type === 'hangup' && current.call) {
        const call = { ...current.call, status: 'ended' as const }
        current = { ...current, call, updatedAt: now.value }
        store.report({ call, runtimeMode: 'mock', endReason: 'hangup' })
      }
      return { requestId: `r-${sent.length}`, ok: true as const, status: current }
    })
  }
  const tasks = new TaskService({ store, campaigns, approvals, gateway: gateway as never, now: () => now.value })
  const budget = new BudgetService(store, () => now.value)
  const backend = new MockAnalysisBackend(options.responses)
  const analysis = new AnalysisService({ callStore: store, backend, now: () => now.value })
  const runner = new TaskRunner({
    tasks, budget, analysis, store, gateway: gateway as never, isMock: true,
    now: () => now.value, schedulerIntervalMs: 10_000, mockCallDurationMs: 10
  })
  const harness = { directory, store, approvals, tasks, budget, runner, backend, sent, now }
  harnesses.push(harness)
  return harness
}

function submit(harness: Harness, suffix: string, patch: Partial<CallTaskSubmitInput> = {}) {
  return harness.tasks.submit({
    to: '+13125550198', goal: `Goal ${suffix}`, idempotencyKey: `key-${suffix}`, ...patch
  }, 'http')
}

function allow(harness: Harness): void {
  harness.budget.save({
    enabled: true, dailyMaxCalls: 10, dailyMaxMinutes: 100,
    allowedNumbers: ['+13125550198'], allowedPrefixes: ['+1'],
    allowedHours: { timeZone: 'UTC', windows: [] }, killSwitch: false
  })
}

describe('TaskRunner', () => {
  it('maps copilot hangup reasons to stable task outcomes', () => {
    expect(taskOutcomeForAgentHangup('no_answer', 'completed')).toBe('reached')
    expect(taskOutcomeForAgentHangup('reached', 'callee_requested')).toBe('reached')
    expect(taskOutcomeForAgentHangup('no_answer', 'callee_requested')).toBe('refused')
    expect(taskOutcomeForAgentHangup('wrong_number', 'callee_requested')).toBe('wrong_number')
    expect(taskOutcomeForAgentHangup('no_answer', 'policy')).toBe('error')
    expect(taskOutcomeForAgentHangup('refused')).toBe('refused')
    expect(shouldRetryTaskOutcome('no_answer', false)).toBe(true)
    expect(shouldRetryTaskOutcome('no_answer', true)).toBe(false)
  })

  it('runs direct calls serially when they fit the budget', async () => {
    const value = setup()
    allow(value)
    const first = submit(value, 'one')
    const second = submit(value, 'two', { to: '+14155550142' })
    await value.runner.processDue()
    expect(value.tasks.get(first.id).error).toBeUndefined()
    expect(value.tasks.get(first.id)).toMatchObject({ status: 'completed' })
    expect(value.tasks.get(second.id).status).toBe('completed')
    expect(value.sent.filter(({ type }) => type === 'dial')).toHaveLength(2)
    expect(value.sent.map(({ type }) => type)).toEqual(['dial', 'hangup', 'dial', 'hangup'])
  })

  it('waits for approval outside budget, then analyzes a schema result', async () => {
    const value = setup()
    const task = submit(value, 'approval', {
      resultSchema: {
        type: 'object', additionalProperties: false, required: ['booked'],
        properties: { booked: { type: 'boolean' } }
      }
    })
    const run = value.runner.processDue()
    await expect.poll(() => value.tasks.get(task.id).status).toBe('awaiting_approval')
    const approval = value.approvals.listPending()[0]
    expect(approval?.kind).toBe('call_dial')
    value.approvals.decide({ id: approval?.id as string, approved: true, decidedAt: Date.now() })
    await run
    expect(value.tasks.get(task.id)).toMatchObject({ status: 'completed', outcome: 'reached', result: { booked: false } })
  })

  it('fails approval denial and timeout without dialing', async () => {
    const denied = setup()
    const deniedTask = submit(denied, 'denied')
    const deniedRun = denied.runner.processDue()
    await expect.poll(() => denied.approvals.listPending()).toHaveLength(1)
    const approval = denied.approvals.listPending()[0]
    denied.approvals.decide({ id: approval?.id as string, approved: false, decidedAt: Date.now() })
    await deniedRun
    expect(denied.tasks.get(deniedTask.id).status).toBe('failed')
    expect(denied.sent).toHaveLength(0)

    const timed = setup({ approvalTimeoutMs: 10 })
    const timedTask = submit(timed, 'timed')
    await timed.runner.processDue()
    expect(timed.tasks.get(timedTask.id)).toMatchObject({ status: 'failed', error: 'Local approval timed out' })
    expect(timed.sent).toHaveLength(0)
  })

  it('retries no-answer using the 2m backoff and then completes', async () => {
    const value = setup({ responses: [
      JSON.stringify({ outcome: 'no_answer', summary: 'No answer.', confidence: 'high' }),
      JSON.stringify({ outcome: 'reached', summary: 'Reached.', confidence: 'high' })
    ] })
    allow(value)
    const task = submit(value, 'retry', { constraints: { maxAttempts: 2 } })
    await value.runner.processDue()
    expect(value.tasks.get(task.id)).toMatchObject({ status: 'queued', attempts: 1, outcome: 'no_answer' })
    await value.runner.processDue()
    expect(value.sent.filter(({ type }) => type === 'dial')).toHaveLength(1)
    value.now.value += TASK_RETRY_BACKOFF_MS[0]
    await value.runner.processDue()
    expect(value.tasks.get(task.id)).toMatchObject({ status: 'completed', attempts: 2, outcome: 'reached' })
  })

  it('fails immediately while the kill switch is enabled', async () => {
    const value = setup()
    value.budget.save({ killSwitch: true })
    const task = submit(value, 'kill')
    await value.runner.processDue()
    expect(value.tasks.get(task.id)).toMatchObject({ status: 'failed', error: 'Call budget kill switch is enabled' })
    expect(value.sent).toHaveLength(0)
  })
})
