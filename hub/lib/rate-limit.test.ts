import { describe, it, expect, beforeEach } from 'vitest'
import { checkRateLimit, _sweep, _reset, LIMIT, WINDOW_MS } from './rate-limit'

describe('checkRateLimit sliding window', () => {
  beforeEach(() => {
    _reset()
  })

  it('allows LIMIT requests in-window and denies the next with correct retryAfterSec', () => {
    const t0 = 1_000_000

    for (let i = 0; i < LIMIT; i++) {
      expect(checkRateLimit('user@rxfitatx.com', t0 + i * 100).allowed).toBe(true)
    }

    // 16th request, 5s into the window — oldest request ages out at t0 + 60s,
    // so Retry-After should be ceil(55s) = 55
    const denied = checkRateLimit('user@rxfitatx.com', t0 + 5_000)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSec).toBe(Math.ceil((t0 + WINDOW_MS - (t0 + 5_000)) / 1000))
    expect(denied.retryAfterSec).toBe(55)
  })

  it('slides the window — requests are allowed again once old ones age out', () => {
    const t0 = 1_000_000

    for (let i = 0; i < LIMIT; i++) {
      expect(checkRateLimit('user@rxfitatx.com', t0).allowed).toBe(true)
    }
    expect(checkRateLimit('user@rxfitatx.com', t0 + 1_000).allowed).toBe(false)

    // Exactly WINDOW_MS later, the t0 batch has expired
    expect(checkRateLimit('user@rxfitatx.com', t0 + WINDOW_MS).allowed).toBe(true)
  })

  it('keys are independent — userA exhausting the limit does not affect userB', () => {
    const t0 = 1_000_000

    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit('userA@rxfitatx.com', t0)
    }
    expect(checkRateLimit('userA@rxfitatx.com', t0).allowed).toBe(false)
    expect(checkRateLimit('userB@rxfitatx.com', t0).allowed).toBe(true)
  })

  it('reports at least 1 second of Retry-After on denial', () => {
    const t0 = 1_000_000

    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit('user@rxfitatx.com', t0)
    }
    // 1ms before the window opens — must not round down to 0
    const denied = checkRateLimit('user@rxfitatx.com', t0 + WINDOW_MS - 1)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSec).toBe(1)
  })
})

describe('_sweep stale-key cleanup', () => {
  beforeEach(() => {
    _reset()
  })

  it('removes keys whose timestamps have all aged out, keeps active keys', () => {
    const t0 = 1_000_000

    checkRateLimit('stale@rxfitatx.com', t0)
    checkRateLimit('active@rxfitatx.com', t0 + WINDOW_MS)

    _sweep(t0 + WINDOW_MS)

    // Stale key was deleted — a fresh burst gets a full window again
    for (let i = 0; i < LIMIT; i++) {
      expect(checkRateLimit('stale@rxfitatx.com', t0 + WINDOW_MS).allowed).toBe(true)
    }
    // Active key kept its in-window timestamp: only LIMIT - 1 more fit
    for (let i = 0; i < LIMIT - 1; i++) {
      expect(checkRateLimit('active@rxfitatx.com', t0 + WINDOW_MS).allowed).toBe(true)
    }
    expect(checkRateLimit('active@rxfitatx.com', t0 + WINDOW_MS).allowed).toBe(false)
  })
})
