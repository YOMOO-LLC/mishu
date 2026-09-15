import { describe, expect, it, vi } from 'vitest'
import { sleep, systemClock, waitFor, type Clock } from '@mishu/core/clock'

function createManualClock(start = 0): Clock & { fire(id: unknown): void; pending: Map<unknown, () => void> } {
  const pending = new Map<unknown, () => void>()
  let nextId = 1
  let nowMs = start
  return {
    pending,
    now: () => nowMs,
    setTimeout(fn, _ms) {
      const id = nextId++
      pending.set(id, fn)
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    fire(id: unknown) {
      const fn = pending.get(id)
      pending.delete(id)
      fn?.()
    }
  }
}

describe('core clock', () => {
  it('systemClock.now tracks Date.now', () => {
    const before = Date.now()
    const value = systemClock.now()
    const after = Date.now()
    expect(value).toBeGreaterThanOrEqual(before)
    expect(value).toBeLessThanOrEqual(after)
  })

  it('waitFor resolves through the injected clock setTimeout', async () => {
    const clock = createManualClock()
    let settled = false
    const pending = waitFor(clock, 25).then(() => {
      settled = true
    })
    expect(settled).toBe(false)
    expect(clock.pending.size).toBe(1)
    clock.fire(1)
    await pending
    expect(settled).toBe(true)
  })

  it('sleep is derived from Clock.setTimeout', async () => {
    const clock = createManualClock()
    const pending = sleep(clock, 10)
    expect(clock.pending.size).toBe(1)
    clock.fire(1)
    await pending
  })

  it('clearTimeout drops a pending timer without running it', () => {
    const clock = createManualClock()
    const fn = vi.fn()
    const id = clock.setTimeout(fn, 10)
    clock.clearTimeout(id)
    expect(clock.pending.size).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })

  it('systemClock.setTimeout and clearTimeout use platform timers', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      systemClock.setTimeout(fn, 100)
      expect(fn).not.toHaveBeenCalled()
      vi.advanceTimersByTime(100)
      expect(fn).toHaveBeenCalledOnce()
      const skipped = vi.fn()
      const skippedId = systemClock.setTimeout(skipped, 50)
      systemClock.clearTimeout(skippedId)
      vi.advanceTimersByTime(50)
      expect(skipped).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
