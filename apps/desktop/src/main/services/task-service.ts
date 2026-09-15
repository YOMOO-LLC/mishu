import { randomUUID } from 'node:crypto'
import { evaluateDialGuard } from '@mishu/core/policy'
import type {
  CallTask,
  CallTaskInclude,
  CallTaskCreator,
  CallTaskStatus,
  CallTaskSubmitInput,
  ContactCardInput,
  ListCallTasksRequest,
  PhoneCommandResult,
  PhoneStatusSnapshot
} from '../../shared/contracts.js'
import { REALTIME_VOICES } from '../../shared/contracts.js'
import { maskPhoneNumber } from '../../shared/phone-mask.js'
import type { CallStore } from '../call-store.js'
import type { PhoneCommandGateway } from '../phone-gateway.js'
import type { WebhookBridge } from '../webhook/bridge.js'
import { compileResultSchema } from '../analysis/schema.js'
import type { ApprovalCreateResult, ApprovalService } from './approval-service.js'
import type { CampaignService } from './campaign-service.js'
import type { ContactService } from './contact-service.js'
import type { CallService } from './call-service.js'
import { ServiceError } from './service-error.js'

const TERMINAL_STATUSES: ReadonlySet<CallTaskStatus> = new Set(['completed', 'failed', 'cancelled'])
const TRANSITIONS: Record<CallTaskStatus, ReadonlySet<CallTaskStatus>> = {
  queued: new Set(['awaiting_approval', 'dialing', 'failed', 'cancelled']),
  awaiting_approval: new Set(['dialing', 'failed', 'cancelled']),
  dialing: new Set(['in_call', 'queued', 'failed', 'cancelled']),
  in_call: new Set(['analyzing', 'queued', 'completed', 'failed', 'cancelled']),
  analyzing: new Set(['queued', 'completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
}

export type ManagedDialActor = CallTaskCreator | 'debug'

export interface ManagedDialRequest {
  peer: string
  campaignId?: string
  goal?: string
  idempotencyKey: string
  actor: ManagedDialActor
  requireApproval: boolean
  bypassPeerCooldown?: boolean
}

export interface PendingManagedDial {
  approvalId?: string
  completion: Promise<PhoneStatusSnapshot>
}

export interface TaskServiceOptions {
  store: CallStore
  campaigns: CampaignService
  approvals: ApprovalService
  gateway: PhoneCommandGateway
  webhookBridge?: WebhookBridge
  contacts?: ContactService
  calls?: CallService
  now?: () => number
}

export class TaskService {
  private readonly listeners = new Set<(task: CallTask) => void>()
  private readonly submittedListeners = new Set<() => void>()
  private readonly dialResults = new Map<string, PendingManagedDial>()
  private readonly dialTimes: number[] = []
  private readonly peerDialTimes = new Map<string, number>()
  private readonly now: () => number
  private dialPending = false
  private callLease = false
  private cancelHandler?: (task: CallTask) => void | Promise<void>

  constructor(private readonly options: TaskServiceOptions) {
    this.now = options.now ?? Date.now
    options.store.onEvent((event) => {
      if (event.type === 'call.ended') this.callLease = false
    })
  }

  submit(input: CallTaskSubmitInput, actor: CallTaskCreator = input.createdBy ?? 'http'): CallTask {
    const idempotencyKey = normalizeIdempotencyKey(input)
    const existing = this.options.store.getCallTaskByIdempotencyKey(idempotencyKey)
    if (existing) return maskTask(existing)
    const id = randomUUID()
    const normalized = this.normalizeSubmit({ ...input, idempotencyKey }, actor, id)
    if (input.contact !== undefined) {
      const contact = normalizeInlineContact(input.contact, normalized.to)
      if (!this.options.contacts) throw new ServiceError('APP_NOT_READY', 'Contact service is unavailable')
      this.options.contacts.upsert(contact)
    }
    const now = this.now()
    const task = this.options.store.createCallTask({
      id,
      ...normalized,
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now
    })
    this.publish(task)
    for (const listener of this.submittedListeners) listener()
    return maskTask(task)
  }

  get(id: unknown, options: { reveal?: boolean; include?: CallTaskInclude[] } = {}): CallTask {
    if (typeof id !== 'string' || !id.trim()) throw new ServiceError('INVALID_ARGUMENT', 'taskId is required')
    const task = this.options.store.getCallTask(id.trim())
    if (!task) throw new ServiceError('NOT_FOUND', 'Task not found')
    return this.decorate(options.reveal ? task : maskTask(task), options)
  }

  list(request: ListCallTasksRequest = {}, options: { reveal?: boolean } = {}): CallTask[] {
    const tasks = this.options.store.listCallTasks(request)
    return options.reveal ? tasks : tasks.map(maskTask)
  }

  async wait(
    id: unknown,
    timeoutMs = 30_000,
    options: { reveal?: boolean; include?: CallTaskInclude[] } = {}
  ): Promise<CallTask> {
    const current = this.get(id, { reveal: true })
    if (TERMINAL_STATUSES.has(current.status) || timeoutMs <= 0) {
      return this.decorate(options.reveal ? current : maskTask(current), options)
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (task: CallTask): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(this.decorate(options.reveal ? task : maskTask(task), options))
      }
      const listener = (task: CallTask): void => {
        if (task.id === current.id && TERMINAL_STATUSES.has(task.status)) finish(task)
      }
      const timer = setTimeout(() => finish(this.get(current.id, { reveal: true })), Math.min(300_000, Math.max(1, timeoutMs)))
      this.listeners.add(listener)
    })
  }

  private decorate(task: CallTask, options: { reveal?: boolean; include?: CallTaskInclude[] }): CallTask {
    if (!task.callId || !options.include?.length || !this.options.calls) return task
    const include = new Set(options.include)
    const call = this.options.calls.find(task.callId, { reveal: options.reveal })
    if (!call) return task
    return {
      ...task,
      ...(include.has('transcript')
        ? { transcript: this.options.calls.transcript(task.callId, { reveal: options.reveal }) }
        : {}),
      ...(include.has('analysis') && task.resultId
        ? { analysis: this.options.calls.analysis(task.callId) }
        : {}),
      ...(include.has('call')
        ? { call }
        : {})
    }
  }

  cancel(id: unknown): CallTask {
    const task = this.get(id, { reveal: true })
    if (TERMINAL_STATUSES.has(task.status)) return maskTask(task)
    const cancelled = this.transition(task.id, 'cancelled', { endedAt: this.now(), error: undefined })
    void this.cancelHandler?.(cancelled)
    return maskTask(cancelled)
  }

  transition(id: string, status: CallTaskStatus, patch: Partial<CallTask> = {}): CallTask {
    const current = this.get(id, { reveal: true })
    if (current.status !== status && !TRANSITIONS[current.status].has(status)) {
      throw new ServiceError('CONFLICT', `Task cannot transition from ${current.status} to ${status}`)
    }
    const now = this.now()
    const task = this.options.store.updateCallTask(id, {
      ...patch,
      status,
      updatedAt: now,
      ...(status === 'dialing' && current.startedAt === undefined ? { startedAt: now } : {}),
      ...(TERMINAL_STATUSES.has(status) && patch.endedAt === undefined ? { endedAt: now } : {})
    })
    this.publish(task)
    return task
  }

  queued(): CallTask[] {
    return this.options.store.listQueuedCallTasks()
  }

  onSubmitted(listener: () => void): () => void {
    this.submittedListeners.add(listener)
    return () => this.submittedListeners.delete(listener)
  }

  setCancelHandler(handler: (task: CallTask) => void | Promise<void>): void {
    this.cancelHandler = handler
  }

  startManagedDial(input: ManagedDialRequest): PendingManagedDial {
    if (!input.idempotencyKey.trim()) throw new ServiceError('INVALID_ARGUMENT', 'idempotencyKey is required')
    const existing = this.dialResults.get(input.idempotencyKey)
    if (existing) return existing
    const peer = normalizeE164(input.peer)
    const status = this.options.gateway.getStatus()
    if (status.call && status.call.status !== 'ended' && status.call.status !== 'error') {
      throw new ServiceError('CALL_IN_PROGRESS', 'A call is already in progress')
    }
    if (!status.call) this.callLease = false
    if (this.dialPending || this.callLease) {
      throw new ServiceError('CALL_IN_PROGRESS', 'A managed call is already pending or leased')
    }
    this.checkRateLimit(peer, input.bypassPeerCooldown === true)
    const campaignId = input.campaignId
      ?? this.options.campaigns.workspace({ reveal: true }).selectedCampaignId
    const campaign = this.options.campaigns.get(campaignId, { reveal: true })
    if (campaign.direction === 'inbound') throw new ServiceError('GUARDRAIL_BLOCKED', 'Campaign cannot place outbound calls')
    const guard = evaluateDialGuard(campaign.policy, peer, this.now())
    if (!guard.allowed) throw new ServiceError('GUARDRAIL_BLOCKED', guard.message)

    this.dialPending = true
    let approval: ApprovalCreateResult | undefined
    if (input.requireApproval) {
      approval = this.options.approvals.create({
        kind: 'call_dial',
        title: 'Approve outbound call',
        summary: `Allow calling ${peer}?`,
        details: { peer, campaign: campaign.name, estimatedCost: 'Determined by Twilio rates' },
        requestedBy: input.actor
      })
    }
    const pending: PendingManagedDial = {
      ...(approval ? { approvalId: approval.request.id } : {}),
      completion: this.completeDial(approval, peer, campaign.id, input)
    }
    this.dialResults.set(input.idempotencyKey, pending)
    return pending
  }

  private async completeDial(
    approval: ApprovalCreateResult | undefined,
    peer: string,
    campaignId: string,
    input: ManagedDialRequest
  ): Promise<PhoneStatusSnapshot> {
    try {
      if (approval) {
        const outcome = await approval.outcome
        if (!outcome.approved) {
          throw new ServiceError(outcome.code, outcome.code === 'APPROVAL_TIMEOUT'
            ? 'Local approval timed out'
            : outcome.code === 'APP_NOT_READY' ? 'Approval service is unavailable' : 'Local approval was denied')
        }
      }
      const result = await this.options.gateway.send({
        type: 'dial',
        peer,
        campaignId,
        ...(input.goal?.trim() ? { goal: input.goal.trim() } : {})
      }, { actor: input.actor })
      if (!result.ok) throw commandError(result)
      const now = this.now()
      this.dialTimes.push(now)
      this.peerDialTimes.set(peer, now)
      this.callLease = Boolean(result.status.call && !['ended', 'error'].includes(result.status.call.status))
      return result.status
    } finally {
      this.dialPending = false
    }
  }

  private normalizeSubmit(
    input: CallTaskSubmitInput,
    actor: CallTaskCreator,
    taskId: string
  ): Omit<CallTask, 'id' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'> {
    if (!input || typeof input !== 'object') throw new ServiceError('INVALID_ARGUMENT', 'Task input is required')
    const to = normalizeE164(input.to)
    const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
    if (!goal || goal.length > 8_000) throw new ServiceError('INVALID_ARGUMENT', 'goal is required and must be at most 8000 characters')
    const idempotencyKey = normalizeIdempotencyKey(input)
    if (input.campaignId !== undefined && input.campaign !== undefined) {
      throw new ServiceError('INVALID_ARGUMENT', 'campaignId and campaign are mutually exclusive')
    }
    if (input.resultSchema !== undefined) {
      try { compileResultSchema(input.resultSchema) }
      catch (error) { throw new ServiceError('UNPROCESSABLE_ENTITY', error instanceof Error ? error.message : String(error)) }
    }
    const constraints = normalizeConstraints(input.constraints)
    const callbackUrl = normalizeCallbackUrl(input.callbackUrl)
    const workspace = this.options.campaigns.workspace({ reveal: true })
    let campaignId = input.campaignId ?? workspace.selectedCampaignId
    if (input.campaign !== undefined) {
      const campaign = input.campaign
      if (!campaign || typeof campaign !== 'object' || Array.isArray(campaign)) {
        throw new ServiceError('INVALID_ARGUMENT', 'campaign must be an object')
      }
      if (campaign.direction !== 'outbound') {
        throw new ServiceError('INVALID_ARGUMENT', 'campaign.direction must be outbound')
      }
      const systemPrompt = typeof campaign.systemPrompt === 'string' ? campaign.systemPrompt.trim() : ''
      const persona = typeof campaign.policy?.persona === 'string' ? campaign.policy.persona.trim() : ''
      if ((!systemPrompt && !persona) || systemPrompt.length > 8_000) {
        throw new ServiceError(
          'INVALID_ARGUMENT',
          'campaign.systemPrompt or campaign.policy.persona is required; systemPrompt must be at most 8000 characters'
        )
      }
      let name = `Task ${taskId.slice(0, 8)}`
      if (campaign.name !== undefined) {
        if (typeof campaign.name !== 'string' || !campaign.name.trim() || campaign.name.trim().length > 80) {
          throw new ServiceError(
            'INVALID_ARGUMENT',
            'campaign.name must be a non-empty string of at most 80 characters'
          )
        }
        name = campaign.name.trim()
      }
      const defaultCampaign = workspace.campaigns.find(({ id }) => id === workspace.selectedCampaignId)
      try {
        campaignId = this.options.campaigns.createEphemeral({
          name,
          direction: 'outbound',
          systemPrompt,
          voice: campaign.voice ?? defaultCampaign?.voice ?? REALTIME_VOICES[0],
          ...(campaign.policy ? { policy: campaign.policy } : {})
        }).id
      } catch (error) {
        if (error instanceof ServiceError) throw error
        throw new ServiceError(
          'INVALID_ARGUMENT',
          error instanceof Error ? error.message : 'Inline campaign is invalid'
        )
      }
    } else {
      this.options.campaigns.get(campaignId, { reveal: true })
    }
    return {
      to,
      campaignId,
      goal,
      ...(input.resultSchema ? { resultSchema: input.resultSchema } : {}),
      constraints,
      ...(callbackUrl ? { callbackUrl } : {}),
      idempotencyKey,
      createdBy: actor
    }
  }

  private checkRateLimit(peer: string, bypassPeerCooldown: boolean): void {
    const now = this.now()
    const minuteAgo = now - 60_000
    while (this.dialTimes[0] !== undefined && this.dialTimes[0] < minuteAgo) this.dialTimes.shift()
    if (this.dialTimes.length >= 3) throw new ServiceError('RATE_LIMITED', 'At most 3 calls are allowed per minute')
    const peerAt = this.peerDialTimes.get(peer)
    if (!bypassPeerCooldown && peerAt !== undefined && peerAt > now - 10 * 60_000) {
      throw new ServiceError('RATE_LIMITED', 'The same number may only be called once every 10 minutes')
    }
  }

  private publish(task: CallTask): void {
    for (const listener of this.listeners) listener(task)
    const event = task.status === 'queued' && task.attempts === 0
      ? 'task.queued'
      : task.status === 'dialing'
        ? 'task.started'
        : task.status === 'completed'
          ? 'task.completed'
          : task.status === 'failed'
            ? 'task.failed'
            : task.status === 'cancelled'
              ? 'task.cancelled'
              : undefined
    if (event) this.options.webhookBridge?.publishTaskEvent(event, task)
  }
}

function normalizeIdempotencyKey(input: CallTaskSubmitInput): string {
  if (!input || typeof input !== 'object') {
    throw new ServiceError('INVALID_ARGUMENT', 'Task input is required')
  }
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : ''
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new ServiceError('INVALID_ARGUMENT', 'idempotencyKey is required')
  }
  return idempotencyKey
}

function normalizeInlineContact(
  contact: CallTaskSubmitInput['contact'],
  taskPhone: string
): ContactCardInput {
  if (!contact || typeof contact !== 'object' || Array.isArray(contact)) {
    throw new ServiceError('INVALID_ARGUMENT', 'contact must be an object')
  }
  if (contact.phone !== undefined && normalizeE164(contact.phone) !== taskPhone) {
    throw new ServiceError('INVALID_ARGUMENT', 'contact.phone must match task to')
  }
  return { ...contact, phone: taskPhone }
}

function normalizeConstraints(value: CallTaskSubmitInput['constraints']): CallTask['constraints'] {
  if (value === undefined) return { maxAttempts: 1 }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('INVALID_ARGUMENT', 'constraints must be an object')
  const output: CallTask['constraints'] = {}
  if (value.maxDurationSec !== undefined) {
    if (!Number.isInteger(value.maxDurationSec) || value.maxDurationSec < 30 || value.maxDurationSec > 3_600) {
      throw new ServiceError('INVALID_ARGUMENT', 'constraints.maxDurationSec must be an integer from 30 to 3600')
    }
    output.maxDurationSec = value.maxDurationSec
  }
  for (const key of ['notBefore', 'notAfter'] as const) {
    const raw = value[key]
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) throw new ServiceError('INVALID_ARGUMENT', `constraints.${key} must be an ISO date-time`)
      output[key] = new Date(raw).toISOString()
    }
  }
  if (output.notBefore && output.notAfter && Date.parse(output.notBefore) >= Date.parse(output.notAfter)) {
    throw new ServiceError('INVALID_ARGUMENT', 'constraints.notBefore must be before notAfter')
  }
  const maxAttempts = value.maxAttempts ?? 1
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4) {
    throw new ServiceError('INVALID_ARGUMENT', 'constraints.maxAttempts must be an integer from 1 to 4')
  }
  output.maxAttempts = maxAttempts
  if (value.allowedToolIds !== undefined) {
    if (!Array.isArray(value.allowedToolIds) || value.allowedToolIds.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new ServiceError('INVALID_ARGUMENT', 'constraints.allowedToolIds must be a string array')
    }
    output.allowedToolIds = [...new Set(value.allowedToolIds.map((item) => item.trim()))].slice(0, 100)
  }
  return output
}

function normalizeCallbackUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ServiceError('INVALID_ARGUMENT', 'callbackUrl must be a URL')
  let url: URL
  try { url = new URL(value) }
  catch { throw new ServiceError('INVALID_ARGUMENT', 'callbackUrl must be a URL') }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) {
    throw new ServiceError('INVALID_ARGUMENT', 'callbackUrl must use https or loopback http')
  }
  return url.toString()
}

function normalizeE164(value: unknown): string {
  if (typeof value !== 'string') throw new ServiceError('INVALID_NUMBER', 'to must be an E.164 phone number')
  const normalized = value.replace(/[\s().-]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new ServiceError('INVALID_NUMBER', 'to must be an E.164 phone number')
  return normalized
}

function commandError(result: Extract<PhoneCommandResult, { ok: false }>): ServiceError {
  return new ServiceError(result.code, result.message)
}

function maskTask(task: CallTask): CallTask {
  return { ...task, to: maskPhoneNumber(task.to) }
}

export function isTerminalTaskStatus(status: CallTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}
