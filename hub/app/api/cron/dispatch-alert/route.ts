import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/cron-auth'
import { runDispatchAlertTick, normalizeDeployReport, type DeployReport } from '@/lib/dispatch-alerts'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// 300, not 60: the tick now runs retention (lib/retention.ts — four bounded
// deletes, three of which scan) BEFORE alert evaluation, and
// ERROR_REPORTING_2026-08-24.md :291-292 requires the budget be raised before
// housekeeping is added to it, because a tick that times out takes the alert
// path down with it. 300 is the Cloud Run platform ceiling
// (deploy.yml --timeout=300 / service.yaml timeoutSeconds: 300), so this is
// the whole budget the platform allows; the workflow's curl --max-time matches.
export const maxDuration = 300

/**
 * POST /api/cron/dispatch-alert — the hourly push-alerting tick (hardening
 * move 1). Fired by .github/workflows/dispatch-alert.yml; evaluates the
 * dispatch failure conditions and pushes to Google Chat (see
 * lib/dispatch-alerts.ts for the full contract).
 *
 * Machine-called: /api/cron is excluded from the auth middleware (a cron
 * caller can never hold a NextAuth cookie — the same reasoning as
 * /api/worker), so this handler's constant-time CRON_SECRET check is the only
 * gate. 503-when-unset doubles as the kill switch, mirroring the worker
 * routes. NOTE the response contract with the workflow: `delivery` values
 * 'github' and 'post_failed' make the workflow run FAIL, which turns
 * GitHub's failure email into the fallback push path.
 */
// withFault (spec §3 Layer 3 priority list): a runDispatchAlertTick throw was
// completely unguarded — the ALERTING tick failing silently is the exact
// "detector inside the thing that goes silent" failure the spec warns about.
// The 500 also fails the GitHub workflow run, which keeps its failure email
// working as the fallback push path.
export const POST = withFault('cron/dispatch-alert', async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (!verifyCronSecret(req.headers.get('x-cron-secret'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Optional body: { deploy: { conclusion, consecutiveFailures, sha, runNumber } }.
  //
  // The Hub keeps no ledger of deploy ATTEMPTS — it knows only the GIT_SHA it
  // is running — so a deploy that never produced a revision is invisible from
  // in here. The workflow that already ticks hourly reads its own Actions
  // history with the ambient GITHUB_TOKEN and reports the conclusion, which
  // keeps the Hub free of any GitHub credential.
  //
  // A malformed, empty or absent body is NOT an error: every other condition
  // this tick evaluates must keep working when the deploy lookup fails, and a
  // 400 here would take the whole alerting path down with it. It degrades to
  // "not reported", which never alerts and never announces a recovery.
  let deploy: DeployReport | null = null
  try {
    const body: unknown = await req.json()
    deploy = normalizeDeployReport((body as { deploy?: unknown } | null)?.deploy)
  } catch {
    // No body / not JSON — the pre-report workflow shape. Nothing to do.
  }

  const result = await runDispatchAlertTick(new Date(), undefined, deploy)
  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    ...result,
  })
})
