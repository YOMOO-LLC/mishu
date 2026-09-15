import { describe, expect, it } from 'vitest'
import { FakeClock, FakeIdGen } from '@mishu/adapters-mock/clock'
import { describeClockContract } from '@mishu/adapters-mock/contract-tests'
import type { Clock, IdGen } from '@mishu/core/clock'

describeClockContract(() => new FakeClock(0))

describe('FakeClock', () => {
  it('implements Clock and advances nowMs', () => {
    const clock: Clock = new FakeClock(1_000)
    expect(clock.now()).toBe(1_000)
    const fake = clock as FakeClock
    fake.advance(500)
    expect(clock.now()).toBe(1_500)
  })

  it('keeps interval timers and fires them on each period', () => {
    const clock = new FakeClock(0)
    const ticks: number[] = []
    const id = clock.setInterval(() => ticks.push(clock.now()), 10)
    clock.advance(25)
    expect(ticks).toEqual([10, 20])
    clock.clearTimeout(id)
    clock.advance(20)
    expect(ticks).toEqual([10, 20])
  })
})

describe('FakeIdGen', () => {
  it('returns deterministic sequential ids', () => {
    const ids: IdGen = new FakeIdGen('call')
    expect(ids.id()).toBe('call_1')
    expect(ids.id()).toBe('call_2')
    expect(new FakeIdGen().id()).toBe('id_1')
  })
})
