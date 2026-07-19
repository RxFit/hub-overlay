import { describe, it, expect } from 'vitest'
import {
  emptyMemory,
  isDismissed,
  canShow,
  recordShown,
  recordDismissed,
  SUGGESTION_CONFIG,
} from '@/lib/suggestion-memory'

const NOW = 1_800_000_000_000

describe('isDismissed', () => {
  it('is false for an unknown key', () => {
    expect(isDismissed(emptyMemory(), 'routine:x', NOW)).toBe(false)
  })

  it('snooze expires after the window; permanent never does', () => {
    const snoozed = recordDismissed(emptyMemory(), 'routine:x', false, NOW)
    expect(isDismissed(snoozed, 'routine:x', NOW)).toBe(true)
    expect(isDismissed(snoozed, 'routine:x', NOW + SUGGESTION_CONFIG.snoozeMs + 1)).toBe(false)

    const permanent = recordDismissed(emptyMemory(), 'routine:x', true, NOW)
    expect(isDismissed(permanent, 'routine:x', NOW + 10 * 365 * 24 * 3600_000)).toBe(true)
  })
})

describe('canShow', () => {
  it('blocks below the confidence floor', () => {
    expect(canShow(emptyMemory(), SUGGESTION_CONFIG.minConfidence - 0.01, Infinity, NOW)).toBe(false)
  })

  it('blocks until the inter-suggestion turn gap is met', () => {
    const mem = emptyMemory()
    expect(canShow(mem, 0.9, SUGGESTION_CONFIG.minTurnGap - 1, NOW)).toBe(false)
    expect(canShow(mem, 0.9, SUGGESTION_CONFIG.minTurnGap, NOW)).toBe(true)
  })

  it('enforces the per-day cap on a rolling 24h window', () => {
    let mem = emptyMemory()
    for (let i = 0; i < SUGGESTION_CONFIG.perDay; i++) mem = recordShown(mem, NOW)
    expect(canShow(mem, 0.9, Infinity, NOW)).toBe(false)
    // A day later the old entries fall out of the window.
    expect(canShow(mem, 0.9, Infinity, NOW + 24 * 3600_000 + 1)).toBe(true)
  })
})

describe('recordShown', () => {
  it('prunes entries older than 24h', () => {
    let mem = recordShown(emptyMemory(), NOW - 25 * 3600_000)
    mem = recordShown(mem, NOW)
    expect(mem.shownAt).toEqual([NOW])
  })
})
