import { IPC } from '../../shared/contracts.js'
import type { CrmSaveInput } from '../../shared/contracts.js'
import type { MainModuleContext, MainModuleHandle } from '../module-context.js'
import { persistCrmConfig } from '../services/crm-service.js'
import { PostCallSync } from './post-call-sync.js'
import { createCrmTools } from './tools.js'

export function register(ctx: MainModuleContext): MainModuleHandle {
  const service = ctx.services.crm
  const sync = new PostCallSync({
    callStore: ctx.callStore,
    getClient: () => service.client(),
    isEnabled: () => service.isPostCallSyncEnabled(),
    webhookBridge: ctx.webhookBridge,
    onSuccess: (lastSyncAt) => service.markSyncSuccess(lastSyncAt),
    onError: (lastError) => service.markSyncError(lastError)
  })
  sync.startScheduler()
  service.setSyncLogProvider((limit) => sync.list(limit))

  for (const tool of createCrmTools(() => service.client())) ctx.toolRegistry.register(tool)

  ctx.ipcMain.handle(IPC.crmGetConfig, () => service.get())
  ctx.ipcMain.handle(IPC.crmSaveConfig, (_event, input: CrmSaveInput) => service.save(input))
  ctx.ipcMain.handle(IPC.crmTestConnection, () => service.test())
  ctx.ipcMain.handle(IPC.crmListSyncLog, (_event, request: { limit?: number } | undefined) => sync.list(request?.limit))

  return {
    dispose() {
      sync.dispose()
      service.setSyncLogProvider(undefined)
      ctx.ipcMain.removeHandler(IPC.crmGetConfig)
      ctx.ipcMain.removeHandler(IPC.crmSaveConfig)
      ctx.ipcMain.removeHandler(IPC.crmTestConnection)
      ctx.ipcMain.removeHandler(IPC.crmListSyncLog)
    }
  }
}

export { persistCrmConfig }
