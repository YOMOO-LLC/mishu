import type { MainModuleContext, MainModuleHandle } from '../module-context.js'
import { createContactLookupTool } from './tools.js'

export function register(ctx: MainModuleContext): MainModuleHandle {
  ctx.toolRegistry.register(createContactLookupTool(ctx.services.contacts, ctx.callStore, ctx.toolRegistry))
  const unsubscribe = ctx.callStore.onEvent((event) => {
    if (event.type === 'call.started') {
      ctx.services.contacts.snapshotForCall(event.call.id, event.call.peer)
    }
  })
  return { dispose: unsubscribe }
}
