import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { hubUsers, googlePrefs } from '@/lib/schema'
import { getTenantId } from '@/lib/tenant-context'
import { getEffectivePrefs } from '@/lib/google/prefs-db'
import { normalizeReports, dueReports, reportWindow, DEFAULT_REPORTS } from '@/lib/reports/config'
import { buildDigestMarkdown } from '@/lib/reports/digest'
import { resolveTenantToken } from '@/lib/reports/access-token'
import { deliverDigest } from '@/lib/reports/deliver'
import { runGA4Report } from '@/lib/google/analytics'
import { querySearchConsole } from '@/lib/google/search-console'
import { createDocFromMarkdown } from '@/lib/google/docs'
import { ensureWorkspace } from '@/lib/google/drive-workspace'
import { dbWorkspaceStore } from '@/lib/google/drive-workspace-db'
import { recordAiAction } from '@/lib/ai-audit'
import { newRequestId } from '@/lib/observability'

export const runtime = 'nodejs'

/**
 * POST /api/reports/run — generate the scheduled reports that are due now.
 *
 * Fired HOURLY by Cloud Scheduler. Each firing asks every configured report
 * "are you due in this hour, in your tenant's timezone?" — so cadence lives in
 * the database as data an admin can edit, rather than in per-report cron
 * entries the app would have to provision and tear down whenever someone
 * changed a setting. See lib/reports/config.ts.
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

/** GA4 headline metrics for a digest. Kept small — quota is per property. */
const DIGEST_METRICS = ['sessions', 'totalUsers', 'screenPageViews', 'conversions']

interface RunSummary {
  reportId: string
  status: 'created' | 'skipped' | 'failed'
  documentId?: string
  reason?: string
}

export async function POST(req: NextRequest) {
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

  try {
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
    const due = dueReports(reports, now, prefsRow?.timezone ?? undefined)

    if (!due.length) {
      return NextResponse.json({ ok: true, ran: 0, results })
    }

    // Admins are both the likeliest holders of the analytics scopes and the
    // people the reports are addressed to.
    const admins = await db
      .select({ email: hubUsers.email })
      .from(hubUsers)
      .where(and(eq(hubUsers.tenantId, tenantId), inArray(hubUsers.role, ['admin', 'superadmin'])))

    const token = await resolveTenantToken(tenantId, admins.map(a => a.email))
    if (!token) {
      return NextResponse.json(
        { ok: false, error: 'No usable Google credential for this tenant', ran: 0 },
        { status: 409 },
      )
    }

    const prefs = await getEffectivePrefs(tenantId)

    for (const report of due) {
      const requestId = newRequestId()
      const window = reportWindow(report.cadence, now)
      const notes: string[] = []

      try {
        // Sources are fetched independently: a Search Console outage should
        // still produce a digest with the traffic half in it.
        const [ga4, ga4Previous, gsc, gscTopPages] = await Promise.all([
          prefs.ga4PropertyId
            ? runGA4Report(token.accessToken, {
                propertyId: prefs.ga4PropertyId,
                startDate: window.startDate,
                endDate: window.endDate,
                metrics: DIGEST_METRICS,
              }).catch(err => {
                notes.push(`Google Analytics data unavailable: ${err instanceof Error ? err.message : 'error'}`)
                return undefined
              })
            : Promise.resolve(undefined),
          prefs.ga4PropertyId
            ? runGA4Report(token.accessToken, {
                propertyId: prefs.ga4PropertyId,
                startDate: previousStart(window.startDate, window.endDate),
                endDate: previousEnd(window.startDate),
                metrics: DIGEST_METRICS,
              }).catch(() => undefined)
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
              }).catch(() => undefined)
            : Promise.resolve(undefined),
        ])

        if (!prefs.ga4PropertyId) notes.push('No Google Analytics property is configured.')
        if (!prefs.gscSiteUrl) notes.push('No Search Console site is configured.')

        const title = `${report.cadence === 'monthly' ? 'Monthly' : report.cadence === 'daily' ? 'Daily' : 'Weekly'} performance digest`
        const markdown = buildDigestMarkdown({
          title,
          startDate: window.startDate,
          endDate: window.endDate,
          ga4,
          ga4Previous,
          gsc,
          gscTopPages,
          notes,
        })

        const workspace = await ensureWorkspace(token.accessToken, {
          tenantId,
          email: token.email,
          ensure: ['reports'],
          store: dbWorkspaceStore,
        })

        const doc = await createDocFromMarkdown(token.accessToken, {
          title: `${title} (${window.startDate} – ${window.endDate})`,
          markdown,
          folderId: workspace.folders.reports,
          tenantId,
        })

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
            documentUrl: doc.documentUrl,
            notes,
          },
        )

        await recordAiAction({
          userEmail: token.email,
          actor: 'system:cron',
          actionType: 'report_generated',
          target: {
            reportId: report.id,
            documentId: doc.documentId,
            window,
            emailed: delivered.emailed,
            chatPosted: delivered.chatPosted,
          },
          intent: null,
          gateToken: null,
          requestId,
          status: 'success',
        }).catch(() => {})

        results.push({
          reportId: report.id,
          status: 'created',
          documentId: doc.documentId,
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
        }).catch(() => {})
        // One failing report must not abandon the others due this hour.
        results.push({ reportId: report.id, status: 'failed', reason })
      }
    }

    return NextResponse.json({ ok: true, ran: results.length, results })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    console.error('[reports] run failed:', message)
    return NextResponse.json({ ok: false, error: message, results }, { status: 500 })
  }
}

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
