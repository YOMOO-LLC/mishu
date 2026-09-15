import { IPC, type McpScope } from '../../shared/contracts.js'
import type { MainModuleContext, MainModuleHandle } from '../module-context.js'
import { McpServerController } from './server.js'

export function register(ctx: MainModuleContext): MainModuleHandle {
  const controller = new McpServerController(ctx, ctx.approvals)

  ctx.ipcMain.handle(IPC.mcpGetStatus, () => ctx.services.mcp.status())
  ctx.ipcMain.handle(IPC.mcpSetEnabled, (_event, enabled: boolean) => ctx.services.mcp.setEnabled(enabled))
  ctx.ipcMain.handle(IPC.mcpRotateToken, () => ctx.services.mcp.rotateToken())
  ctx.ipcMain.handle(IPC.mcpSetScopes, (_event, scopes: McpScope[]) => ctx.services.mcp.setScopes(scopes))
  ctx.ipcMain.handle(IPC.mcpGetClientConfigs, () => ctx.services.mcp.clientConfigs())
  ctx.ipcMain.handle(IPC.mcpApplyClientConfigs, () => ctx.services.mcp.applyClientConfigs())
  void controller.initialize()

  return {
    dispose() {
      ctx.ipcMain.removeHandler(IPC.mcpGetStatus)
      ctx.ipcMain.removeHandler(IPC.mcpSetEnabled)
      ctx.ipcMain.removeHandler(IPC.mcpRotateToken)
      ctx.ipcMain.removeHandler(IPC.mcpSetScopes)
      ctx.ipcMain.removeHandler(IPC.mcpGetClientConfigs)
      ctx.ipcMain.removeHandler(IPC.mcpApplyClientConfigs)
      void controller.dispose()
    }
  }
}

export { ApprovalManager } from './approvals.js'
export { McpServerController } from './server.js'
export { McpToolService } from './tools.js'
