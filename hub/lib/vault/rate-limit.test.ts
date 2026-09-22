import { describe, it, expect, afterEach } from 'vitest'
import { createTokenBucket, getSearchRateLimiter, _resetSearchRateLimiterForTests } from './rate-limit'

describe('createTokenBucket — per-key token bucket', () => {
  it('allows a burst up to capacity, then denies with a Retry-After', () => {
    const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 1 })
    const t0 = 1_000_000
    expect(bucket.take('instinct', t0)).toEqual({ allowed: true, remaining: 2 })
    expect(bucket.take('instinct', t0)).toEqual({ allowed: true, remaining: 1 })
    expect(bucket.take('instinct', t0)).toEqual({ allowed: true, remaining: 0 })
    const denied = bucket.take('instinct', t0)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSec).toBe(1)
  })

  it('refills continuously and never above capacity', () => {
    const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 0.5 })
    const t0 = 0
    bucket.take('k', t0)
    bucket.take('k', t0)
    expect(bucket.take('k', t0 + 1_000).allowed).toBe(false) // 0.5 token
    expect(bucket.take('k', t0 + 2_000).allowed).toBe(true) // 1 token
    // 60s later the bucket is full again (2), not 30.
    expect(bucket.take('k', t0 + 62_000)).toEqual({ allowed: true, remaining: 1 })
    expect(bucket.take('k', t0 + 62_000)).toEqual({ allowed: true, remaining: 0 })
    expect(bucket.take('k', t0 + 62_000).allowed).toBe(false)
  })

  it('isolates keys — one busy harness does not starve another', () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 0.1 })
    expect(bucket.take('instinct', 0).allowed).toBe(true)
    expect(bucket.take('instinct', 0).allowed).toBe(false)
    expect(bucket.take('hermes', 0).allowed).toBe(true)
  })

  it('retryAfter reflects the refill rate', () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 0.25 })
    bucket.take('k', 0)
    expect(bucket.take('k', 0).retryAfterSec).toBe(4)
  })
})

describe('getSearchRateLimiter — process-wide singleton with env tunables', () => {
  afterEach(() => {
    _resetSearchRateLimiterForTests()
    delete process.env.VAULT_SEARCH_RATE_CAPACITY
    delete process.env.VAULT_SEARCH_RATE_REFILL_PER_SEC
  })

  it('defaults to a 30-token burst refilling at 0.5/s', () => {
    _resetSearchRateLimiterForTests()
    expect(getSearchRateLimiter().options).toEqual({ capacity: 30, refillPerSecond: 0.5 })
    expect(getSearchRateLimiter()).toBe(getSearchRateLimiter())
  })

  it('reads the env tunables and ignores nonsense values', () => {
    process.env.VAULT_SEARCH_RATE_CAPACITY = '5'
    process.env.VAULT_SEARCH_RATE_REFILL_PER_SEC = 'abc'
    _resetSearchRateLimiterForTests()
    expect(getSearchRateLimiter().options).toEqual({ capacity: 5, refillPerSecond: 0.5 })
  })
})
