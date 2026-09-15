import { describe, expect, it, vi } from 'vitest'
import { ShutdownCoordinator, type ShutdownStep } from './shutdown.js'

describe('ShutdownCoordinator', () => {
  it('hides a normal close but closes and disposes in reverse order after quit begins', async () => {
    vi.useFakeTimers()
    try {
      const forceExit = vi.fn()
      const errors: string[] = []
      const order: string[] = []
      const coordinator = new ShutdownCoordinator({
        forceExit,
        deadlineMs: 4_000,
        onDisposeError: (step) => errors.push(step)
      })
      const preventDefault = vi.fn()
      const hide = vi.fn()

      expect(coordinator.handleWindowClose({ preventDefault }, true, hide)).toBe('hide')
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(hide).toHaveBeenCalledOnce()

      const steps: ShutdownStep[] = [
        { name: 'database', dispose: () => { order.push('database') } },
        { name: 'scheduler', dispose: () => { order.push('scheduler') } },
        { name: 'window', dispose: () => { order.push('window') } },
        {
          name: 'tray',
          dispose: () => {
            order.push('tray')
            throw new Error('tray already destroyed')
          }
        }
      ]
      expect(coordinator.begin(steps)).toBe(true)
      expect(order).toEqual(['tray', 'window', 'scheduler', 'database'])
      expect(errors).toEqual(['tray'])

      const quitPreventDefault = vi.fn()
      expect(coordinator.handleWindowClose({ preventDefault: quitPreventDefault }, true, hide)).toBe('close')
      expect(quitPreventDefault).not.toHaveBeenCalled()
      expect(coordinator.begin(steps)).toBe(false)

      await vi.advanceTimersByTimeAsync(3_999)
      expect(forceExit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(forceExit).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports asynchronous disposal failures and can clear the exit deadline', async () => {
    vi.useFakeTimers()
    try {
      const forceExit = vi.fn()
      const onDisposeError = vi.fn()
      const coordinator = new ShutdownCoordinator({ forceExit, onDisposeError })
      coordinator.begin([{ name: 'async-resource', dispose: () => Promise.reject(new Error('failed')) }])
      await Promise.resolve()
      expect(onDisposeError).toHaveBeenCalledWith('async-resource', expect.any(Error))

      coordinator.cancelDeadline()
      await vi.runAllTimersAsync()
      expect(forceExit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the hard deadline referenced and logs synchronous and asynchronous phases', async () => {
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>
    const setTimer = vi.fn(() => timer) as unknown as typeof setTimeout
    const clearTimer = vi.fn() as unknown as typeof clearTimeout
    const logs: string[] = []
    const times = [100, 103, 105, 108]
    const coordinator = new ShutdownCoordinator({
      forceExit: vi.fn(),
      onLog: (message) => logs.push(message),
      now: () => times.shift() ?? 108,
      setTimer,
      clearTimer
    })

    coordinator.begin([
      { name: 'sync', dispose: () => undefined },
      { name: 'async', dispose: async () => undefined }
    ])
    await Promise.resolve()

    expect(timer.unref).not.toHaveBeenCalled()
    expect(logs).toEqual([
      'shutdown begin steps=2 deadlineMs=2500',
      'dispose start step="async"',
      'dispose start step="sync"',
      'dispose complete step="sync" mode=sync durationMs=2',
      'dispose complete step="async" mode=async durationMs=8'
    ])
    coordinator.cancelDeadline()
    expect(clearTimer).toHaveBeenCalledWith(timer)
    expect(logs.at(-1)).toBe('shutdown deadline cancelled')
  })

  it('defers resumed quit until after the initiating event handler returns', () => {
    const scheduled: Array<() => void> = []
    const commitExit = vi.fn()
    const coordinator = new ShutdownCoordinator({
      forceExit: vi.fn(),
      commitExit,
      scheduleResume: (callback) => scheduled.push(callback)
    })

    expect(coordinator.begin([])).toBe(true)
    expect(commitExit).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)

    scheduled[0]?.()
    expect(commitExit).toHaveBeenCalledOnce()
    coordinator.cancelDeadline()
  })
})
