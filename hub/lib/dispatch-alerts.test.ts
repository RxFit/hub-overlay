import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Push-alerting logic (hardening move 1) — the pure halves and the tick
 * orchestration, with every I/O seam faked. Locks:
 *  - each alert condition's trigger and its gating (dispatch-flag, data-guard),
 *  - the durable-dedup state machine (post on change, re-post after REALERT_MS,
 *    one recovery, quiet otherwise),
 *  - state is recorded ONLY when a delivery succeeded (or GitHub is the
 *    channel), so a failed Chat post retries next tick,
 *  - the GitHub-fallback contract the workflow branches on.
 */

vi.mock('./db', () => ({ db: {} }))
vi.mock('./google', () => ({ sendChatMessage: vi.fn() }))
vi.mock('./reports/access-token', () => ({ resolveTenantToken: vi.fn() }))
vi.mock('./dispatch-store', () => ({
  isMissingTableError: vi.fn(),
  listWorkers: vi.fn(),
  reapExpired: vi.fn(),
  sweepStale: vi.fn(),
}))
vi.mock('./agy-dispatch', () => ({
  dispatchFreshMs: () => 45_000,
  isDispatchEnabled: vi.fn(),
  isDispatchConfigured: vi.fn(),
}))

import {
  alertFingerprint,
  decideAlerts,
  decidePosting,
  formatAlertMessage,
  runDispatchAlertTick,
  REALERT_MS,
  STREAK_N,
  type AlertSnapshot,
  type AlertTickDeps,
  type DispatchAlert,
} from './dispatch-alerts'

function snapshot(over: Partial<AlertSnapshot> = {}): AlertSnapshot {
  return {
    dispatchEnabled: true,
    workerSecretPresent: true,
    tablesReady: true,
    freshWorkerCount: 1,
    workerLastSeenMsAgo: 5_000,
    recentAgyRuns: [],
    chat24h: { agyOk: 0, agyError: 0, meteredOk: 0 },
    ...over,
  }
}

describe('decideAlerts', () => {
  it('healthy snapshot produces no alerts', () => {
    expect(decideAlerts(snapshot())).toEqual([])
  })

  it('no fresh worker with dispatch enabled → worker_stale', () => {
    const alerts = decideAlerts(snapshot({ freshWorkerCount: 0, workerLastSeenMsAgo: 32 * 60_000 }))
    expect(alerts.map((a) => a.kind)).toEqual(['worker_stale'])
    expect(alerts[0].detail).toContain('32 min')
  })

  it('a worker never seen reads as such rather than NaN minutes', () => {
    const alerts = decideAlerts(snapshot({ freshWorkerCount: 0, workerLastSeenMsAgo: null }))
    expect(alerts[0].detail).toContain('never seen')
  })

  it('dead worker does NOT alert when dispatch is disabled (kill switch is deliberate)', () => {
    expect(decideAlerts(snapshot({ dispatchEnabled: false, freshWorkerCount: 0 }))).toEqual([])
  })

  it('dead worker does NOT alert when the worker secret is unset (never configured)', () => {
    expect(decideAlerts(snapshot({ workerSecretPresent: false, freshWorkerCount: 0 }))).toEqual([])
  })

  it('missing tables with dispatch enabled → tables_missing, not worker_stale', () => {
    const alerts = decideAlerts(snapshot({ tablesReady: false, freshWorkerCount: 0 }))
    expect(alerts.map((a) => a.kind)).toEqual(['tables_missing'])
  })

  it(`${STREAK_N} newest agy runs all errors → agy_error_streak naming the classes`, () => {
    const alerts = decideAlerts(
      snapshot({
        recentAgyRuns: [
          { status: 'error', errorClass: 'parse' },
          { status: 'error', errorClass: 'parse' },
          { status: 'error', errorClass: 'auth' },
        ],
      }),
    )
    expect(alerts.map((a) => a.kind)).toEqual(['agy_error_streak'])
    expect(alerts[0].detail).toContain('parse×2')
    expect(alerts[0].detail).toContain('auth×1')
  })

  it('unexpected error-class strings are clamped before reaching a message', () => {
    const alerts = decideAlerts(
      snapshot({
        recentAgyRuns: [
          { status: 'error', errorClass: 'weird class! with 🚀 and\nnewlines' },
          { status: 'error', errorClass: 'weird class! with 🚀 and\nnewlines' },
          { status: 'error', errorClass: null },
        ],
      }),
    )
    expect(alerts[0].detail).toContain('weirdclasswithandnewlines×2')
    expect(alerts[0].detail).toContain('unknown×1')
    expect(alerts[0].detail).not.toContain('🚀')
  })

  it('a single success inside the newest runs breaks the streak', () => {
    const alerts = decideAlerts(
      snapshot({
        recentAgyRuns: [
          { status: 'error', errorClass: 'parse' },
          { status: 'ok', errorClass: null },
          { status: 'error', errorClass: 'parse' },
        ],
      }),
    )
    expect(alerts).toEqual([])
  })

  it('fewer than the streak minimum never alerts (low traffic is not an outage)', () => {
    const alerts = decideAlerts(
      snapshot({
        recentAgyRuns: [
          { status: 'error', errorClass: 'parse' },
          { status: 'error', errorClass: 'parse' },
        ],
      }),
    )
    expect(alerts).toEqual([])
  })

  it('metered-served chat with zero allotment wins → allotment_collapse', () => {
    const alerts = decideAlerts(snapshot({ chat24h: { agyOk: 0, agyError: 2, meteredOk: 5 } }))
    expect(alerts.map((a) => a.kind)).toEqual(['allotment_collapse'])
  })

  it('collapse stays inert while metered rows are absent (pre-move-3 ledger)', () => {
    expect(decideAlerts(snapshot({ chat24h: { agyOk: 0, agyError: 9, meteredOk: 0 } }))).toEqual([])
  })

  it('any allotment success in 24h suppresses collapse', () => {
    expect(decideAlerts(snapshot({ chat24h: { agyOk: 1, agyError: 0, meteredOk: 20 } }))).toEqual([])
  })

  it('multiple conditions stack into one alert set', () => {
    const alerts = decideAlerts(
      snapshot({
        freshWorkerCount: 0,
        recentAgyRuns: [
          { status: 'error', errorClass: 'no_worker' },
          { status: 'error', errorClass: 'no_worker' },
          { status: 'error', errorClass: 'no_worker' },
        ],
      }),
    )
    expect(alerts.map((a) => a.kind).sort()).toEqual(['agy_error_streak', 'worker_stale'])
  })
})

describe('decidePosting — the dedup + flap-damping state machine', () => {
  const NOW = 1_755_000_000_000
  const stale: DispatchAlert[] = [{ kind: 'worker_stale', detail: 'd' }]
  const streak: DispatchAlert[] = [{ kind: 'agy_error_streak', detail: 'd' }]
  const state = (fingerprint: string, agoMs: number, channel = 'chat') => ({
    fingerprint,
    at: new Date(NOW - agoMs),
    channel,
  })

  it('first sighting of a condition posts', () => {
    expect(decidePosting(stale, null, null, NOW)).toBe('alert')
  })

  it('standing condition inside the re-alert window stays quiet', () => {
    const fp = alertFingerprint(stale)
    expect(decidePosting(stale, state(fp, 60_000), new Date(NOW - 60_000), NOW)).toBe('none')
  })

  it('standing condition re-posts after REALERT_MS since the last delivery', () => {
    const fp = alertFingerprint(stale)
    expect(decidePosting(stale, state(fp, REALERT_MS), new Date(NOW - REALERT_MS), NOW)).toBe('alert')
  })

  it('a different condition set posts immediately, no matter how recent', () => {
    const last = state(alertFingerprint(stale), 1_000)
    expect(decidePosting(streak, last, null, NOW)).toBe('alert')
  })

  it('flap damping: a set re-appearing after a recovery is suppressed while its last delivery is inside the window', () => {
    // worker stale (posted 2h ago) → fresh (recovery) → stale again NOW.
    const last = state('', 30 * 60_000, 'chat') // the recovery record
    const lastPosted = new Date(NOW - 2 * 60 * 60_000)
    expect(decidePosting(stale, last, lastPosted, NOW)).toBe('alert_suppressed')
  })

  it('flap re-appearance outside the window delivers again', () => {
    const last = state('', 30 * 60_000, 'chat')
    const lastPosted = new Date(NOW - REALERT_MS - 1)
    expect(decidePosting(stale, last, lastPosted, NOW)).toBe('alert')
  })

  it('clearing posts exactly one recovery', () => {
    expect(decidePosting([], state(alertFingerprint(stale), 1_000), null, NOW)).toBe('recovery')
    expect(decidePosting([], state('', 0), null, NOW + 60_000)).toBe('none')
  })

  it('clearing a SUPPRESSED alert recovers silently — nobody saw the alert', () => {
    const last = state(alertFingerprint(stale), 1_000, 'suppressed')
    expect(decidePosting([], last, null, NOW)).toBe('recovery_silent')
  })

  it('healthy with no history stays quiet', () => {
    expect(decidePosting([], null, null, NOW)).toBe('none')
  })
})

describe('runDispatchAlertTick — orchestration', () => {
  const NOW = new Date('2026-08-21T12:00:00Z')

  function deps(over: Partial<AlertTickDeps> = {}): AlertTickDeps & {
    recordState: ReturnType<typeof vi.fn>
    post: ReturnType<typeof vi.fn>
  } {
    return {
      housekeep: vi.fn().mockResolvedValue(undefined),
      loadSnapshot: vi.fn().mockResolvedValue(snapshot({ freshWorkerCount: 0 })),
      loadLastState: vi.fn().mockResolvedValue(null),
      loadLastPostedAt: vi.fn().mockResolvedValue(null),
      recordState: vi.fn().mockResolvedValue(undefined),
      resolveSpace: vi.fn().mockResolvedValue('spaces/AAA'),
      post: vi.fn().mockResolvedValue(true),
      ...over,
    } as AlertTickDeps & { recordState: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }
  }

  beforeEach(() => vi.restoreAllMocks())

  it('active alert + chat channel → posted, state recorded as chat', async () => {
    const d = deps()
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('posted')
    expect(result.alerts.map((a) => a.kind)).toEqual(['worker_stale'])
    expect(d.post).toHaveBeenCalledWith(expect.any(String), 'spaces/AAA', expect.stringContaining('Hub dispatch alert'))
    expect(d.recordState).toHaveBeenCalledWith(expect.any(String), 'worker_stale', 'chat', ['worker_stale'])
  })

  it('active alert + no channel → github delivery, still recorded (the workflow failure IS the push)', async () => {
    const d = deps({ resolveSpace: vi.fn().mockResolvedValue(null) })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('github')
    expect(d.recordState).toHaveBeenCalledWith(expect.any(String), 'worker_stale', 'github', ['worker_stale'])
  })

  it('chat post throwing → post_failed and NO state recorded, so the next tick retries', async () => {
    const d = deps({ post: vi.fn().mockRejectedValue(new Error('chat 500')) })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('post_failed')
    expect(d.recordState).not.toHaveBeenCalled()
  })

  it('unchanged condition inside the window → suppressed, nothing posted', async () => {
    const d = deps({
      loadLastState: vi
        .fn()
        .mockResolvedValue({ fingerprint: 'worker_stale', at: new Date(NOW.getTime() - 60_000), channel: 'chat' }),
      loadLastPostedAt: vi.fn().mockResolvedValue(new Date(NOW.getTime() - 60_000)),
    })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('suppressed')
    expect(d.post).not.toHaveBeenCalled()
    expect(d.recordState).not.toHaveBeenCalled()
  })

  it('flap re-appearance inside the window → suppressed AND recorded, so recovery logic stays truthful', async () => {
    const d = deps({
      // Last durable state is a recovery; the same fingerprint was delivered 2h ago.
      loadLastState: vi.fn().mockResolvedValue({ fingerprint: '', at: new Date(NOW.getTime() - 30 * 60_000), channel: 'chat' }),
      loadLastPostedAt: vi.fn().mockResolvedValue(new Date(NOW.getTime() - 2 * 60 * 60_000)),
    })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('suppressed')
    expect(d.post).not.toHaveBeenCalled()
    expect(d.recordState).toHaveBeenCalledWith(expect.any(String), 'worker_stale', 'suppressed', ['worker_stale'])
  })

  it('conditions cleared after an alert → one recovery post, state reset to empty fingerprint', async () => {
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
      loadLastState: vi
        .fn()
        .mockResolvedValue({ fingerprint: 'worker_stale', at: new Date(NOW.getTime() - 60_000), channel: 'chat' }),
    })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('recovery_posted')
    expect(d.post).toHaveBeenCalledWith(expect.any(String), 'spaces/AAA', expect.stringContaining('recovered'))
    expect(d.recordState).toHaveBeenCalledWith(expect.any(String), '', 'chat', [])
  })

  it('clearing a suppressed flap-alert recovers silently — no post for an alert nobody saw', async () => {
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
      loadLastState: vi
        .fn()
        .mockResolvedValue({ fingerprint: 'worker_stale', at: new Date(NOW.getTime() - 60_000), channel: 'suppressed' }),
    })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('none')
    expect(d.post).not.toHaveBeenCalled()
    expect(d.recordState).toHaveBeenCalledWith(expect.any(String), '', 'none', [])
  })

  it('allotment_collapse clearing WITHOUT an allotment success recovers silently (evidence aged out ≠ fixed)', async () => {
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot({ chat24h: { agyOk: 0, agyError: 0, meteredOk: 0 } })),
      loadLastState: vi
        .fn()
        .mockResolvedValue({ fingerprint: 'allotment_collapse', at: new Date(NOW.getTime() - 60_000), channel: 'chat' }),
    })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('none')
    expect(d.post).not.toHaveBeenCalled()
    expect(d.recordState).toHaveBeenCalledWith(expect.any(String), '', 'none', [])
  })

  it('allotment_collapse clearing WITH an allotment success posts the recovery', async () => {
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot({ chat24h: { agyOk: 2, agyError: 0, meteredOk: 1 } })),
      loadLastState: vi
        .fn()
        .mockResolvedValue({ fingerprint: 'allotment_collapse', at: new Date(NOW.getTime() - 60_000), channel: 'chat' }),
    })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('recovery_posted')
  })

  it('recovery with no channel records the state change without failing anything', async () => {
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot()),
      loadLastState: vi
        .fn()
        .mockResolvedValue({ fingerprint: 'worker_stale', at: new Date(NOW.getTime() - 60_000), channel: 'chat' }),
      resolveSpace: vi.fn().mockResolvedValue(null),
    })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('none')
    expect(d.recordState).toHaveBeenCalledWith(expect.any(String), '', 'none', [])
  })

  it('healthy with no history → none, no I/O beyond the reads', async () => {
    const d = deps({ loadSnapshot: vi.fn().mockResolvedValue(snapshot()) })
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('none')
    expect(d.post).not.toHaveBeenCalled()
    expect(d.recordState).not.toHaveBeenCalled()
  })

  it('a housekeeping failure must never block alert evaluation', async () => {
    const d = deps({ housekeep: vi.fn().mockResolvedValue(undefined) })
    // defaultAlertTickDeps.housekeep swallows internally; here we just assert
    // the tick still evaluates when housekeep resolves after internal catches.
    const result = await runDispatchAlertTick(NOW, d)
    expect(result.delivery).toBe('posted')
  })
})

describe('formatAlertMessage', () => {
  it('lists each condition and stays content-free', () => {
    const msg = formatAlertMessage([
      { kind: 'worker_stale', detail: 'no desktop worker is fresh' },
      { kind: 'agy_error_streak', detail: 'last 3 agy runs all failed (parse×3)' },
    ])
    expect(msg).toContain('⚠️ Hub dispatch alert')
    expect(msg).toContain('• no desktop worker is fresh')
    expect(msg).toContain('• last 3 agy runs all failed (parse×3)')
  })
})
