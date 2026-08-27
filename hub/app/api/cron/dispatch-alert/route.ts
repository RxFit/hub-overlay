import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/cron-auth'
import { runDispatchAlertTick } from '@/lib/dispatch-alerts'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

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

  const result = await runDispatchAlertTick()
  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    ...result,
  })
})
