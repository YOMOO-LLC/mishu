import { describe, expect, it } from 'vitest'
import type { Clock } from '@mishu/core/clock'

export type ContractClock = Clock & { advance(ms: number): void }

/**
 * Behavioural Clock contract for FakeClock-style implementations.
 * `makeClock` must start stopped; `advance(ms)` is the only way time moves.
 */
export function describeClockContract(
  makeClock: () => ContractClock,
  _options?: object
): void {
  describe('Clock contract', () => {
    it('fires timers in (at, id) order and runs nested due timers', () => {
      const clock = makeClock()
      const start = clock.now()
      const order: string[] = []
      clock.setTimeout(() => order.push('a'), 10)
      clock.setTimeout(() => order.push('b'), 10)
      clock.setTimeout(() => order.push('late'), 30)
      clock.advance(10)
      expect(order).toEqual(['a', 'b'])
      clock.setTimeout(() => {
        order.push('outer')
        clock.setTimeout(() => order.push('inner'), 0)
      }, 0)
      clock.advance(0)
      expect(order).toEqual(['a', 'b', 'outer', 'inner'])
      clock.advance(20)
      expect(order).toEqual(['a', 'b', 'outer', 'inner', 'late'])
      expect(clock.now()).toBe(start + 30)
    })

    it('does not run a timer after clearTimeout', () => {
      const clock = makeClock()
      const ran: string[] = []
      const id = clock.setTimeout(() => ran.push('no'), 5)
      clock.clearTimeout(id)
      clock.advance(20)
      expect(ran).toEqual([])
    })
  })
}
