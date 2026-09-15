import type { AppointmentsSaveInput } from '../../shared/contracts.js'
import { IPC } from '../../shared/contracts.js'
import type { MainModuleContext, MainModuleHandle } from '../module-context.js'
import { AppointmentPostCallSync } from './post-call-sync.js'
import { createAppointmentTools } from './tools.js'

export function register(ctx: MainModuleContext): MainModuleHandle {
  const service = ctx.services.appointments
  const sync = new AppointmentPostCallSync({
    callStore: ctx.callStore,
    appointmentStore: ctx.appointmentStore,
    getCalendar: () => service.calendar(),
    isAutoConfirm: () => service.get().autoConfirm,
    webhookBridge: ctx.webhookBridge
  })
  sync.startScheduler()

  for (const tool of createAppointmentTools({
    callStore: ctx.callStore,
    appointmentStore: ctx.appointmentStore,
    getCalendar: () => service.calendar()
  })) ctx.toolRegistry.register(tool)

  ctx.ipcMain.handle(IPC.appointmentsGetConfig, () => service.get())
  ctx.ipcMain.handle(
    IPC.appointmentsSaveConfig,
    (_event, input: AppointmentsSaveInput) => {
      return service.save(input)
    }
  )

  return {
    dispose() {
      sync.dispose()
      ctx.ipcMain.removeHandler(IPC.appointmentsGetConfig)
      ctx.ipcMain.removeHandler(IPC.appointmentsSaveConfig)
    }
  }
}

export { AppointmentStore } from './store.js'
