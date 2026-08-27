import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, getSql, closeDb, seedTenant } from '../test/db-harness'
import {
  claimReportWindow,
  releaseReportWindow,
  completeReportWindow,
  pruneReportRuns,
  findClaimedWindows,
  windowKey,
} from '@/lib/reports/run-guard'

/**
 * report_runs against REAL Postgres (skipped without DATABASE_URL; CI provides
 * one). The unit suite pins the call shape; this one proves the property that
 * actually protects the operator's inbox:
 *
 *   exactly one generation per (tenant, report, window) — including when two
 *   ticks race, which is the case a mocked database cannot demonstrate.
 *
 * The migration is exercised too: these tests fail if drizzle/migrate.mjs did
 * not create the table or its unique index, which is the only path that runs
 * on deploy.
 */

const CLAIM = {
  tenantId: 'rxfit',
  reportId: 'weekly-digest',
  windowStart: '2026-08-17',
  windowEnd: '2026-08-23',
}

describeDb('report_runs (Postgres)', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await getSql()`DELETE FROM report_runs`
    await seedTenant()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('the migration created the table and its unique index', async () => {
    const rows = await getSql()`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'report_runs' AND indexname = 'report_runs_window_uniq'
    `
    expect(rows).toHaveLength(1)
  })

  it('first claim wins; a second claim on the same window loses', async () => {
    expect(await claimReportWindow(CLAIM)).toBe(true)
    expect(await claimReportWindow(CLAIM)).toBe(false)
    const rows = await getSql()`SELECT report_id, window_start FROM report_runs`
    expect(rows).toHaveLength(1)
    expect(rows[0].report_id).toBe('weekly-digest')
  })

  it('CONCURRENT claims on one window: exactly one wins', async () => {
    // The duplicate-digest scenario: a scheduled tick and a manual dispatch
    // landing together. A read-then-write guard passes the sequential test
    // above and fails this one.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimReportWindow(CLAIM)),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await getSql()`SELECT count(*)::int AS n FROM report_runs`).toEqual([{ n: 1 }])
  })

  it('a different window of the same report is claimable — catch-up is per window', async () => {
    expect(await claimReportWindow(CLAIM)).toBe(true)
    expect(await claimReportWindow({ ...CLAIM, windowStart: '2026-08-24', windowEnd: '2026-08-30' })).toBe(true)
    expect(await getSql()`SELECT count(*)::int AS n FROM report_runs`).toEqual([{ n: 2 }])
  })

  it('a different report in the same window is claimable', async () => {
    expect(await claimReportWindow(CLAIM)).toBe(true)
    expect(await claimReportWindow({ ...CLAIM, reportId: 'monthly-review' })).toBe(true)
    expect(await getSql()`SELECT count(*)::int AS n FROM report_runs`).toEqual([{ n: 2 }])
  })

  it('release frees the window so a later tick retries it', async () => {
    expect(await claimReportWindow(CLAIM)).toBe(true)
    await releaseReportWindow(CLAIM)
    expect(await getSql()`SELECT count(*)::int AS n FROM report_runs`).toEqual([{ n: 0 }])
    // The retry is the point: a transient Google error must not burn the day.
    expect(await claimReportWindow(CLAIM)).toBe(true)
  })

  it('release NEVER removes a completed run — a generated report stays recorded', async () => {
    await claimReportWindow(CLAIM)
    await completeReportWindow(CLAIM, 'doc-abc')
    await releaseReportWindow(CLAIM)

    const rows = await getSql()`SELECT document_id FROM report_runs`
    expect(rows).toHaveLength(1)
    expect(rows[0].document_id).toBe('doc-abc')
    // And it stays un-claimable, so no duplicate can follow a completed run.
    expect(await claimReportWindow(CLAIM)).toBe(false)
  })

  it('completion records the artifact id against the claim', async () => {
    await claimReportWindow(CLAIM)
    await completeReportWindow(CLAIM, 'doc-xyz')
    const rows = await getSql()`SELECT document_id, window_end FROM report_runs`
    expect(rows[0].document_id).toBe('doc-xyz')
    expect(rows[0].window_end).toBe('2026-08-23')
  })

  it('prune trims old rows and keeps recent ones', async () => {
    await claimReportWindow(CLAIM)
    await getSql()`
      INSERT INTO report_runs (tenant_id, report_id, window_start, created_at)
      VALUES ('rxfit', 'ancient', '2020-01-01', now() - interval '400 days')
    `
    await pruneReportRuns(365)
    const rows = await getSql()`SELECT report_id FROM report_runs`
    expect(rows.map(r => r.report_id)).toEqual(['weekly-digest'])
  })

  it('findClaimedWindows reports only genuinely claimed pairs', async () => {
    await claimReportWindow(CLAIM)
    await claimReportWindow({ ...CLAIM, reportId: 'monthly-review', windowStart: '2026-08-01' })

    const claimed = await findClaimedWindows('rxfit', [
      { reportId: 'weekly-digest', windowStart: '2026-08-17' },   // claimed
      { reportId: 'monthly-review', windowStart: '2026-08-01' },  // claimed
      { reportId: 'weekly-digest', windowStart: '2026-08-24' },   // not yet
      // The cross-match trap: both halves exist in the table, but never as
      // this pair. A row-trusting implementation would wrongly skip it.
      { reportId: 'monthly-review', windowStart: '2026-08-17' },
    ])

    expect(claimed.has(windowKey('weekly-digest', '2026-08-17'))).toBe(true)
    expect(claimed.has(windowKey('monthly-review', '2026-08-01'))).toBe(true)
    expect(claimed.has(windowKey('weekly-digest', '2026-08-24'))).toBe(false)
    expect(claimed.has(windowKey('monthly-review', '2026-08-17'))).toBe(false)
  })

  it('is scoped by tenant — another tenant\'s claim never masks ours', async () => {
    await getSql()`INSERT INTO tenants (id, name, domain) VALUES ('other', 'Other', 'other.test') ON CONFLICT (id) DO NOTHING`
    await claimReportWindow({ ...CLAIM, tenantId: 'other' })

    const claimed = await findClaimedWindows('rxfit', [
      { reportId: CLAIM.reportId, windowStart: CLAIM.windowStart },
    ])
    expect(claimed.size).toBe(0)
    // …and rxfit can still claim its own.
    expect(await claimReportWindow(CLAIM)).toBe(true)
  })
})
