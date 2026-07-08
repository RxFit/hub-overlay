import { describe, it, expect } from 'vitest'
import {
  computeAiHealth,
  percentile,
  FALLBACK_WARN,
  FALLBACK_CRIT,
  SUCCESS_CRIT,
  TIMEOUTS_PER_HOUR_WARN,
  RATE_LIMITED_PER_HOUR_WARN,
  type TelemetryRow,
  type ActionRow,
} from './ai-health'

/* ════════════════════════════════════════════════════════════════════════════
   AI Health aggregation (lib/ai-health.ts) — pure-function suite (NS-10).

   Covers: nearest-rank percentile math on known sets, the full aggregate over
   mixed fixture rows, EVERY alert threshold at just-below / at / above its
   boundary, empty-window behavior (nulls, never NaN), and defensiveness
   against malformed payloads.
   ════════════════════════════════════════════════════════════════════════════ */

const HOUR = 3_600_000
const DAY = 24 * HOUR

function t(
  type: string,
  payload: Record<string, unknown> | null = null,
  createdAt: Date | string = new Date('2026-07-08T12:00:00Z'),
): TelemetryRow {
  return { eventType: `telemetry:${type}`, payload, createdAt }
}

function action(over: Partial<ActionRow> = {}): ActionRow {
  return {
    actionType: 'gmail_send',
    status: 'success',
    error: null,
    createdAt: new Date('2026-07-08T12:00:00Z'),
    ...over,
  }
}

/** N completes so rate-based alerts can be dialed precisely. */
function completes(n: number): TelemetryRow[] {
  return Array.from({ length: n }, (_, i) => t('ai_complete', { ms: 100 + i }))
}

describe('percentile — nearest-rank on known sets', () => {
  it('p50/p95 of a known 20-element set', () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 10) // 10..200
    expect(percentile(values, 50)).toBe(100) // rank ceil(0.5*20)=10 → 10th value
    expect(percentile(values, 95)).toBe(190) // rank ceil(0.95*20)=19
    expect(percentile(values, 100)).toBe(200)
  })

  it('handles tiny sets, unsorted input, and duplicates', () => {
    expect(percentile([42], 50)).toBe(42)
    expect(percentile([42], 95)).toBe(42)
    expect(percentile([300, 100], 50)).toBe(100) // rank ceil(1)=1 after sorting
    expect(percentile([300, 100], 95)).toBe(300)
    expect(percentile([5, 5, 5, 900], 50)).toBe(5)
  })

  it('returns null (never NaN) for an empty set', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([], 95)).toBeNull()
  })
})

describe('computeAiHealth — aggregate over mixed rows', () => {
  const telemetry: TelemetryRow[] = [
    t('ai_complete', { ms: 100, provider: 'claude', model: 'm1' }, '2026-07-08T10:00:00Z'),
    t('ai_complete', { ms: 300, provider: 'gemini', model: 'm2' }, '2026-07-08T10:05:00Z'),
    t('ai_complete', { ms: 200, provider: 'gemini', model: 'm2' }, '2026-07-08T10:10:00Z'),
    t('ai_error', { code: 'auth', provider: 'gemini' }, '2026-07-08T11:00:00Z'),
    t('ai_error', { code: 'auth' }, '2026-07-08T11:30:00Z'),
    t('ai_error', { code: 'overloaded', provider: 'claude' }, '2026-07-08T11:45:00Z'),
    t('ai_timeout', { layer: 'connect', provider: 'gemini' }),
    t('ai_timeout', { layer: 'idle', provider: 'gemini' }),
    t('ai_timeout', { layer: 'connect', provider: 'claude' }),
    t('ai_fallback', { from: 'claude', to: 'gemini', reason: 'error' }),
  ]
  const actions: ActionRow[] = [
    action({ actionType: 'gmail_send', status: 'success' }),
    action({ actionType: 'gmail_send', status: 'failed', error: 'rate_limited', createdAt: '2026-07-08T11:50:00Z' }),
    action({ actionType: 'chat_post', status: 'success' }),
  ]

  const health = computeAiHealth(telemetry, actions, DAY)

  it('counts requests as completes + errors and derives the exact rates', () => {
    expect(health.requests).toBe(6)
    expect(health.successRate).toBeCloseTo(3 / 6, 10)
    expect(health.fallbacks).toBe(1)
    expect(health.fallbackRate).toBeCloseTo(1 / 6, 10)
    expect(health.errors).toBe(3)
    expect(health.timeouts).toBe(3)
  })

  it('breaks down timeouts by layer and errors by code', () => {
    expect(health.timeoutsByLayer).toEqual({ connect: 2, idle: 1 })
    expect(health.errorsByCode).toEqual({ auth: 2, overloaded: 1 })
  })

  it('computes latency percentiles from ai_complete.ms only', () => {
    expect(health.latencyMs.p50).toBe(200) // sorted [100,200,300], rank ceil(1.5)=2
    expect(health.latencyMs.p95).toBe(300)
    expect(health.firstTokenMs.p50).toBeNull() // first_token not persisted
  })

  it('aggregates actions by type/status and counts rate-limited', () => {
    expect(health.actions.total).toBe(3)
    expect(health.actions.byType).toEqual({ gmail_send: 2, chat_post: 1 })
    expect(health.actions.byStatus).toEqual({ success: 2, failed: 1 })
    expect(health.rateLimited).toBe(1)
  })

  it('lists recent failures newest-first, merging ai_error rows and failed actions', () => {
    expect(health.recentFailures.map((f) => [f.kind, f.code])).toEqual([
      ['action_failed', 'rate_limited'],
      ['ai_error', 'overloaded'],
      ['ai_error', 'auth'],
      ['ai_error', 'auth'],
    ])
    // Only known scalar fields — provider/actionType when present, nothing else.
    expect(health.recentFailures[0].actionType).toBe('gmail_send')
    expect(health.recentFailures[1].provider).toBe('claude')
    expect(health.recentFailures[2].provider).toBeUndefined()
    for (const f of health.recentFailures) {
      expect(Object.keys(f).every((k) => ['at', 'kind', 'code', 'provider', 'actionType'].includes(k))).toBe(true)
      expect(Number.isNaN(Date.parse(f.at))).toBe(false)
    }
  })

  it('caps recent failures at 10', () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      t('ai_error', { code: `c${i}` }, new Date(Date.parse('2026-07-08T00:00:00Z') + i * 1000)),
    )
    const h = computeAiHealth(many, [], DAY)
    expect(h.recentFailures).toHaveLength(10)
    expect(h.recentFailures[0].code).toBe('c14') // newest first
  })

  it('computes first-token p50 when telemetry:ai_first_token rows ARE present', () => {
    const h = computeAiHealth(
      [t('ai_first_token', { ms: 50 }), t('ai_first_token', { ms: 150 })],
      [],
      DAY,
    )
    expect(h.firstTokenMs.p50).toBe(50)
  })
})

describe('computeAiHealth — empty window', () => {
  const h = computeAiHealth([], [], DAY)

  it('yields zero counts and null rates/percentiles — never NaN', () => {
    expect(h.requests).toBe(0)
    expect(h.successRate).toBeNull()
    expect(h.fallbackRate).toBeNull()
    expect(h.latencyMs).toEqual({ p50: null, p95: null })
    expect(h.firstTokenMs.p50).toBeNull()
    expect(h.actions).toEqual({ total: 0, byType: {}, byStatus: {} })
    expect(h.recentFailures).toEqual([])
    expect(JSON.stringify(h)).not.toContain('NaN')
  })

  it('fires no alerts when there is no data', () => {
    expect(h.alerts).toEqual([])
  })
})

describe('computeAiHealth — defensiveness against malformed payloads', () => {
  it('tolerates null / wrong-typed payload fields without NaN or throw', () => {
    const h = computeAiHealth(
      [
        t('ai_complete', null),
        t('ai_complete', { ms: 'fast' }), // non-numeric ms dropped from percentiles
        t('ai_complete', { ms: 250 }),
        t('ai_error', null), // missing code → 'unknown'
        t('ai_timeout', { layer: 42 }), // non-string layer → 'unknown'
        t('ai_unknown_future_type', { x: 1 }), // ignored entirely
      ],
      [],
      DAY,
    )
    expect(h.requests).toBe(4)
    expect(h.latencyMs.p50).toBe(250)
    expect(h.errorsByCode).toEqual({ unknown: 1 })
    expect(h.timeoutsByLayer).toEqual({ unknown: 1 })
    expect(JSON.stringify(h)).not.toContain('NaN')
  })
})

/* ── Alert boundaries — exact semantics per named constant ──────────────── */

describe('alerts — fallback rate (> 0.25 warn, > 0.5 critical)', () => {
  function withFallbackRate(fallbacks: number, requests: number) {
    const rows = [...completes(requests), ...Array.from({ length: fallbacks }, () => t('ai_fallback', {}))]
    return computeAiHealth(rows, [], HOUR)
  }

  it('exactly AT the warn threshold does not fire (strictly greater-than)', () => {
    expect(FALLBACK_WARN).toBe(0.25)
    const h = withFallbackRate(1, 4) // rate = 0.25
    expect(h.alerts.find((a) => a.id === 'fallback_rate')).toBeUndefined()
  })

  it('just above warn fires a warn', () => {
    const h = withFallbackRate(2, 7) // ≈0.286
    const a = h.alerts.find((al) => al.id === 'fallback_rate')
    expect(a?.severity).toBe('warn')
    expect(a?.threshold).toBe(FALLBACK_WARN)
  })

  it('exactly AT the critical threshold stays a warn; above it goes critical', () => {
    expect(FALLBACK_CRIT).toBe(0.5)
    expect(withFallbackRate(2, 4).alerts.find((a) => a.id === 'fallback_rate')?.severity).toBe('warn') // 0.5
    const crit = withFallbackRate(3, 4).alerts.find((a) => a.id === 'fallback_rate') // 0.75
    expect(crit?.severity).toBe('critical')
    expect(crit?.threshold).toBe(FALLBACK_CRIT)
  })

  it('never fires with zero requests, even with stray fallback rows', () => {
    const h = computeAiHealth([t('ai_fallback', {})], [], HOUR)
    expect(h.fallbackRate).toBeNull()
    expect(h.alerts).toEqual([])
  })
})

describe('alerts — success rate (< 0.9 critical)', () => {
  function withSuccessRate(ok: number, failed: number) {
    const rows = [...completes(ok), ...Array.from({ length: failed }, () => t('ai_error', { code: 'x' }))]
    return computeAiHealth(rows, [], HOUR)
  }

  it('exactly AT 0.9 does not fire (strictly less-than)', () => {
    expect(SUCCESS_CRIT).toBe(0.9)
    const h = withSuccessRate(9, 1)
    expect(h.successRate).toBeCloseTo(0.9, 10)
    expect(h.alerts.find((a) => a.id === 'success_rate')).toBeUndefined()
  })

  it('just below 0.9 fires a critical', () => {
    const h = withSuccessRate(8, 1) // ≈0.889
    const a = h.alerts.find((al) => al.id === 'success_rate')
    expect(a?.severity).toBe('critical')
    expect(a?.threshold).toBe(SUCCESS_CRIT)
  })

  it('does not fire on an empty window (null success rate is not "low")', () => {
    expect(computeAiHealth([], [], HOUR).alerts.find((a) => a.id === 'success_rate')).toBeUndefined()
  })
})

describe('alerts — timeouts (≥ 5/h warn, normalized by window)', () => {
  function withTimeouts(n: number, windowMs: number) {
    return computeAiHealth(Array.from({ length: n }, () => t('ai_timeout', { layer: 'idle' })), [], windowMs)
  }

  it('4/h does not fire; exactly 5/h fires (at-or-above)', () => {
    expect(TIMEOUTS_PER_HOUR_WARN).toBe(5)
    expect(withTimeouts(4, HOUR).alerts.find((a) => a.id === 'timeouts')).toBeUndefined()
    const a = withTimeouts(5, HOUR).alerts.find((al) => al.id === 'timeouts')
    expect(a?.severity).toBe('warn')
    expect(a?.value).toBe(5)
    expect(a?.threshold).toBe(TIMEOUTS_PER_HOUR_WARN)
  })

  it('normalizes by window length: 120 timeouts over 24h = 5/h → fires; 119 does not', () => {
    expect(withTimeouts(120, DAY).alerts.find((a) => a.id === 'timeouts')?.value).toBe(5)
    expect(withTimeouts(119, DAY).alerts.find((a) => a.id === 'timeouts')).toBeUndefined()
  })
})

describe('alerts — rate-limited actions (> 10/h warn, normalized by window)', () => {
  function withRateLimited(n: number, windowMs: number) {
    const rows = Array.from({ length: n }, () => action({ status: 'failed', error: 'rate_limited' }))
    return computeAiHealth([], rows, windowMs)
  }

  it('exactly 10/h does not fire (strictly greater-than); 11/h fires', () => {
    expect(RATE_LIMITED_PER_HOUR_WARN).toBe(10)
    expect(withRateLimited(10, HOUR).alerts.find((a) => a.id === 'rate_limited')).toBeUndefined()
    const a = withRateLimited(11, HOUR).alerts.find((al) => al.id === 'rate_limited')
    expect(a?.severity).toBe('warn')
    expect(a?.value).toBe(11)
  })

  it('normalizes by window: 240 over 24h = 10/h → quiet; 264 (11/h) fires', () => {
    expect(withRateLimited(240, DAY).alerts.find((a) => a.id === 'rate_limited')).toBeUndefined()
    expect(withRateLimited(264, DAY).alerts.find((a) => a.id === 'rate_limited')?.value).toBeCloseTo(11, 10)
  })

  it('only failures with error === "rate_limited" count', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => action({ status: 'failed', error: 'network' })),
      action({ status: 'success', error: null }),
    ]
    const h = computeAiHealth([], rows, HOUR)
    expect(h.rateLimited).toBe(0)
    expect(h.alerts.find((a) => a.id === 'rate_limited')).toBeUndefined()
  })
})

describe('alerts — multiple conditions fire together', () => {
  it('a bad hour raises fallback + success + timeout + rate-limited simultaneously', () => {
    const rows = [
      ...completes(1),
      t('ai_error', { code: 'x' }),
      t('ai_fallback', {}),
      t('ai_fallback', {}),
      ...Array.from({ length: 5 }, () => t('ai_timeout', { layer: 'connect' })),
    ]
    const acts = Array.from({ length: 11 }, () => action({ status: 'failed', error: 'rate_limited' }))
    const h = computeAiHealth(rows, acts, HOUR)
    expect(h.alerts.map((a) => a.id).sort()).toEqual(['fallback_rate', 'rate_limited', 'success_rate', 'timeouts'])
    expect(h.alerts.find((a) => a.id === 'fallback_rate')?.severity).toBe('critical') // 2/2 = 1.0
  })
})
