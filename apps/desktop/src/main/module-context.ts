import type { BrowserWindow, IpcMain } from 'electron'
import type { CodexAppServerClient } from './codex/index.js'
import type { EngineContext } from './engine-context.js'
import type { ApprovalManager } from './mcp/approvals.js'
import type { PhoneCommandGateway } from './phone-gateway.js'

/**
 * Desktop host context: host-agnostic EngineContext plus Electron IPC,
 * the Codex process, and the raw renderer phone gateway.
 */
export interface MainModuleContext extends EngineContext {
  ipcMain: IpcMain
  getWindow(): BrowserWindow | undefined
  phoneGateway: PhoneCommandGateway
  codex(): CodexAppServerClient
  approvals: ApprovalManager
}

export interface MainModuleHandle {
  dispose(): void
}
