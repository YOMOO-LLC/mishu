import type { Clock, IdGen } from '@mishu/core/clock'

/** Kept so the T12.14 stub suite still passes. */
export const ADAPTERS_MOCK_CLOCK_TASK = 'T12.18'

interface Timer {
  id: number
  at: number
  fn: () => void
  interval?: number
}

/**
 * Deterministic Clock copied from spikes/cloud-media/fakes/fake-clock.ts.
 * The spike keeps its own copy; this package does not import spikes/.
 */
export class FakeClock implements Clock {
  nowMs: number
  private nextId = 1
  private timers: Timer[] = []

  constructor(start = 0) {
    this.nowMs = start
  }

  now(): number {
    return this.nowMs
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++
    this.timers.push({ id, at: this.nowMs + ms, fn })
    return id
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++
    this.timers.push({ id, at: this.nowMs + ms, fn, interval: ms })
    return id
  }

  clear(id: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== id)
  }

  clearTimeout(id: unknown): void {
    this.clear(id as number)
  }

  /** Fire due timers in (at, id) order, including timers scheduled by earlier callbacks. */
  advance(ms: number): void {
    const target = this.nowMs + ms
    while (true) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)
      const next = due[0]
      if (!next) {
        this.nowMs = target
        return
      }
      this.nowMs = next.at
      if (next.interval !== undefined) next.at = this.nowMs + next.interval
      else this.timers = this.timers.filter((timer) => timer.id !== next.id)
      next.fn()
    }
  }
}

/** Sequential ids: prefix_1, prefix_2, ... */
export class FakeIdGen implements IdGen {
  private next = 1

  constructor(private readonly prefix = 'id') {}

  id(): string {
    const value = `${this.prefix}_${this.next}`
    this.next += 1
    return value
  }
}
