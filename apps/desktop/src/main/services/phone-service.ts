import type { PhoneCommand, PhoneCommandResult, PhoneStatusSnapshot } from '../../shared/contracts.js'
import type { DesktopTelephonyGateway, EngineTelephony } from '../telephony/index.js'
import type { ApprovalService, ApprovalCreateResult } from './approval-service.js'
import type { CampaignService } from './campaign-service.js'
import type { TaskService } from './task-service.js'
import { ServiceError } from './service-error.js'

type PhoneTelephony = EngineTelephony | DesktopTelephonyGateway

/** True when the renderer snapshot already occupies the single desktop call slot. */
export function statusHasActiveCall(status: PhoneStatusSnapshot): boolean {
  return Boolean(status.call && status.call.status !== 'ended' && status.call.status !== 'error')
}

export interface DialRequest {
  peer: string
  campaignId?: string
  goal?: string
  idempotencyKey: string
  actor: 'mcp' | 'http' | 'debug'
}

export interface PendingDial {
  approvalId: string
  completion: Promise<PhoneStatusSnapshot>
}

/** HTTP/MCP facade over TelephonyPort. Desktop wires DesktopTelephonyAdapter. */
export class PhoneService {
  private readonly dialResults = new Map<string, PendingDial>()
  private readonly dialTimes: number[] = []
  private readonly peerDialTimes = new Map<string, number>()
  private dialPending = false
  private callLease = false

  constructor(
    private readonly telephony: PhoneTelephony,
    private readonly campaigns: CampaignService,
    private readonly approvals: ApprovalService,
    private readonly now: () => number = Date.now,
    private readonly taskService?: TaskService
  ) {}

  status(): PhoneStatusSnapshot { return this.telephony.getStatus() }

  startDial(input: DialRequest): PendingDial {
    if (this.taskService) {
      const pending = this.taskService.startManagedDial({
        peer: input.peer,
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        ...(input.goal ? { goal: input.goal } : {}),
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        requireApproval: true
      })
      if (!pending.approvalId) throw new ServiceError('INTERNAL_ERROR', 'Approval request was not created')
      return { approvalId: pending.approvalId, completion: pending.completion }
    }
    if (!input.idempotencyKey.trim()) throw new ServiceError('INVALID_ARGUMENT', 'idempotencyKey is required')
    const existing = this.dialResults.get(input.idempotencyKey)
    if (existing) return existing
    const peer = normalizeE164(input.peer)
    const status = this.telephony.getStatus()
    if (statusHasActiveCall(status)) {
      throw new ServiceError('CALL_IN_PROGRESS', 'A call is already in progress')
    }
    if (!status.call) this.callLease = false
    if (this.dialPending || this.callLease) {
      throw new ServiceError('CALL_IN_PROGRESS', 'A managed call is already pending or leased')
    }
    this.checkRateLimit(peer)
    const workspace = this.campaigns.workspace({ reveal: true })
    const campaignId = input.campaignId ?? workspace.selectedCampaignId
    const campaign = workspace.campaigns.find((item) => item.id === campaignId)
    if (!campaign) throw new ServiceError('NOT_FOUND', 'Campaign not found')

    this.dialPending = true
    const approval = this.approvals.create({
      kind: 'call_dial',
      title: 'Approve outbound call',
      summary: `Allow calling ${peer}?`,
      details: { peer, campaign: campaign.name, estimatedCost: 'Determined by Twilio rates' },
      requestedBy: input.actor
    })
    const pending: PendingDial = {
      approvalId: approval.request.id,
      completion: this.completeDial(approval, peer, campaign.id, input.actor, input.goal)
    }
    this.dialResults.set(input.idempotencyKey, pending)
    return pending
  }

  async dial(input: DialRequest): Promise<PhoneStatusSnapshot> {
    return this.startDial(input).completion
  }

  hangup(actor: DialRequest['actor'] | 'copilot'): Promise<PhoneStatusSnapshot> { return this.send({ type: 'hangup' }, actor) }
  answer(actor: DialRequest['actor']): Promise<PhoneStatusSnapshot> { return this.send({ type: 'answer' }, actor) }
  reject(actor: DialRequest['actor']): Promise<PhoneStatusSnapshot> { return this.send({ type: 'reject' }, actor) }
  simulateIncoming(peer: string | undefined, actor: DialRequest['actor']): Promise<PhoneStatusSnapshot> {
    return this.send({ type: 'simulateIncoming', ...(peer ? { peer } : {}) }, actor)
  }
  setControlMode(mode: 'ai' | 'human', actor: DialRequest['actor']): Promise<PhoneStatusSnapshot> {
    return this.send({ type: 'setControlMode', mode }, actor)
  }

  private async completeDial(approval: ApprovalCreateResult, peer: string, campaignId: string, actor: DialRequest['actor'], goal?: string): Promise<PhoneStatusSnapshot> {
    try {
      const outcome = await approval.outcome
      if (!outcome.approved) {
        throw new ServiceError(outcome.code, outcome.code === 'APPROVAL_TIMEOUT'
          ? 'Local approval timed out'
          : outcome.code === 'APP_NOT_READY' ? 'Approval service is unavailable' : 'Local approval was denied')
      }
      const status = await this.send({ type: 'dial', peer, campaignId, ...(goal ? { goal } : {}) }, actor)
      const now = this.now()
      this.dialTimes.push(now)
      this.peerDialTimes.set(peer, now)
      this.callLease = true
      return status
    } finally {
      this.dialPending = false
    }
  }

  private async send(command: PhoneCommand, actor: DialRequest['actor'] | 'copilot'): Promise<PhoneStatusSnapshot> {
    const result = await executeTelephony(this.telephony, command, actor)
    if (!result.ok) throw commandError(result)
    if (command.type === 'hangup') this.callLease = false
    return result.status
  }

  private checkRateLimit(peer: string): void {
    const now = this.now()
    const minuteAgo = now - 60_000
    while (this.dialTimes[0] !== undefined && this.dialTimes[0] < minuteAgo) this.dialTimes.shift()
    if (this.dialTimes.length >= 3) throw new ServiceError('RATE_LIMITED', 'At most 3 calls are allowed per minute')
    const peerAt = this.peerDialTimes.get(peer)
    if (peerAt !== undefined && peerAt > now - 10 * 60_000) {
      throw new ServiceError('RATE_LIMITED', 'The same number may only be called once every 10 minutes')
    }
  }
}

function executeTelephony(
  telephony: PhoneTelephony,
  command: PhoneCommand,
  actor: string
): Promise<PhoneCommandResult> {
  if ('execute' in telephony && typeof telephony.execute === 'function') {
    return telephony.execute(command, { actor })
  }
  return (telephony as DesktopTelephonyGateway).send(command, { actor })
}

function commandError(result: Extract<PhoneCommandResult, { ok: false }>): ServiceError {
  return new ServiceError(result.code, result.message)
}

function normalizeE164(value: string): string {
  if (typeof value !== 'string') throw new ServiceError('INVALID_NUMBER', 'peer must be an E.164 phone number')
  const normalized = value.replace(/[\s().-]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new ServiceError('INVALID_NUMBER', 'peer must be an E.164 phone number')
  return normalized
}
