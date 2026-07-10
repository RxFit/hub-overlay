import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHideTimers } from './hide-timers'

describe('createHideTimers (optimistic hide/rollback race)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires the scheduled callback after the delay (happy complete→hide path)', () => {
    const timers = createHideTimers()
    const fn = vi.fn()
    timers.schedule('t1', fn, 1500)

    expect(timers.has('t1')).toBe(true)
    vi.advanceTimersByTime(1499)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    // Self-evicts after firing.
    expect(timers.has('t1')).toBe(false)
  })

  it('cancel() before the delay prevents the callback (sub-1.5s failure rollback)', () => {
    const timers = createHideTimers()
    const fn = vi.fn()
    timers.schedule('t1', fn, 1500)

    // Write fails at ~300ms → rollback cancels the pending hide.
    vi.advanceTimersByTime(300)
    expect(timers.cancel('t1')).toBe(true)

    // Even well past the original deadline, the row is NOT re-hidden.
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
    expect(timers.has('t1')).toBe(false)
  })

  it('cancel() on an unknown id is a no-op returning false', () => {
    const timers = createHideTimers()
    expect(timers.cancel('missing')).toBe(false)
  })

  it('schedule() replaces an existing timer for the same id', () => {
    const timers = createHideTimers()
    const first = vi.fn()
    const second = vi.fn()
    timers.schedule('t1', first, 1500)
    timers.schedule('t1', second, 1500)

    vi.advanceTimersByTime(1500)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('clearAll() cancels every pending timer (list switch / unmount)', () => {
    const timers = createHideTimers()
    const a = vi.fn()
    const b = vi.fn()
    timers.schedule('a', a, 1500)
    timers.schedule('b', b, 1500)

    timers.clearAll()
    vi.advanceTimersByTime(5000)
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    expect(timers.has('a')).toBe(false)
    expect(timers.has('b')).toBe(false)
  })

  it('independent ids do not interfere (one cancelled, one fires)', () => {
    const timers = createHideTimers()
    const a = vi.fn()
    const b = vi.fn()
    timers.schedule('a', a, 1500)
    timers.schedule('b', b, 1500)

    timers.cancel('a')
    vi.advanceTimersByTime(1500)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
