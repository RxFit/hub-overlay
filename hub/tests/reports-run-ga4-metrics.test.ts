import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/reports/run — the digest asks GA4 for metrics that still exist.

   T-69. Google renamed `conversions` → `keyEvents` in the Data API. The chat
   path learned to repair that (PR #187, GA4_METRIC_ALIASES); the SCHEDULED
   reports kept the retired name hardcoded. That is worse than it sounds: GA4
   validates the metric list as a unit, so one dead name failed the whole
   report, the runner swallowed the error into a note, and the weekly digest
   published on time with its entire traffic section missing.

   These tests run the REAL analytics module against fake property metadata —
   only the HTTP layer (googleFetch) is mocked. A revert to `conversions` fails
   validation against metadata that no longer lists it, so the assertions here
   break rather than passing on a mock that would accept any string.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    /** Metric API names the fake property claims to support. */
    propertyMetrics: ['sessions', 'totalUsers', 'screenPageViews', 'keyEvents'],
    /** Bodies POSTed to :runReport, in order. */
    reportBodies: [] as Record<string, unknown>[],
    /** Markdown handed to the Docs writer. */
    markdown: '',
  },
}))

vi.mock('@/lib/google/client', () => ({
  googleFetch: vi.fn(async (url: string, _token: string, init?: { body?: string }) => {
    if (url.includes('/metadata')) {
      return {
        dimensions: [{ apiName: 'pagePath' }],
        metrics: state.propertyMetrics.map(apiName => ({ apiName })),
      }
    }
    if (url.includes(':runReport')) {
      const body = JSON.parse(init?.body ?? '{}')
      state.reportBodies.push(body)
      const names: string[] = (body.metrics ?? []).map((m: { name: string }) => m.name)
      return {
        metricHeaders: names.map(name => ({ name })),
        rows: [{ metricValues: names.map((_, i) => ({ value: String(100 + i) })) }],
        rowCount: 1,
      }
    }
    throw new Error(`unexpected google call: ${url}`)
  }),
}))

vi.mock('@/lib/db', () => {
  // Two reads, in order: the prefs row (…where().limit(1)) and the admin list
  // (…where(), awaited directly). One thenable serves both shapes.
  let call = 0
  const rows = () => (call++ === 0 ? [{ reports: null, timezone: 'America/Chicago' }] : [{ email: 'admin@rxfitatx.com' }])
  const result = () => {
    const value = rows()
    return {
      limit: async () => value,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(value).then(res, rej),
    }
  }
  return {
    db: { select: () => ({ from: () => ({ where: () => result() }) }) },
  }
})

vi.mock('@/lib/tenant-context', () => ({ getTenantId: () => 'rxfit' }))
vi.mock('@/lib/google/prefs-db', () => ({
  getEffectivePrefs: vi.fn(async () => ({ ga4PropertyId: '424242', gscSiteUrl: null })),
}))
vi.mock('@/lib/reports/access-token', () => ({
  resolveTenantToken: vi.fn(async () => ({ accessToken: 'tok', email: 'admin@rxfitatx.com' })),
}))
// Only the weekly digest is due, and always — the cadence maths has its own
// suite (lib/reports/config.test.ts); pinning it here keeps this about metrics.
vi.mock('@/lib/reports/config', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/reports/config')>()
  return {
    ...actual,
    // The route selects with dueOrMissedReports (catch-up); dueReports is kept
    // overridden too so this stub survives either call site.
    dueReports: () => [actual.DEFAULT_REPORTS[0]],
    dueOrMissedReports: () => [actual.DEFAULT_REPORTS[0]],
    reportWindow: () => ({ startDate: '2026-08-03', endDate: '2026-08-09' }),
  }
})
vi.mock('@/lib/google/search-console', () => ({
  querySearchConsole: vi.fn(async () => undefined),
}))
vi.mock('@/lib/google/drive-workspace', () => ({
  ensureWorkspace: vi.fn(async () => ({ folders: { reports: 'folder-r', presentations: 'folder-p' } })),
}))
vi.mock('@/lib/google/drive-workspace-db', () => ({ dbWorkspaceStore: {} }))
vi.mock('@/lib/google/docs', () => ({
  createDocFromMarkdown: vi.fn(async (_t: string, args: { markdown: string }) => {
    state.markdown = args.markdown
    return { documentId: 'doc-1', documentUrl: 'https://docs.example/doc-1' }
  }),
}))
vi.mock('@/lib/google/slides', () => ({
  createDeckFromSpec: vi.fn(async () => ({ presentationId: 'deck-1', presentationUrl: 'https://slides.example/deck-1' })),
}))
vi.mock('@/lib/reports/deliver', () => ({
  deliverDigest: vi.fn(async () => ({ emailed: true, chatPosted: false, problems: [] })),
}))
// The per-window claim guard has its own suites (lib/reports/run-guard.test.ts
// for the contract, tests/report-runs-db.test.ts against real Postgres). Here
// it is stubbed to "claim won" so these cases stay about GA4 metric names —
// the db mock above only implements select().
const guardState = vi.hoisted(() => ({ claimThrows: false, alreadyClaimed: [] as string[] }))
vi.mock('@/lib/reports/run-guard', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/reports/run-guard')>()
  return {
    windowKey: actual.windowKey,
    claimReportWindow: vi.fn(async () => {
      if (guardState.claimThrows) throw new Error('connection terminated')
      return true
    }),
    releaseReportWindow: vi.fn(async () => {}),
    completeReportWindow: vi.fn(async () => {}),
    pruneReportRuns: vi.fn(async () => {}),
    findClaimedWindows: vi.fn(async () => new Set(guardState.alreadyClaimed)),
  }
})

vi.mock('@/lib/ai-audit', () => ({ recordAiAction: vi.fn(async () => {}) }))

import { POST } from '@/app/api/reports/run/route'
import { resolveTenantToken } from '@/lib/reports/access-token'
import { __clearGA4MetadataCache } from '@/lib/google/analytics'

function req() {
  return new NextRequest('http://localhost/api/reports/run', {
    method: 'POST',
    headers: { 'x-cron-secret': 'shh' },
  })
}

/** Metric names in every :runReport body the run produced. */
function requestedMetrics(): string[] {
  return state.reportBodies.flatMap(b =>
    ((b.metrics ?? []) as { name: string }[]).map(m => m.name),
  )
}

beforeEach(() => {
  process.env.CRON_SECRET = 'shh'
  state.propertyMetrics = ['sessions', 'totalUsers', 'screenPageViews', 'keyEvents']
  state.reportBodies = []
  state.markdown = ''
  // Metadata is cached per property for 24h — a stale entry would leak the
  // previous test's metric list into the next one.
  __clearGA4MetadataCache()
  guardState.claimThrows = false
  guardState.alreadyClaimed = []
  // Call counts are asserted below (the no-token path), and mocks persist
  // across cases in this file.
  vi.mocked(resolveTenantToken).mockClear()
})

describe('POST /api/reports/run — GA4 metric names (T-69)', () => {
  it('never sends the retired "conversions" metric', async () => {
    // A property still exposing BOTH names — the transitional state Google
    // shipped during the rename. This is the case the repair layer cannot
    // catch: `conversions` validates clean here, so the request would sail
    // through and quietly chart the deprecated metric. Only the route's own
    // metric list decides the outcome, which is exactly what T-69 is about.
    state.propertyMetrics = ['sessions', 'totalUsers', 'screenPageViews', 'conversions', 'keyEvents']

    const res = await POST(req())
    expect(res.status).toBe(200)

    // Both windows (current and previous-period, for deltas) are checked.
    expect(state.reportBodies).toHaveLength(2)
    expect(requestedMetrics()).not.toContain('conversions')
    expect(requestedMetrics().filter(m => m === 'keyEvents')).toHaveLength(2)
  })

  it('publishes the traffic section instead of losing it to a validation error', async () => {
    const res = await POST(req())
    const body = await res.json()

    expect(body.results[0].status).toBe('created')
    expect(state.markdown).toContain('## Website traffic')
    expect(state.markdown).toContain('| keyEvents |')
    // The stale name used to surface here, as the digest's only trace of a
    // completely missing traffic half.
    expect(state.markdown).not.toContain('Google Analytics data unavailable')
  })

  it('drops a metric this property does not expose, publishes the rest, and says so', async () => {
    // A property with no key events configured still gets a digest.
    state.propertyMetrics = ['sessions', 'totalUsers', 'screenPageViews']

    const res = await POST(req())
    expect(res.status).toBe(200)

    expect(requestedMetrics()).not.toContain('keyEvents')
    expect(state.markdown).toContain('| sessions |')
    expect(state.markdown).toContain('unavailable on this property and omitted: keyEvents')
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   The per-window claim's failure contract (Codex review on #221).

   Two states that look identical in a 200 response but are opposites:
   "already generated" (fine) and "the database is unreachable so nothing was
   generated" (an outage). The workflow only alerts on non-2xx or results whose
   status is 'failed', so mislabelling the outage as 'skipped' would keep the
   scheduled run green straight through it — the silent failure this arc exists
   to remove.
   ══════════════════════════════════════════════════════════════════════════ */

describe('POST /api/reports/run — claim failure contract', () => {
  it('a claim ERROR is reported as failed, so the workflow alerts', async () => {
    guardState.claimThrows = true
    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.results[0]).toMatchObject({ reportId: 'weekly-digest', status: 'failed' })
    expect(body.results[0].reason).toContain('could not claim')
    // `ran` must count it: the workflow's all-failed error tier compares the
    // failed count against `ran`, so a 0 here would silently pass.
    expect(body.ran).toBe(1)
    expect(body.skipped).toBe(0)
    // Fail CLOSED: nothing may be generated without a claim.
    expect(state.reportBodies).toHaveLength(0)
  })

  it('an already-claimed window is skipped WITHOUT minting a Google token', async () => {
    // The catch-up no-op tick: the report ran at 07:00 and is re-offered every
    // hour after. Resolving credentials for it would refresh OAuth needlessly
    // and turn a transient refresh failure into a 409 false alarm.
    const { windowKey } = await import('@/lib/reports/run-guard')
    guardState.alreadyClaimed = [windowKey('weekly-digest', '2026-08-03')]
    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.results[0]).toMatchObject({ reportId: 'weekly-digest', status: 'skipped' })
    expect(body.ran).toBe(0)
    expect(body.skipped).toBe(1)
    expect(state.reportBodies).toHaveLength(0)
    expect(resolveTenantToken).not.toHaveBeenCalled()
  })
})
