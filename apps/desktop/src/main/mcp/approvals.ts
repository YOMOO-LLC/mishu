import type { BrowserWindow, IpcMain } from 'electron'
import type { ApprovalDecision, ApprovalRequest } from '../../shared/contracts.js'
import {
  ApprovalService,
  type ApprovalCreateInput,
  type ApprovalCreateResult,
  type ApprovalDecider,
  type ApprovalOutcome
} from '../services/approval-service.js'
import { DesktopApprovalPresenter } from './desktop-approval-presenter.js'

export type { ApprovalOutcome } from '../services/approval-service.js'

export interface ApprovalManagerOptions {
  ipcMain: Pick<IpcMain, 'on' | 'removeListener'>
  getWindow(): BrowserWindow | undefined
  timeoutMs?: number
  service?: ApprovalService
}

/**
 * Desktop approval host: headless ApprovalService plus the BrowserWindow
 * modal presenter. ApprovalService.decide still works with no window.
 */
export class ApprovalManager implements ApprovalDecider {
  readonly service: ApprovalService
  private readonly ownsService: boolean
  private readonly presenter: DesktopApprovalPresenter

  constructor(options: ApprovalManagerOptions) {
    this.ownsService = !options.service
    this.service = options.service ?? new ApprovalService({ timeoutMs: options.timeoutMs })
    this.presenter = new DesktopApprovalPresenter({
      ipcMain: options.ipcMain,
      getWindow: options.getWindow,
      service: this.service
    })
  }

  create(input: ApprovalCreateInput): ApprovalCreateResult {
    return this.service.create(input)
  }

  request(input: Parameters<ApprovalService['request']>[0]): Promise<ApprovalOutcome> {
    return this.service.request(input)
  }

  async requestExisting(request: ApprovalRequest): Promise<ApprovalDecision> {
    const outcome = await this.service.requestExisting(request)
    return outcome.approved
      ? outcome.decision
      : { id: request.id, approved: false, decidedAt: Date.now() }
  }

  listPending(): ApprovalRequest[] { return this.service.listPending() }

  decide(decision: ApprovalDecision): boolean { return this.service.decide(decision) }

  dispose(): void {
    this.presenter.dispose()
    if (this.ownsService) this.service.dispose()
  }
}
