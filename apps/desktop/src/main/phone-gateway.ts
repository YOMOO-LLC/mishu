import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMain, IpcMainEvent, WebContents } from 'electron'
import {
  IPC,
  type PhoneCommand,
  type PhoneCommandErrorCode,
  type PhoneCommandRequest,
  type PhoneCommandResult,
  type PhoneStatusSnapshot
} from '../shared/contracts.js'

interface PhoneCommandAudit {
  writeAudit(actor: string, action: string, callId: string | undefined, details?: unknown): void
}

export interface PhoneCommandGatewayOptions {
  ipcMain: Pick<IpcMain, 'on' | 'removeListener'>
  getWindow(): BrowserWindow | undefined
  audit: PhoneCommandAudit
}

export interface PhoneCommandSendOptions {
  actor: string
  timeoutMs?: number
}

interface PendingCommand {
  requestId: string
  resolve(result: PhoneCommandResult): void
  timer: ReturnType<typeof setTimeout>
}

export class PhoneCommandGatewayError extends Error {
  constructor(readonly code: PhoneCommandErrorCode, message: string) {
    super(message)
    this.name = 'PhoneCommandGatewayError'
  }
}

export class PhoneCommandGateway {
  private readonly ipcMain: PhoneCommandGatewayOptions['ipcMain']
  private readonly getWindow: PhoneCommandGatewayOptions['getWindow']
  private readonly audit: PhoneCommandAudit
  private readonly pending = new Map<string, PendingCommand>()
  private latestStatus?: PhoneStatusSnapshot
  private renderer?: WebContents

  constructor(options: PhoneCommandGatewayOptions) {
    this.ipcMain = options.ipcMain
    this.getWindow = options.getWindow
    this.audit = options.audit
    this.ipcMain.on(IPC.respondPhoneCommand, this.handleResult)
    this.ipcMain.on(IPC.publishPhoneStatus, this.handleStatus)
  }

  send(
    command: PhoneCommand,
    { actor, timeoutMs = 10_000 }: PhoneCommandSendOptions
  ): Promise<PhoneCommandResult> {
    const requestId = randomUUID()
    const window = this.getWindow()
    const webContents = window?.webContents
    this.audit.writeAudit(actor, 'phone.command', this.latestStatus?.call?.id, {
      requestId,
      command: command.type
    })
    if (
      !window ||
      window.isDestroyed() ||
      !webContents ||
      webContents.isDestroyed() ||
      webContents.isLoadingMainFrame() ||
      !this.latestStatus
    ) {
      return Promise.resolve(failure(requestId, 'APP_NOT_READY', 'Phone renderer is not ready'))
    }

    this.attachRenderer(webContents)
    const request: PhoneCommandRequest = { requestId, command, issuedAt: Date.now() }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(failure(requestId, 'TIMEOUT', 'Phone renderer did not respond before timeout'))
      }, Math.max(1, timeoutMs))
      this.pending.set(requestId, { requestId, resolve, timer })
      webContents.send(IPC.phoneCommand, request)
    })
  }

  getStatus(): PhoneStatusSnapshot {
    if (!this.latestStatus) {
      throw new PhoneCommandGatewayError('APP_NOT_READY', 'Phone renderer has not published status')
    }
    return this.latestStatus
  }

  dispose(): void {
    this.ipcMain.removeListener(IPC.respondPhoneCommand, this.handleResult)
    this.ipcMain.removeListener(IPC.publishPhoneStatus, this.handleStatus)
    this.detachRenderer()
    this.settlePending('APP_NOT_READY', 'Phone command gateway was disposed')
    this.latestStatus = undefined
  }

  private readonly handleResult = (event: IpcMainEvent, result: PhoneCommandResult): void => {
    if (!this.isCurrentRenderer(event.sender) || !result || typeof result.requestId !== 'string') return
    const pending = this.pending.get(result.requestId)
    if (!pending) return
    this.pending.delete(result.requestId)
    clearTimeout(pending.timer)
    if (result.ok) this.latestStatus = result.status
    pending.resolve(result)
  }

  private readonly handleStatus = (event: IpcMainEvent, status: PhoneStatusSnapshot): void => {
    const window = this.getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return
    this.attachRenderer(event.sender)
    this.latestStatus = status
  }

  private attachRenderer(webContents: WebContents): void {
    if (this.renderer === webContents) return
    this.detachRenderer()
    this.renderer = webContents
    webContents.on('did-start-loading', this.handleRendererUnavailable)
    webContents.on('render-process-gone', this.handleRendererUnavailable)
    webContents.on('destroyed', this.handleRendererUnavailable)
  }

  private detachRenderer(): void {
    this.renderer?.removeListener('did-start-loading', this.handleRendererUnavailable)
    this.renderer?.removeListener('render-process-gone', this.handleRendererUnavailable)
    this.renderer?.removeListener('destroyed', this.handleRendererUnavailable)
    this.renderer = undefined
  }

  private readonly handleRendererUnavailable = (): void => {
    this.latestStatus = undefined
    this.settlePending('APP_NOT_READY', 'Phone renderer reloaded or became unavailable')
  }

  private isCurrentRenderer(sender: WebContents): boolean {
    const window = this.getWindow()
    return Boolean(window && !window.isDestroyed() && sender === window.webContents)
  }

  private settlePending(code: PhoneCommandErrorCode, message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(failure(pending.requestId, code, message))
    }
    this.pending.clear()
  }
}

function failure(
  requestId: string,
  code: PhoneCommandErrorCode,
  message: string
): PhoneCommandResult {
  return { requestId, ok: false, code, message }
}
