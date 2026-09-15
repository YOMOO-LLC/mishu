import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { IPC, type ApprovalDecision, type ApprovalRequest } from '../../shared/contracts.js'
import type { ApprovalService } from '../services/approval-service.js'

export interface DesktopApprovalPresenterOptions {
  ipcMain: Pick<IpcMain, 'on' | 'removeListener'>
  getWindow(): BrowserWindow | undefined
  service: ApprovalService
}

/**
 * Desktop-only presenter. Shows the BrowserWindow approval modal and
 * forwards renderer IPC decisions into the headless ApprovalService.
 */
export class DesktopApprovalPresenter {
  private readonly unsubscribeRequested: () => void
  private readonly unsubscribeSettled: () => void

  constructor(private readonly options: DesktopApprovalPresenterOptions) {
    this.unsubscribeRequested = options.service.onRequested(this.showRequest)
    this.unsubscribeSettled = options.service.onSettled(() => {
      const window = this.options.getWindow()
      if (window && !window.isDestroyed()) window.flashFrame(false)
    })
    options.ipcMain.on(IPC.respondApproval, this.handleDecision)
  }

  dispose(): void {
    this.options.ipcMain.removeListener(IPC.respondApproval, this.handleDecision)
    this.unsubscribeRequested()
    this.unsubscribeSettled()
    const window = this.options.getWindow()
    if (window && !window.isDestroyed()) window.flashFrame(false)
  }

  private readonly showRequest = (request: ApprovalRequest): void => {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.show()
    window.focus()
    window.flashFrame(true)
    window.webContents.send(IPC.approvalRequested, request)
  }

  private readonly handleDecision = (event: IpcMainEvent, decision: ApprovalDecision): void => {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return
    this.options.service.decide(decision)
  }
}
