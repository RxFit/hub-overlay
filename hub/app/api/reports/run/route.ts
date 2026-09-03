import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { hubUsers, googlePrefs } from '@/lib/schema'
import { getTenantId } from '@/lib/tenant-context'
import { getEffectivePrefs } from '@/lib/google/prefs-db'
import { normalizeReports, dueOrMissedReports, reportWindow, DEFAULT_REPORTS } from '@/lib/reports/config'
import {
  claimReportWindow,
  releaseReportWindow,
  completeReportWindow,
  pruneReportRuns,
  findClaimedWindows,
  windowKey,
} from '@/lib/reports/run-guard'
import { buildDigestMarkdown, buildReviewDeckSpec } from '@/lib/reports/digest'
import { resolveTenantToken } from '@/lib/reports/access-token'
import { deliverDigest } from '@/lib/reports/deliver'
import { runGA4Report } from '@/lib/google/analytics'
import { querySearchConsole } from '@/lib/google/search-console'
import { createDocFromMarkdown } from '@/lib/google/docs'
import { createDeckFromSpec } from '@/lib/google/slides'
import { ensureWorkspace } from '@/lib/google/drive-workspace'
import { dbWorkspaceStore } from '@/lib/google/drive-workspace-db'
import { recordAiAction } from '@/lib/ai-audit'
import { newRequestId } from '@/lib/observability'
import { withFault } from '@/lib/route-fault'
import { swallow } from '@/lib/swallow'

export const runtime = 'nodejs'

/**
 * POST /api/reports/run — generate the scheduled reports that are due now.
 *
 * Fired HOURLY (.github/workflows/dispatch-alert.yml, and/or a Cloud Scheduler
 * job — see docs/runbooks/scheduled-reports.md). Cadence lives in the database
 * as data an admin can edit, rather than in per-report cron entries the app
 * would have to provision and tear down whenever someone changed a setting.
 * See lib/reports/config.ts.
 *
 * Each firing asks every configured report "are you due now, or were you due
 * earlier TODAY and not yet generated?" — deliberately weaker than "is this
 * the due hour?", because the trigger cannot be trusted to fire every hour:
 * GitHub's scheduled workflows are best-effort and were observed dropping
 * firings for 2–10 hours (2026-08-27), which against the strict question meant
 * a 07:00 digest was simply never produced. What makes the weaker question
 * safe is the per-window claim in lib/reports/run-guard.ts: the first tick to
 * claim a window generates it, every later tick skips it, and concurrent ticks
 * cannot both win. That same claim is what stops a manual dispatch inside a due
 * hour from producing a duplicate Doc and a duplicate email.
 *
 * Guarded by the same constant-time `x-cron-secret` check as /api/kpis/sync.
 *
 * There is no session at 7am, so credentials come from the stored refresh
 * token, minted server-side (lib/reports/access-token.ts).
 */

/** Constant-time comparison — avoids leaking the secret through timing. */
function verifyCronSecret(header: string | null, secret: string): boolean {
  if (!header) return false
  try {
    const a = Buffer.from(header)
    const b = Buffer.from(secret)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * GA4 headline metrics for a digest. Kept small — quota is per property.
 *
 * `keyEvents`, not `conversions`: Google renamed that metric in the Data API,
 * and the old name is not merely ignored — it fails the whole request, so a
 * single stale name took the ENTIRE traffic section out of every scheduled
 * digest while the report still published looking complete. Same rename the
 * chat path repairs via GA4_METRIC_ALIASES (lib/google/analytics.ts).
 */
const DIGEST_METRICS = ['sessions', 'totalUsers', 'screenPageViews', 'keyEvents']

interface RunSummary {
  reportId: string
  status: 'created' | 'skipped' | 'failed'
  documentId?: string
  reason?: string
}

export const POST = withFault('reports/run', async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (!verifyCronSecret(req.headers.get('x-cron-secret'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tenantId = getTenantId()
  const now = new Date()
  const results: RunSummary[] = []

  const [prefsRow] = await db
    .select({ reports: googlePrefs.reports, timezone: googlePrefs.timezone })
    .from(googlePrefs)
    .where(eq(googlePrefs.tenantId, tenantId))
    .limit(1)

  // A tenant that has never touched the settings still gets the seeded
  // defaults, so reports work out of the box rather than only after an admin
  // opens a form they may not know exists.
  const configured = normalizeReports(prefsRow?.reports)
  const reports = configured.length ? configured : DEFAULT_REPORTS
  // Due NOW or missed earlier today. The runner used to ask only "is this
  // the due hour?", which silently loses a report whenever the trigger skips
  // that hour — and GitHub's scheduled workflows were observed dropping
  // firings for 2–10 hours at a stretch (2026-08-27). The per-window claim
  // below is what makes the wider question safe: a caught-up report is
  // generated exactly once, not on every remaining tick of the day.
  const due = dueOrMissedReports(reports, now, prefsRow?.timezone ?? undefined)

  if (!due.length) {
    return NextResponse.json({ ok: true, ran: 0, skipped: 0, results })
  }

  // Windows are computed once here and reused for both the pre-check and the
  // claim, so the two can never disagree about which window a report means.
  const candidates = due.map(report => ({
    report,
    window: reportWindow(report.cadence, now, prefsRow?.timezone ?? undefined),
  }))

  // Skip work that is already done BEFORE minting a Google token. Catch-up
  // makes the do-nothing tick the common case — a digest generated at 07:00
  // is re-offered every remaining hour of the day — and resolving credentials
  // for those would refresh OAuth needlessly and, worse, turn a transient
  // refresh failure into a 409 that fails the workflow and alerts about a
  // report that was already delivered. This read is an optimization only:
  // the atomic claim below still decides, so a stale or failed read is safe.
  let alreadyClaimed = new Set<string>()
  try {
    alreadyClaimed = await findClaimedWindows(
      tenantId,
      candidates.map(c => ({ reportId: c.report.id, windowStart: c.window.startDate })),
    )
  } catch (err) {
    // Read failure → fall through and let the claim decide, rather than
    // stalling reports on a transient query error.
    console.warn('[reports] claimed-window pre-check failed:', err instanceof Error ? err.message : err)
  }

  const pending = candidates.filter(
    c => !alreadyClaimed.has(windowKey(c.report.id, c.window.startDate)),
  )
  for (const done of candidates.filter(c => alreadyClaimed.has(windowKey(c.report.id, c.window.startDate)))) {
    results.push({
      reportId: done.report.id,
      status: 'skipped',
      reason: `already generated for window ${done.window.startDate} – ${done.window.endDate}`,
    })
  }

  // Every due report is already done: nothing to generate, and no credential
  // was needed to establish that.
  if (!pending.length) {
    return NextResponse.json({ ok: true, ran: 0, skipped: results.length, results })
  }

  // Admins are both the likeliest holders of the analytics scopes and the
  // people the reports are addressed to.
  const admins = await db
    .select({ email: hubUsers.email })
    .from(hubUsers)
    .where(and(eq(hubUsers.tenantId, tenantId), inArray(hubUsers.role, ['admin', 'superadmin'])))

  // Prefer an admin whose recorded grant actually covers the analytics scopes a
  // digest needs — granular consent lets one admin hold Drive but not Analytics.
  const token = await resolveTenantToken(tenantId, admins.map(a => a.email), [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly',
  ])
  if (!token) {
    return NextResponse.json(
      { ok: false, error: 'No usable Google credential for this tenant', ran: 0 },
      { status: 409 },
    )
  }

  const prefs = await getEffectivePrefs(tenantId)

  for (const { report, window } of pending) {
    const requestId = newRequestId()
    const notes: string[] = []
    const claim = {
      tenantId,
      reportId: report.id,
      windowStart: window.startDate,
      windowEnd: window.endDate,
    }

    // Claim the window BEFORE generating. Winning the claim is what grants
    // the right to build and deliver: an already-claimed window means an
    // earlier tick (or a concurrent one) owns this report, so skip rather
    // than produce a duplicate Doc and a duplicate email.
    let claimed = false
    try {
      claimed = await claimReportWindow(claim)
    } catch (err) {
      // Fail CLOSED on generating (never generate unclaimed), but report it
      // as FAILED, not skipped. 'skipped' means "already generated"; a claim
      // that errors means the database is unreachable and NO report was
      // produced. Labelling that as skipped would leave `ran` at 0, keep the
      // response 200, and let the workflow stay green through an outage —
      // precisely the silent failure this whole arc exists to remove.
      const reason = `could not claim reporting window: ${err instanceof Error ? err.message : 'error'}`
      console.error(`[reports] ${report.id} ${reason}`)
      results.push({ reportId: report.id, status: 'failed', reason })
      continue
    }
    if (!claimed) {
      results.push({
        reportId: report.id,
        status: 'skipped',
        reason: `already generated for window ${window.startDate} – ${window.endDate}`,
      })
      continue
    }

    try {
      // Sources are fetched independently: a Search Console outage should
      // still produce a digest with the traffic half in it.
      const [ga4, ga4Previous, gsc, gscTopPages] = await Promise.all([
        prefs.ga4PropertyId
          ? runGA4Report(
              token.accessToken,
              {
                propertyId: prefs.ga4PropertyId,
                startDate: window.startDate,
                endDate: window.endDate,
                metrics: DIGEST_METRICS,
              },
              // Repair rather than reject. Nobody is watching at 7am, and the
              // strict path turns one metric a property happens not to expose
              // into a digest with no traffic section at all. Dropping that
              // metric and publishing the rest is the better failure — and it
              // is disclosed in the notes below, never silent.
              { repair: true },
            ).catch(err => {
              notes.push(`Google Analytics data unavailable: ${err instanceof Error ? err.message : 'error'}`)
              return undefined
            })
          : Promise.resolve(undefined),
        prefs.ga4PropertyId
          ? runGA4Report(
              token.accessToken,
              {
                propertyId: prefs.ga4PropertyId,
                startDate: previousStart(window.startDate, window.endDate),
                endDate: previousEnd(window.startDate),
                metrics: DIGEST_METRICS,
              },
              { repair: true },
            ).catch((err: unknown) => {
              swallow(err, { module: 'reports/run', op: 'ga4PreviousWindow' })
              return undefined
            })
          : Promise.resolve(undefined),
        prefs.gscSiteUrl
          ? querySearchConsole(token.accessToken, {
              siteUrl: prefs.gscSiteUrl,
              startDate: window.startDate,
              endDate: window.endDate,
            }).catch(err => {
              notes.push(`Search Console data unavailable: ${err instanceof Error ? err.message : 'error'}`)
              return undefined
            })
          : Promise.resolve(undefined),
        prefs.gscSiteUrl
          ? querySearchConsole(token.accessToken, {
              siteUrl: prefs.gscSiteUrl,
              startDate: window.startDate,
              endDate: window.endDate,
              dimensions: ['page'],
              rowLimit: 10,
            }).catch((err: unknown) => {
              swallow(err, { module: 'reports/run', op: 'gscTopPages' })
              return undefined
            })
          : Promise.resolve(undefined),
      ])

      if (!prefs.ga4PropertyId) notes.push('No Google Analytics property is configured.')
      if (!prefs.gscSiteUrl) notes.push('No Search Console site is configured.')

      // A repaired report is still a partial one. Say which metrics this
      // property could not answer, so a shorter traffic table reads as
      // "unavailable here" rather than as "we measured zero".
      const dropped = ga4?.repairs?.droppedMetrics ?? []
      if (dropped.length) {
        notes.push(
          `Google Analytics metrics unavailable on this property and omitted: ${dropped.join(', ')}.`,
        )
      }

      // `kind` decides the artifact type. It was previously ignored, so a
      // report configured as a review DECK silently produced another digest
      // Doc — and when the 1st of the month landed on a Monday, both seeded
      // defaults came due in the same hour and admins got two near-identical
      // Docs. Branching here is what makes the config field mean something.
      const isDeck = report.kind === 'business_review_deck'
      const cadenceLabel =
        report.cadence === 'monthly' ? 'Monthly' : report.cadence === 'daily' ? 'Daily' : 'Weekly'
      const title = isDeck
        ? `${cadenceLabel} business review`
        : `${cadenceLabel} performance digest`

      const digestInput = {
        title,
        startDate: window.startDate,
        endDate: window.endDate,
        ga4,
        ga4Previous,
        gsc,
        gscTopPages,
        notes,
      }

      const workspace = await ensureWorkspace(token.accessToken, {
        tenantId,
        email: token.email,
        // Decks live in Presentations/, digests in Reports/.
        ensure: isDeck ? ['presentations'] : ['reports'],
        store: dbWorkspaceStore,
      })

      const artifact = isDeck
        ? await createDeckFromSpec(token.accessToken, buildReviewDeckSpec(digestInput), {
            folderId: workspace.folders.presentations,
            tenantId,
          }).then(deck => ({ id: deck.presentationId, url: deck.presentationUrl }))
        : await createDocFromMarkdown(token.accessToken, {
            title: `${title} (${window.startDate} – ${window.endDate})`,
            markdown: buildDigestMarkdown(digestInput),
            folderId: workspace.folders.reports,
            tenantId,
          }).then(doc => ({ id: doc.documentId, url: doc.documentUrl }))

      // Delivery is best-effort and reported, never fatal: the Doc exists and
      // is linked from Drive regardless, so a Gmail hiccup must not turn a
      // successful generation into a failed run.
      const delivered = await deliverDigest(
        token.accessToken,
        report.delivery,
        admins.map(a => a.email),
        {
          from: token.email,
          title,
          startDate: window.startDate,
          endDate: window.endDate,
          documentUrl: artifact.url,
          notes,
        },
      )

      await recordAiAction({
        userEmail: token.email,
        actor: 'system:cron',
        actionType: 'report_generated',
        target: {
          reportId: report.id,
          documentId: artifact.id,
          window,
          emailed: delivered.emailed,
          chatPosted: delivered.chatPosted,
        },
        intent: null,
        gateToken: null,
        requestId,
        status: 'success',
      }).catch((err: unknown) => swallow(err, { module: 'reports/run', op: 'recordAiActionSuccess' }))

      // The claim row becomes the run's durable record once the artifact
      // exists; best-effort, since the claim already prevents regeneration.
      await completeReportWindow(claim, artifact.id)

      results.push({
        reportId: report.id,
        status: 'created',
        documentId: artifact.id,
        ...(delivered.problems.length ? { reason: delivered.problems.join('; ') } : {}),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      console.error(`[reports] ${report.id} failed:`, reason)
      await recordAiAction({
        userEmail: token.email,
        actor: 'system:cron',
        actionType: 'report_generated',
        target: { reportId: report.id },
        intent: null,
        gateToken: null,
        requestId,
        status: 'failed',
        error: reason,
      }).catch((err: unknown) => swallow(err, { module: 'reports/run', op: 'recordAiActionFailed' }))
      // Release the window so the next tick retries it, rather than letting
      // one transient Google error burn the report for the whole day.
      await releaseReportWindow(claim)
      // One failing report must not abandon the others due this hour.
      results.push({ reportId: report.id, status: 'failed', reason })
    }
  }

  // Ledger housekeeping, best-effort and never fatal.
  await pruneReportRuns()

  // `ran` counts reports this tick ATTEMPTED (created + failed), not rows in
  // `results`. Catch-up makes 'skipped' the common case — an already-generated
  // report skips on every later tick of the day — and counting those would
  // both overstate activity and break the workflow's all-failed error tier,
  // which compares the failed count against `ran`.
  const attempted = results.filter(r => r.status !== 'skipped')
  return NextResponse.json({
    ok: true,
    ran: attempted.length,
    skipped: results.length - attempted.length,
    results,
  })
})

/** Start of the window immediately preceding [start, end], for deltas. */
function previousStart(startDate: string, endDate: string): string {
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000)
  const prev = new Date(start)
  prev.setUTCDate(prev.getUTCDate() - spanDays - 1)
  return prev.toISOString().slice(0, 10)
}

/** Day before the current window starts. */
function previousEnd(startDate: string): string {
  const prev = new Date(`${startDate}T00:00:00Z`)
  prev.setUTCDate(prev.getUTCDate() - 1)
  return prev.toISOString().slice(0, 10)
}
