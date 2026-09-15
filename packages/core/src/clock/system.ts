export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => { clearTimeout(id as ReturnType<typeof setTimeout>) }
}

export function waitFor(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => { clock.setTimeout(resolve, ms) })
}

/** Sleep derived from Clock.setTimeout so hosts do not call timers directly. */
export function sleep(clock: Clock, ms: number): Promise<void> {
  return waitFor(clock, ms)
}
