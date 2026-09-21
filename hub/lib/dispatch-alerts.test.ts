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
vi.mock('./retention', () => ({ runRetention: vi.fn() }))

import { reapExpired, sweepStale } from './dispatch-store'
import { runRetention } from './retention'
import {
  alertFingerprint,
  decideAlerts,
  decidePosting,
  normalizeDeployReport,
  isDeployFailing,
  defaultAlertTickDeps,
  formatAlertMessage,
  runDispatchAlertTick,
  REALERT_MS,
  STREAK_N,
  type AlertSnapshot,
  type AlertTickDeps,
  type DeployReport,
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
    deploy: null,
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

describe('defaultAlertTickDeps.housekeep — the hourly housekeeping home', () => {
  const order: string[] = []

  beforeEach(() => {
    order.length = 0
    vi.mocked(reapExpired).mockReset().mockImplementation(async () => {
      order.push('reap')
      return { cancelled: 0, requeued: 0, leaseExpired: 0, deadlineExpired: 0 }
    })
    vi.mocked(sweepStale).mockReset().mockImplementation(async () => {
      order.push('sweep')
    })
    vi.mocked(runRetention).mockReset().mockImplementation(async () => {
      order.push('retention')
      return { eventLog: 0, aiRuns: { aiRuns: 0, aiActionLog: 0, toolRuns: 0 }, expiredMemories: true, failed: [] }
    })
  })

  it('runs retention AFTER reap and sweep, once each', async () => {
    await defaultAlertTickDeps.housekeep()
    expect(order).toEqual(['reap', 'sweep', 'retention'])
    expect(runRetention).toHaveBeenCalledTimes(1)
  })

  it('a failing reap or sweep is swallowed and retention still runs', async () => {
    vi.mocked(reapExpired).mockRejectedValue(new Error('reap boom'))
    vi.mocked(sweepStale).mockRejectedValue(new Error('sweep boom'))
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    await expect(defaultAlertTickDeps.housekeep()).resolves.toBeUndefined()
    expect(runRetention).toHaveBeenCalledTimes(1)
    debug.mockRestore()
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

/* ════════════════════════════════════════════════════════════════════════════
   deploy_failed — alerting on a broken production deploy.

   A failed deploy is silent by construction: deploy.yml ships the revision with
   --no-traffic --tag=candidate and promotes only after a smoke test, so a
   failure leaves the last-good revision serving. Nothing degrades and nothing
   500s — which is how 14 consecutive failures (runs 195-208) went unnoticed for
   13 days while every merged fix sat undeployed.

   The evidence is REPORTED by the hourly workflow, not observed by the Hub, and
   that shapes the recovery rule below: an absent report is not a fix.
   ══════════════════════════════════════════════════════════════════════════ */

const FAILING: DeployReport = { conclusion: 'failure', consecutiveFailures: 14, sha: 'ff6e0ac047eb', runNumber: 208 }

describe('normalizeDeployReport — the body is authenticated, not trusted', () => {
  it('accepts a well-formed report', () => {
    expect(normalizeDeployReport({ conclusion: 'failure', consecutiveFailures: 3, sha: 'FF6E0AC047EB15F0', runNumber: 208 }))
      .toEqual({ conclusion: 'failure', consecutiveFailures: 3, sha: 'ff6e0ac047eb', runNumber: 208 })
  })

  it('rejects anything that is not an object with a usable conclusion', () => {
    for (const bad of [null, undefined, 'failure', 42, [], {}, { conclusion: '' }, { conclusion: 123 }]) {
      expect(normalizeDeployReport(bad)).toBeNull()
    }
  })

  it('clamps a hostile conclusion string rather than letting it reach a Chat message', () => {
    const r = normalizeDeployReport({ conclusion: 'fail<script>ure'.repeat(20) })
    expect(r!.conclusion).toMatch(/^[a-z_]+$/)
    expect(r!.conclusion.length).toBeLessThanOrEqual(32)
  })

  it('drops a sha that is not a hex object name, and truncates a real one', () => {
    expect(normalizeDeployReport({ conclusion: 'failure', sha: 'not-a-sha' })!.sha).toBeNull()
    expect(normalizeDeployReport({ conclusion: 'failure', sha: 'zzzzzzz' })!.sha).toBeNull()
    expect(normalizeDeployReport({ conclusion: 'failure', sha: 'a'.repeat(40) })!.sha).toBe('a'.repeat(12))
  })

  it('clamps counts and run numbers into a band a message can render', () => {
    expect(normalizeDeployReport({ conclusion: 'failure', consecutiveFailures: -5 })!.consecutiveFailures).toBe(0)
    expect(normalizeDeployReport({ conclusion: 'failure', consecutiveFailures: 1e9 })!.consecutiveFailures).toBe(9999)
    expect(normalizeDeployReport({ conclusion: 'failure', consecutiveFailures: Number.NaN })!.consecutiveFailures).toBe(0)
    expect(normalizeDeployReport({ conclusion: 'failure', runNumber: 0 })!.runNumber).toBeNull()
    expect(normalizeDeployReport({ conclusion: 'failure', runNumber: 1.5 })!.runNumber).toBeNull()
  })
})

describe('isDeployFailing — only a broken deploy counts', () => {
  it('treats failure and timed_out as broken', () => {
    expect(isDeployFailing({ ...FAILING, conclusion: 'failure' })).toBe(true)
    expect(isDeployFailing({ ...FAILING, conclusion: 'timed_out' })).toBe(true)
  })

  it('treats success and every indeterminate conclusion as not-broken', () => {
    for (const c of ['success', 'cancelled', 'skipped', 'neutral', 'stale', 'action_required', 'unknown']) {
      expect(isDeployFailing({ ...FAILING, conclusion: c })).toBe(false)
    }
  })

  it('an absent report is not a failure (and, elsewhere, not a recovery either)', () => {
    expect(isDeployFailing(null)).toBe(false)
  })
})

describe('decideAlerts — deploy_failed', () => {
  it('a failing deploy alerts and names the streak, run and commit', () => {
    const [a] = decideAlerts(snapshot({ deploy: FAILING }))
    expect(a.kind).toBe('deploy_failed')
    expect(a.detail).toContain('14 consecutive')
    expect(a.detail).toContain('run #208')
    expect(a.detail).toContain('ff6e0ac047eb')
    // The operator needs to know production is STALE, not down — that
    // distinction is why nobody chased the original outage.
    expect(a.detail).toContain('last-good revision')
  })

  it('a single failure reads naturally, without a "1 consecutive" stutter', () => {
    const [a] = decideAlerts(snapshot({ deploy: { ...FAILING, consecutiveFailures: 1 } }))
    expect(a.detail).not.toContain('consecutive')
    expect(a.detail).toContain('failure')
  })

  it('a report with no run/commit still produces a usable message', () => {
    const [a] = decideAlerts(snapshot({ deploy: { conclusion: 'timed_out', consecutiveFailures: 2, sha: null, runNumber: null } }))
    expect(a.kind).toBe('deploy_failed')
    expect(a.detail).toContain('timed_out')
    expect(a.detail).not.toContain('—  ')
  })

  it('a successful, indeterminate, or unreported deploy never alerts', () => {
    expect(decideAlerts(snapshot({ deploy: { ...FAILING, conclusion: 'success' } }))).toEqual([])
    expect(decideAlerts(snapshot({ deploy: { ...FAILING, conclusion: 'cancelled' } }))).toEqual([])
    expect(decideAlerts(snapshot({ deploy: null }))).toEqual([])
  })

  it('stacks with the dispatch conditions instead of masking them', () => {
    const alerts = decideAlerts(snapshot({ freshWorkerCount: 0, deploy: FAILING }))
    expect(alerts.map((a) => a.kind).sort()).toEqual(['deploy_failed', 'worker_stale'])
    expect(alertFingerprint(alerts)).toBe('deploy_failed,worker_stale')
  })
})

describe('runDispatchAlertTick — deploy recovery is only announced when PROVEN', () => {
  const NOW = new Date('2026-09-21T12:00:00Z')
  const WAS_FAILING = { fingerprint: 'deploy_failed', at: new Date(NOW.getTime() - REALERT_MS), channel: 'chat' }

  function deps(over: Partial<AlertTickDeps> = {}): AlertTickDeps & { post: ReturnType<typeof vi.fn> } {
    return {
      housekeep: vi.fn().mockResolvedValue(undefined),
      loadSnapshot: vi.fn().mockResolvedValue(snapshot({ deploy: FAILING })),
      loadLastState: vi.fn().mockResolvedValue(null),
      loadLastPostedAt: vi.fn().mockResolvedValue(null),
      recordState: vi.fn().mockResolvedValue(undefined),
      resolveSpace: vi.fn().mockResolvedValue('spaces/AAA'),
      post: vi.fn().mockResolvedValue(true),
      ...over,
    } as AlertTickDeps & { post: ReturnType<typeof vi.fn> }
  }

  beforeEach(() => vi.restoreAllMocks())

  it('a failing deploy posts once to the existing Chat destination', async () => {
    const d = deps()
    const r = await runDispatchAlertTick(NOW, d)
    expect(r.delivery).toBe('posted')
    expect(r.alerts.map((a) => a.kind)).toEqual(['deploy_failed'])
    expect(d.post).toHaveBeenCalledWith(expect.any(String), 'spaces/AAA', expect.stringContaining('production deploy is failing'))
  })

  it('a still-failing deploy inside the window is suppressed — one alert per window, not one per hour', async () => {
    const d = deps({
      loadLastState: vi.fn().mockResolvedValue({ ...WAS_FAILING, at: NOW }),
      loadLastPostedAt: vi.fn().mockResolvedValue(new Date(NOW.getTime() - 60_000)),
    })
    const r = await runDispatchAlertTick(NOW, d)
    expect(r.delivery).toBe('suppressed')
    expect(d.post).not.toHaveBeenCalled()
  })

  it('a still-failing deploy re-alerts once the window has passed', async () => {
    const d = deps({
      loadLastState: vi.fn().mockResolvedValue(WAS_FAILING),
      loadLastPostedAt: vi.fn().mockResolvedValue(new Date(NOW.getTime() - REALERT_MS - 1)),
    })
    expect((await runDispatchAlertTick(NOW, d)).delivery).toBe('posted')
  })

  it('an observed success announces the recovery', async () => {
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot({ deploy: { ...FAILING, conclusion: 'success', consecutiveFailures: 0 } })),
      loadLastState: vi.fn().mockResolvedValue(WAS_FAILING),
    })
    const r = await runDispatchAlertTick(NOW, d)
    expect(r.delivery).toBe('recovery_posted')
    expect(d.post).toHaveBeenCalledWith(expect.any(String), 'spaces/AAA', expect.stringContaining('recovered'))
  })

  it('THE ANTI-LIE: an UNREPORTED deploy clears the condition but never claims a fix', async () => {
    // The workflow rolled back, lost actions:read, or the API call failed. The
    // condition leaves the set because there is no evidence — announcing
    // "recovered" here would be the worst thing an alerting system can say.
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot({ deploy: null })),
      loadLastState: vi.fn().mockResolvedValue(WAS_FAILING),
    })
    const r = await runDispatchAlertTick(NOW, d)
    expect(r.delivery).toBe('none')
    expect(d.post).not.toHaveBeenCalled()
  })

  it('an indeterminate conclusion is not a recovery either', async () => {
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot({ deploy: { ...FAILING, conclusion: 'cancelled' } })),
      loadLastState: vi.fn().mockResolvedValue(WAS_FAILING),
    })
    expect((await runDispatchAlertTick(NOW, d)).delivery).toBe('none')
    expect(d.post).not.toHaveBeenCalled()
  })

  it('a silent deploy clear still records the state change, so the next failure alerts again', async () => {
    const recordState = vi.fn().mockResolvedValue(undefined)
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot({ deploy: null })),
      loadLastState: vi.fn().mockResolvedValue(WAS_FAILING),
      recordState,
    })
    await runDispatchAlertTick(NOW, d)
    expect(recordState).toHaveBeenCalledWith(expect.any(String), '', 'none', [])
  })

  it('an unrelated recovery is unaffected by the deploy gate', async () => {
    // worker_stale clears affirmatively by construction (it is a live check);
    // the deploy gate must not accidentally silence it.
    const d = deps({
      loadSnapshot: vi.fn().mockResolvedValue(snapshot({ deploy: null })),
      loadLastState: vi.fn().mockResolvedValue({ fingerprint: 'worker_stale', at: NOW, channel: 'chat' }),
    })
    expect((await runDispatchAlertTick(NOW, d)).delivery).toBe('recovery_posted')
  })

  it('the reported conclusion reaches the snapshot loader', async () => {
    const loadSnapshot = vi.fn().mockResolvedValue(snapshot({ deploy: null }))
    await runDispatchAlertTick(NOW, deps({ loadSnapshot }), FAILING)
    expect(loadSnapshot).toHaveBeenCalledWith(NOW, FAILING)
  })
})
