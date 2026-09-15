import type { MainModuleContext, MainModuleHandle } from '../module-context.js'
import { createEndCallTool } from './tools.js'

export function register(ctx: MainModuleContext): MainModuleHandle {
  ctx.toolRegistry.register(createEndCallTool({
    hangup: () => ctx.services.phone.hangup('copilot'),
    silence: () => ctx.services.realtime.silence(),
    writeAudit(actor, action, callId, details) {
      ctx.callStore.writeAudit(action, callId, details, actor)
    }
  }))
  return { dispose() {} }
}
