import type { CallSession, CallTask, PhoneCommandResult } from '../../shared/contracts.js'
import type { AnalysisService } from '../analysis/service.js'
import type { AnalysisOutcome } from '../analysis/types.js'
import type { CallStore, CallStoreEvent } from '../call-store.js'
import { END_CALL_AUDIT_ACTION, type EndCallReason } from '../call-control/tools.js'
import type { PhoneCommandGateway } from '../phone-gateway.js'
import type { BudgetService } from '../services/budget-service.js'
import { ServiceError } from '../services/service-error.js'
import type { TaskService } from '../services/task-service.js'

export const TASK_RETRY_BACKOFF_MS = [120_000, 600_000, 1_800_000] as const

export interface TaskRunnerOptions {
  tasks: TaskService
  budget: BudgetService
  analysis: AnalysisService
  store: CallStore
  gateway: PhoneCommandGateway
  isMock: boolean
  now?: () => number
  schedulerIntervalMs?: number
  mockCallDurationMs?: number
}

export class TaskRunner {
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly mockCallDurationMs: number
  private running = false
  private disposed = false
  private scheduler?: ReturnType<typeof setInterval>
  private unsubscribeSubmitted?: () => void
  private currentTaskId?: string

  constructor(private readonly options: TaskRunnerOptions) {
    this.now = options.now ?? Date.now
    this.intervalMs = Math.max(25, options.schedulerIntervalMs ?? 1_000)
    this.mockCallDurationMs = Math.max(10, options.mockCallDurationMs ?? 250)
    options.tasks.setCancelHandler((task) => this.handleCancel(task))
  }

  start(): void {
    if (this.scheduler || this.disposed) return
    this.unsubscribeSubmitted = this.options.tasks.onSubmitted(() => this.kick())
    this.scheduler = setInterval(() => this.kick(), this.intervalMs)
    this.scheduler.unref?.()
    this.kick()
  }

  kick(): void {
    if (this.disposed || this.running) return
    void this.processDue().catch((error) => {
      this.options.store.writeAudit('task.runner_error', undefined, {
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  async processDue(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      while (!this.disposed) {
        const task = this.nextRunnable()
        if (!task) return
        this.currentTaskId = task.id
        await this.runTask(task)
        this.currentTaskId = undefined
      }
    } finally {
      this.currentTaskId = undefined
      this.running = false
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.scheduler) clearInterval(this.scheduler)
    this.scheduler = undefined
    this.unsubscribeSubmitted?.()
    this.unsubscribeSubmitted = undefined
  }

  private nextRunnable(): CallTask | undefined {
    const now = this.now()
    for (const task of this.options.tasks.queued()) {
      const notBefore = task.constraints.notBefore ? Date.parse(task.constraints.notBefore) : undefined
      if (notBefore !== undefined && now < notBefore) continue
      if (task.attempts > 0) {
        const delay = TASK_RETRY_BACKOFF_MS[Math.min(task.attempts - 1, TASK_RETRY_BACKOFF_MS.length - 1)]
        if (now < task.updatedAt + delay) continue
      }
      return task
    }
    return undefined
  }

  private async runTask(task: CallTask): Promise<void> {
    const now = this.now()
    if (task.constraints.notAfter && now >= Date.parse(task.constraints.notAfter)) {
      this.options.tasks.transition(task.id, 'failed', { error: 'Task calling window expired' })
      return
    }
    const budget = this.options.budget.evaluate(task, new Date(now))
    if (budget.reasons.includes('kill_switch')) {
      this.options.tasks.transition(task.id, 'failed', { error: 'Call budget kill switch is enabled' })
      return
    }
    const nextAttempt = task.attempts + 1
    let pending
    try {
      pending = this.options.tasks.startManagedDial({
        peer: task.to,
        campaignId: task.campaignId,
        goal: task.goal,
        idempotencyKey: `${task.id}:${nextAttempt}`,
        actor: task.createdBy,
        requireApproval: !budget.within,
        bypassPeerCooldown: task.attempts > 0
      })
    } catch (error) {
      this.failOrRetry(task, nextAttempt, error)
      return
    }

    if (pending.approvalId) {
      this.options.tasks.transition(task.id, 'awaiting_approval')
    } else {
      this.options.tasks.transition(task.id, 'dialing', { attempts: nextAttempt })
    }

    let status
    try {
      status = await pending.completion
    } catch (error) {
      if (this.isCancelled(task.id)) return
      if (error instanceof ServiceError && ['APPROVAL_DENIED', 'APPROVAL_TIMEOUT', 'APP_NOT_READY'].includes(error.code)) {
        this.options.tasks.transition(task.id, 'failed', { error: error.message })
      } else {
        this.failOrRetry(this.options.tasks.get(task.id, { reveal: true }), nextAttempt, error)
      }
      return
    }
    if (this.isCancelled(task.id)) return
    if (pending.approvalId) {
      this.options.tasks.transition(task.id, 'dialing', { attempts: nextAttempt })
    }
    const callId = status.call?.id
    if (!callId) {
      this.failOrRetry(this.options.tasks.get(task.id, { reveal: true }), nextAttempt, new Error('Dial did not return a call id'))
      return
    }
    this.options.tasks.transition(task.id, 'in_call', { callId })

    if (this.options.isMock) {
      const timer = setTimeout(() => {
        void this.options.gateway.send({ type: 'hangup' }, { actor: 'task-runner' })
      }, this.mockCallDurationMs)
      timer.unref?.()
    }

    let call: CallSession
    try {
      call = await this.waitForCallEnd(callId)
    } catch (error) {
      if (!this.isCancelled(task.id)) this.failOrRetry(this.options.tasks.get(task.id, { reveal: true }), nextAttempt, error)
      return
    }
    if (this.isCancelled(task.id)) return

    this.options.tasks.transition(task.id, 'analyzing')
    let analyzed
    try {
      analyzed = await this.options.analysis.analyze({
        callId,
        ...(task.resultSchema ? { resultSchema: task.resultSchema } : {}),
        goal: task.goal
      })
    } catch (error) {
      this.failOrRetry(this.options.tasks.get(task.id, { reveal: true }), nextAttempt, error)
      return
    }
    if (this.isCancelled(task.id)) return
    const agentHangup = findAgentHangup(
      this.options.store,
      callId,
      call.endReason === 'local_hangup'
    )
    const outcome = taskOutcomeForAgentHangup(analyzed.outcome, agentHangup.reason)
    if (
      shouldRetryTaskOutcome(outcome, agentHangup.endedByAgent) &&
      nextAttempt < (task.constraints.maxAttempts ?? 1)
    ) {
      this.options.tasks.transition(task.id, 'queued', {
        attempts: nextAttempt,
        callId,
        resultId: analyzed.id,
        outcome,
        error: analyzed.error
      })
      return
    }
    this.options.tasks.transition(task.id, 'completed', {
      attempts: nextAttempt,
      callId,
      resultId: analyzed.id,
      outcome,
      error: analyzed.error,
      endedAt: call.endedAt ?? this.now()
    })
  }

  private failOrRetry(task: CallTask, attempts: number, error: unknown): void {
    if (this.isCancelled(task.id)) return
    const message = error instanceof Error ? error.message : String(error)
    const nonRetryable = error instanceof ServiceError && ['GUARDRAIL_BLOCKED', 'INVALID_NUMBER', 'NOT_FOUND'].includes(error.code)
    if (!nonRetryable && attempts < (task.constraints.maxAttempts ?? 1)) {
      this.options.tasks.transition(task.id, 'queued', { attempts, error: message })
      return
    }
    this.options.tasks.transition(task.id, 'failed', { attempts, error: message })
  }

  private waitForCallEnd(callId: string): Promise<CallSession> {
    const current = this.options.store.getCall(callId)
    if (current && (current.status === 'ended' || current.status === 'error')) return Promise.resolve(current)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new ServiceError('TIMEOUT', 'Call did not end before the task timeout'))
      }, 60 * 60 * 1_000)
      timeout.unref?.()
      const unsubscribe = this.options.store.onEvent((event: CallStoreEvent) => {
        if (event.type !== 'call.ended' || event.call.id !== callId) return
        clearTimeout(timeout)
        unsubscribe()
        resolve(event.call)
      })
      const afterSubscribe = this.options.store.getCall(callId)
      if (afterSubscribe && (afterSubscribe.status === 'ended' || afterSubscribe.status === 'error')) {
        clearTimeout(timeout)
        unsubscribe()
        resolve(afterSubscribe)
      }
    })
  }

  private isCancelled(id: string): boolean {
    return this.options.tasks.get(id, { reveal: true }).status === 'cancelled'
  }

  private async handleCancel(task: CallTask): Promise<void> {
    if (this.currentTaskId !== task.id || !task.callId) return
    const result = await this.options.gateway.send({ type: 'hangup' }, { actor: 'task-runner' })
    if (!result.ok) this.writeCommandFailure(result)
  }

  private writeCommandFailure(result: Extract<PhoneCommandResult, { ok: false }>): void {
    this.options.store.writeAudit('task.cancel_hangup_failed', undefined, {
      code: result.code,
      message: result.message
    })
  }
}

export function taskOutcomeForAgentHangup(
  analyzed: AnalysisOutcome,
  reason?: EndCallReason
): AnalysisOutcome {
  if (reason === 'completed') return 'reached'
  if (reason === 'callee_requested') {
    if (analyzed === 'reached' || analyzed === 'wrong_number') return analyzed
    return 'refused'
  }
  if (reason === 'policy' && analyzed === 'no_answer') return 'error'
  return analyzed
}

export function shouldRetryTaskOutcome(
  outcome: AnalysisOutcome,
  endedByAgent: boolean
): boolean {
  return !endedByAgent && (outcome === 'no_answer' || outcome === 'error')
}

function findAgentHangup(
  store: CallStore,
  callId: string,
  locallyEnded: boolean
): { endedByAgent: boolean; reason?: EndCallReason } {
  if (!locallyEnded) return { endedByAgent: false }
  const audit = store.listAudit({ limit: 500 })
  const copilotEntry = audit.find((candidate) =>
    candidate.actor === 'copilot' &&
    candidate.action === END_CALL_AUDIT_ACTION &&
    candidate.callId === callId
  )
  const reason = (copilotEntry?.details as { reason?: unknown } | undefined)?.reason
  const normalizedReason = reason === 'completed' || reason === 'callee_requested' || reason === 'policy'
    ? reason
    : undefined
  const externalEntry = audit.find((candidate) => {
    const details = candidate.details as { command?: unknown } | undefined
    return candidate.callId === callId &&
      candidate.action === 'phone.command' &&
      details?.command === 'hangup' &&
      (candidate.actor === 'copilot' || candidate.actor === 'http' || candidate.actor === 'mcp')
  })
  return {
    endedByAgent: Boolean(copilotEntry || externalEntry),
    ...(normalizedReason ? { reason: normalizedReason } : {})
  }
}
