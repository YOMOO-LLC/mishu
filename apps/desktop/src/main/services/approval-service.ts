import { randomUUID } from 'node:crypto'
import type { ApprovalDecision, ApprovalKind, ApprovalRequest } from '../../shared/contracts.js'

export type ApprovalOutcome =
  | { approved: true; decision: ApprovalDecision }
  | { approved: false; code: 'APPROVAL_DENIED' | 'APPROVAL_TIMEOUT' | 'APP_NOT_READY' }

interface PendingApproval {
  request: ApprovalRequest
  timer: ReturnType<typeof setTimeout>
  resolve(outcome: ApprovalOutcome): void
}

export interface ApprovalCreateInput {
  kind: ApprovalKind
  title: string
  summary: string
  details: Record<string, unknown>
  requestedBy: string
}

export interface ApprovalCreateResult {
  request: ApprovalRequest
  outcome: Promise<ApprovalOutcome>
}

/** Host-agnostic approval decision core. No window or IPC. */
export interface ApprovalDecider {
  create(input: ApprovalCreateInput): ApprovalCreateResult
  listPending(): ApprovalRequest[]
  decide(decision: ApprovalDecision): boolean
  dispose(): void
}

export interface ApprovalServiceOptions {
  timeoutMs?: number
  onRequested?(request: ApprovalRequest): void
  onSettled?(request: ApprovalRequest, outcome: ApprovalOutcome): void
}

export class ApprovalService implements ApprovalDecider {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly requestedListeners = new Set<(request: ApprovalRequest) => void>()
  private readonly settledListeners = new Set<(request: ApprovalRequest, outcome: ApprovalOutcome) => void>()
  private readonly timeoutMs: number

  constructor(private readonly options: ApprovalServiceOptions = {}) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 60_000)
  }

  create(input: ApprovalCreateInput): ApprovalCreateResult {
    return this.createRequest({
      id: randomUUID(),
      ...input,
      expiresAt: Date.now() + this.timeoutMs
    })
  }

  requestExisting(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return this.createRequest(request).outcome
  }

  private createRequest(request: ApprovalRequest): ApprovalCreateResult {
    if (!request || typeof request.id !== 'string' || !request.id.trim()) {
      return this.create({
        kind: request?.kind ?? 'call_dial',
        title: request?.title ?? 'Approval',
        summary: request?.summary ?? '',
        details: request?.details ?? {},
        requestedBy: request?.requestedBy ?? 'unknown'
      })
    }
    if (this.pending.has(request.id)) throw new Error('Approval request already exists')
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timeoutMs = Math.max(1, request.expiresAt - Date.now())
      const timer = setTimeout(() => this.settle(request.id, {
        approved: false,
        code: 'APPROVAL_TIMEOUT'
      }), timeoutMs)
      this.pending.set(request.id, { request, timer, resolve })
    })
    this.options.onRequested?.(request)
    for (const listener of this.requestedListeners) listener(request)
    return { request, outcome }
  }

  onRequested(listener: (request: ApprovalRequest) => void): () => void {
    this.requestedListeners.add(listener)
    return () => this.requestedListeners.delete(listener)
  }

  onSettled(listener: (request: ApprovalRequest, outcome: ApprovalOutcome) => void): () => void {
    this.settledListeners.add(listener)
    return () => this.settledListeners.delete(listener)
  }

  request(input: Parameters<ApprovalService['create']>[0]): Promise<ApprovalOutcome> {
    return this.create(input).outcome
  }

  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ request }) => ({
      ...request,
      details: { ...request.details }
    }))
  }

  decide(decision: ApprovalDecision): boolean {
    const item = this.pending.get(decision?.id)
    if (!item) return false
    if (Date.now() > item.request.expiresAt || decision.decidedAt > item.request.expiresAt) {
      this.settle(item.request.id, { approved: false, code: 'APPROVAL_TIMEOUT' })
      return true
    }
    this.settle(item.request.id, decision.approved
      ? { approved: true, decision }
      : { approved: false, code: 'APPROVAL_DENIED' })
    return true
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { approved: false, code: 'APP_NOT_READY' })
    }
  }

  private settle(id: string, outcome: ApprovalOutcome): void {
    const item = this.pending.get(id)
    if (!item) return
    this.pending.delete(id)
    clearTimeout(item.timer)
    item.resolve(outcome)
    this.options.onSettled?.(item.request, outcome)
    for (const listener of this.settledListeners) listener(item.request, outcome)
  }
}
