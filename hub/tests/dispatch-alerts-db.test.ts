import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, getSql, closeDb, seedTenant } from '../test/db-harness'
import { upsertWorker } from '@/lib/dispatch-store'
import {
  defaultAlertTickDeps,
  loadAlertSnapshot,
  runDispatchAlertTick,
  REALERT_MS,
  type AlertSnapshot,
} from '@/lib/dispatch-alerts'

/**
 * Push alerting against REAL Postgres (skipped without DATABASE_URL; CI
 * provides one). Locks the two halves the unit tests fake:
 *  - the ai_runs / dispatch_workers snapshot queries (24h window, newest-first
 *    streak, chat GROUP BY),
 *  - the durable dedup state in event_log — alert once, suppress inside the
 *    re-alert window, recover once — across what would be separate instances.
 */

const HOUR = 60 * 60 * 1000

function insertRun(sql: ReturnType<typeof getSql>, over: {
  engine?: string
  source?: string
  status?: string
  errorClass?: string | null
  agoMs?: number
}) {
  const at = new Date(Date.now() - (over.agoMs ?? 0))
  return sql`
    INSERT INTO ai_runs (engine, source, status, error_class, latency_ms, created_at)
    VALUES (${over.engine ?? 'agy'}, ${over.source ?? 'chat'}, ${over.status ?? 'ok'},
            ${over.errorClass ?? null}, 1000, ${at})
  `
}

describeDb('dispatch alerts (Postgres)', () => {
  beforeAll(() => {
    migrateTestDb()
    process.env.AGY_DISPATCH_ENABLED = 'true'
    process.env.AGY_WORKER_SECRET = 'x'.repeat(64)
  })

  beforeEach(async () => {
    const sql = getSql()
    await sql`DELETE FROM ai_runs`
    await sql`DELETE FROM dispatch_workers`
    await sql`DELETE FROM event_log`
    await seedTenant()
  })

  afterAll(async () => {
    delete process.env.AGY_DISPATCH_ENABLED
    delete process.env.AGY_WORKER_SECRET
    await closeDb()
  })

  it('snapshot: fresh vs stale workers, streak window, and chat 24h counts', async () => {
    const sql = getSql()
    await upsertWorker('danny-desktop', { version: 'abc', agyVersion: '1.1.16' })
    // Newest three agy runs are errors; an older ok sits OUTSIDE the limit and
    // a 25h-old error sits outside the 24h window entirely.
    await insertRun(sql, { status: 'error', errorClass: 'parse', agoMs: 1 * HOUR })
    await insertRun(sql, { status: 'error', errorClass: 'parse', agoMs: 2 * HOUR })
    await insertRun(sql, { status: 'error', errorClass: 'auth', agoMs: 3 * HOUR })
    await insertRun(sql, { status: 'ok', agoMs: 4 * HOUR })
    await insertRun(sql, { status: 'error', errorClass: 'timeout', agoMs: 25 * HOUR })
    // A client abort NEWER than everything must not enter the streak set —
    // a closed tab is not an engine failure.
    await insertRun(sql, { status: 'error', errorClass: 'abort', agoMs: HOUR / 2 })
    // Metered chat rows (what move 3 will write) + a non-chat agy probe row
    // that must not count toward chat24h (older than the newest three, so it
    // stays out of the streak limit too).
    await insertRun(sql, { engine: 'gemini', status: 'ok', agoMs: 1 * HOUR })
    await insertRun(sql, { engine: 'claude', status: 'ok', agoMs: 2 * HOUR })
    await insertRun(sql, { source: 'dispatch_probe', status: 'ok', agoMs: 5 * HOUR })

    const s: AlertSnapshot = await loadAlertSnapshot()
    expect(s.dispatchEnabled).toBe(true)
    expect(s.workerSecretPresent).toBe(true)
    expect(s.tablesReady).toBe(true)
    expect(s.freshWorkerCount).toBe(1)
    expect(s.recentAgyRuns).toHaveLength(3)
    expect(s.recentAgyRuns.every((r) => r.status === 'error')).toBe(true)
    expect(s.recentAgyRuns.map((r) => r.errorClass).sort()).toEqual(['auth', 'parse', 'parse'])
    // chat24h: 1 agy ok (the 4h-old chat row), 4 agy errors (abort included —
    // it is excluded from the STREAK, not from the ledger counts), 2 metered.
    expect(s.chat24h).toEqual({ agyOk: 1, agyError: 4, meteredOk: 2 })
  })

  it('snapshot: the streak is unwindowed — old failures with no traffic since still count', async () => {
    const sql = getSql()
    await insertRun(sql, { status: 'error', errorClass: 'auth', agoMs: 48 * HOUR })
    await insertRun(sql, { status: 'error', errorClass: 'auth', agoMs: 49 * HOUR })
    await insertRun(sql, { status: 'error', errorClass: 'auth', agoMs: 50 * HOUR })
    const s = await loadAlertSnapshot()
    // A quiet weekend must not read as "recovered": the newest runs in the
    // ledger are still all failures.
    expect(s.recentAgyRuns).toHaveLength(3)
    expect(s.recentAgyRuns.every((r) => r.status === 'error')).toBe(true)
    // ...but they are outside the 24h chat window, so counts there are zero.
    expect(s.chat24h).toEqual({ agyOk: 0, agyError: 0, meteredOk: 0 })
  })

  it('snapshot: a worker beyond dispatchFreshMs is stale and reports its age', async () => {
    const sql = getSql()
    await upsertWorker('danny-desktop', { version: 'abc', agyVersion: '1.1.16' })
    await sql`UPDATE dispatch_workers SET last_seen_at = now() - interval '30 minutes'`
    const s = await loadAlertSnapshot()
    expect(s.freshWorkerCount).toBe(0)
    expect(s.workerLastSeenMsAgo).toBeGreaterThan(29 * 60_000)
  })

  it('durable dedup: alert once, suppress within the window, re-alert after it, recover once', async () => {
    const staleSnapshot: AlertSnapshot = {
      dispatchEnabled: true,
      workerSecretPresent: true,
      tablesReady: true,
      freshWorkerCount: 0,
      workerLastSeenMsAgo: 30 * 60_000,
      recentAgyRuns: [],
      chat24h: { agyOk: 0, agyError: 0, meteredOk: 0 },
    }
    const healthySnapshot: AlertSnapshot = { ...staleSnapshot, freshWorkerCount: 1 }
    // Real loadLastState/recordState against event_log; everything else faked.
    // No Chat channel → the 'github' path, which still records durable state.
    const deps = (snap: AlertSnapshot) => ({
      ...defaultAlertTickDeps,
      housekeep: async () => {},
      loadSnapshot: async () => snap,
      resolveSpace: async () => null,
      post: async () => {
        throw new Error('no chat in this test')
      },
    })

    const t0 = new Date()
    const first = await runDispatchAlertTick(t0, deps(staleSnapshot))
    expect(first.delivery).toBe('github')

    const second = await runDispatchAlertTick(new Date(t0.getTime() + HOUR), deps(staleSnapshot))
    expect(second.delivery).toBe('suppressed')

    const third = await runDispatchAlertTick(new Date(t0.getTime() + REALERT_MS + HOUR), deps(staleSnapshot))
    expect(third.delivery).toBe('github')

    const recovery = await runDispatchAlertTick(new Date(t0.getTime() + REALERT_MS + 2 * HOUR), deps(healthySnapshot))
    expect(recovery.delivery).toBe('none')

    const quiet = await runDispatchAlertTick(new Date(t0.getTime() + REALERT_MS + 3 * HOUR), deps(healthySnapshot))
    expect(quiet.delivery).toBe('none')

    const sql = getSql()
    const rows = await sql`SELECT payload FROM event_log WHERE event_type = 'dispatch.alert' ORDER BY created_at`
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => (r.payload as { fingerprint: string }).fingerprint)).toEqual([
      'worker_stale',
      'worker_stale',
      '',
    ])
  })
})
