export interface ShutdownStep {
  name: string
  dispose(): void | Promise<void>
}

export interface WindowCloseEvent {
  preventDefault(): void
}

export interface ShutdownCoordinatorOptions {
  forceExit(): void
  commitExit?(): void
  deadlineMs?: number
  onLog?(message: string): void
  onDisposeError?(step: string, error: unknown): void
  now?: () => number
  scheduleResume?: (callback: () => void) => unknown
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

/**
 * Owns the boundary between a user window close (hide) and a real app quit.
 * Shutdown steps are invoked synchronously in reverse registration order so
 * one failing disposer cannot prevent the remaining resources from starting
 * their cleanup.
 */
export class ShutdownCoordinator {
  private readonly deadlineMs: number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly now: () => number
  private readonly scheduleResume: (callback: () => void) => unknown
  private deadline?: ReturnType<typeof setTimeout>
  private shuttingDown = false

  constructor(private readonly options: ShutdownCoordinatorOptions) {
    this.deadlineMs = Math.max(1, options.deadlineMs ?? 2_500)
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.now = options.now ?? Date.now
    // Give an inspector-driven app.quit() response time to reach its caller so
    // the caller can disconnect before Electron enters final process exit.
    this.scheduleResume = options.scheduleResume ?? ((callback) => setTimeout(callback, 100))
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  handleWindowClose(
    event: WindowCloseEvent,
    minimizeToTray: boolean,
    hide: () => void
  ): 'close' | 'hide' {
    if (this.shuttingDown || !minimizeToTray) {
      this.log(`window close allowed shuttingDown=${this.shuttingDown}`)
      return 'close'
    }
    event.preventDefault()
    hide()
    this.log('window close hidden to tray')
    return 'hide'
  }

  begin(steps: readonly ShutdownStep[]): boolean {
    if (this.shuttingDown) {
      this.log('duplicate shutdown ignored')
      return false
    }
    this.shuttingDown = true
    this.log(`shutdown begin steps=${steps.length} deadlineMs=${this.deadlineMs}`)
    this.deadline = this.setTimer(() => {
      this.deadline = undefined
      this.log('shutdown deadline reached; forcing exit')
      this.options.forceExit()
    }, this.deadlineMs)

    for (const step of [...steps].reverse()) {
      const startedAt = this.now()
      this.log(`dispose start step=${JSON.stringify(step.name)}`)
      try {
        const result = step.dispose()
        if (isPromiseLike(result)) {
          void result.then(
            () => this.logDisposeComplete(step.name, startedAt, 'async'),
            (error: unknown) => this.reportDisposeError(step.name, error, startedAt)
          )
        } else {
          this.logDisposeComplete(step.name, startedAt, 'sync')
        }
      } catch (error) {
        this.reportDisposeError(step.name, error, startedAt)
      }
    }
    if (this.options.commitExit) {
      this.scheduleResume(() => {
        this.log('cleanup initiated; committing Electron exit')
        this.options.commitExit?.()
      })
    }
    return true
  }

  cancelDeadline(): void {
    if (!this.deadline) return
    this.clearTimer(this.deadline)
    this.deadline = undefined
    this.log('shutdown deadline cancelled')
  }

  private logDisposeComplete(step: string, startedAt: number, mode: 'sync' | 'async'): void {
    this.log(`dispose complete step=${JSON.stringify(step)} mode=${mode} durationMs=${this.elapsed(startedAt)}`)
  }

  private reportDisposeError(step: string, error: unknown, startedAt: number): void {
    this.log(`dispose failed step=${JSON.stringify(step)} durationMs=${this.elapsed(startedAt)}`)
    this.options.onDisposeError?.(step, error)
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, Math.round(this.now() - startedAt))
  }

  private log(message: string): void {
    this.options.onLog?.(message)
  }
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return typeof value === 'object' && value !== null && typeof value.then === 'function'
}
