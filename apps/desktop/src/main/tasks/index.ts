import type { AnalysisService } from '../analysis/service.js'
import type { MainModuleContext, MainModuleHandle } from '../module-context.js'
import { TaskRunner } from './runner.js'

export function register(ctx: MainModuleContext, analysis: AnalysisService): MainModuleHandle {
  const runner = new TaskRunner({
    tasks: ctx.services.tasks,
    budget: ctx.services.budget,
    analysis,
    store: ctx.callStore,
    gateway: ctx.phoneGateway,
    isMock: ctx.isMock,
    schedulerIntervalMs: ctx.isMock ? 50 : 1_000
  })
  runner.start()
  return { dispose: () => runner.dispose() }
}

export { TaskRunner, TASK_RETRY_BACKOFF_MS } from './runner.js'
