import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkRateLimit,
  checkActionLimit,
  ACTION_LIMITS,
  DEFAULT_ACTION_LIMIT,
  _sweep,
  _reset,
  LIMIT,
  WINDOW_MS,
} from './rate-limit'

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

describe('checkActionLimit — per-action-type windows (NS-2)', () => {
  beforeEach(() => {
    _reset()
  })

  it('limits the (N+1)th gmail_send in the window (stricter 5/60s)', () => {
    const t0 = 1_000_000
    const email = 'danny@rxfitatx.com'
    const gmailLimit = ACTION_LIMITS.gmail_send
    expect(gmailLimit).toBe(5)

    for (let i = 0; i < gmailLimit; i++) {
      expect(checkActionLimit(email, 'gmail_send', t0 + i).allowed).toBe(true)
    }
    const denied = checkActionLimit(email, 'gmail_send', t0 + gmailLimit)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSec).toBeGreaterThan(0)
  })

  it('keeps action types independent — a maxed gmail_send does not block chat_post', () => {
    const t0 = 1_000_000
    const email = 'danny@rxfitatx.com'

    for (let i = 0; i < ACTION_LIMITS.gmail_send; i++) {
      checkActionLimit(email, 'gmail_send', t0 + i)
    }
    // gmail_send is now exhausted...
    expect(checkActionLimit(email, 'gmail_send', t0 + 100).allowed).toBe(false)
    // ...but chat_post has its own untouched window.
    expect(checkActionLimit(email, 'chat_post', t0 + 100).allowed).toBe(true)
    // ...and task_create too.
    expect(checkActionLimit(email, 'task_create', t0 + 100).allowed).toBe(true)
  })

  it('scopes windows per user — one user maxing out does not affect another', () => {
    const t0 = 1_000_000
    for (let i = 0; i < ACTION_LIMITS.gmail_send; i++) {
      checkActionLimit('a@rxfitatx.com', 'gmail_send', t0 + i)
    }
    expect(checkActionLimit('a@rxfitatx.com', 'gmail_send', t0 + 100).allowed).toBe(false)
    expect(checkActionLimit('b@rxfitatx.com', 'gmail_send', t0 + 100).allowed).toBe(true)
  })

  it('unknown action types fall back to the global default limit', () => {
    const t0 = 1_000_000
    const email = 'danny@rxfitatx.com'
    expect(DEFAULT_ACTION_LIMIT).toBe(LIMIT)
    for (let i = 0; i < DEFAULT_ACTION_LIMIT; i++) {
      expect(checkActionLimit(email, 'mystery_action', t0 + i).allowed).toBe(true)
    }
    expect(checkActionLimit(email, 'mystery_action', t0 + DEFAULT_ACTION_LIMIT).allowed).toBe(false)
  })

  it('does not collide with the global chat limiter for the same email', () => {
    const t0 = 1_000_000
    const email = 'danny@rxfitatx.com'
    // Exhaust the per-action gmail_send window.
    for (let i = 0; i < ACTION_LIMITS.gmail_send; i++) {
      checkActionLimit(email, 'gmail_send', t0 + i)
    }
    expect(checkActionLimit(email, 'gmail_send', t0 + 100).allowed).toBe(false)
    // The global chat window keyed on the bare email is independent.
    expect(checkRateLimit(email, t0 + 100).allowed).toBe(true)
  })
})
