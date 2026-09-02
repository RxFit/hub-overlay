import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { agyErrorType, truncateAgyError } from '@/lib/agy'
import { dispatchFreshMs, dispatchGenerateText, isDispatchConfigured, isDispatchEnabled } from '@/lib/agy-dispatch'
import {
  isMissingTableError,
  listRecentJobs,
  listWorkers,
  queueDepths,
  reapExpired,
  sweepStale,
} from '@/lib/dispatch-store'
import { chatServeCounts, recordAiRun } from '@/lib/runs'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// The probe is a real round-trip through the desktop; give it chat headroom.
export const maxDuration = 120

/**
 * GET /api/admin/dispatch-health — desktop-dispatch health (Phase 2.5).
 *
 * Admin/superadmin ONLY (agy-health's defense-in-depth: middleware guards
 * /admin pages but not /api/admin/*, so the role is enforced here).
 *
 * Cheap by default: config echo, worker liveness verdicts, queue depths, last
 * 20 jobs as provenance only (content columns are never selected). Also runs
 * the lazy reaper + content sweep so the admin surface self-heals stale rows.
 * `?probe=1` enqueues a real marker job through the full path — enqueue →
 * desktop claim → agy run on the residential IP → result → delivery — and is
 * therefore the production replay test of the whole Phase 2.5 loop.
 */

const PROBE_MARKER = 'AGY_DISPATCH_OK'

export const GET = withFault('admin/dispatch-health', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  const config = {
    dispatchEnabled: isDispatchEnabled(),
    workerSecretPresent: isDispatchConfigured(),
    freshMs: dispatchFreshMs(),
    hubSha: process.env.GIT_SHA ?? null,
  }

  let tablesReady = true
  let workers: Array<{ id: string; lastSeenAt: Date; version: string | null; agyVersion: string | null; fresh: boolean }> = []
  let depths: Record<string, number> = {}
  let recent: Awaited<ReturnType<typeof listRecentJobs>> = []
  try {
    await reapExpired()
    void sweepStale().catch(() => {})
    const cutoff = Date.now() - dispatchFreshMs()
    workers = (await listWorkers()).map((w) => ({ ...w, fresh: w.lastSeenAt.getTime() > cutoff }))
    depths = await queueDepths()
    recent = await listRecentJobs(20)
  } catch (err) {
    if (!isMissingTableError(err)) throw err
    tablesReady = false
  }

  let probe:
    | { ran: false }
    | { ran: true; ok: true; markerVerified: boolean; model?: string; workerId?: string; latencyMs: number }
    | { ran: true; ok: false; errorClass: string; error: string; latencyMs: number } = { ran: false }

  if (req.nextUrl.searchParams.get('probe') === '1') {
    const start = Date.now()
    const probePrompt = `Reply with exactly this token and nothing else: ${PROBE_MARKER}`
    try {
      const result = await dispatchGenerateText(probePrompt, { budgetMs: 60_000 })
      const raw = result.raw as { workerId?: string } | null
      probe = {
        ran: true,
        ok: true,
        markerVerified: result.text.includes(PROBE_MARKER),
        model: result.model,
        workerId: raw?.workerId,
        latencyMs: result.latencyMs,
      }
      await recordAiRun({
        engine: 'agy',
        model: result.model,
        source: 'dispatch_probe',
        status: 'ok',
        latencyMs: result.latencyMs,
        prompt: probePrompt,
        usage: result.usage,
        userEmail: user.email,
        meta: { dispatch: true, markerVerified: probe.markerVerified },
      })
    } catch (err) {
      const errorClass = agyErrorType(err)
      const error = truncateAgyError(err)
      const latencyMs = Date.now() - start
      probe = { ran: true, ok: false, errorClass, error, latencyMs }
      await recordAiRun({
        engine: 'agy',
        source: 'dispatch_probe',
        status: 'error',
        errorClass,
        error,
        latencyMs,
        prompt: probePrompt,
        userEmail: user.email,
        meta: { dispatch: true },
      })
    }
  }

  const workerAlive = workers.some((w) => w.fresh)
  // With dispatch enabled, a dead worker means every chat turn silently rides
  // the metered chain — the exact failure this endpoint exists to surface, so
  // it must flip `healthy` (hardening move 1). With dispatch disabled the
  // worker is expected to be absent and does not count against health.
  const healthy =
    config.workerSecretPresent &&
    tablesReady &&
    (!config.dispatchEnabled || workerAlive) &&
    (!probe.ran || probe.ok)

  // Move 3: who actually served the last 24h of chat (status ok, by engine) —
  // the allotment-vs-metered ratio the alerting thresholds on. Best-effort:
  // a ledger read failure must not take the health surface down.
  const served24h = await chatServeCounts().catch(() => ({}) as Record<string, number>)

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    healthy,
    workerAlive,
    config,
    tablesReady,
    workers,
    queueDepths: depths,
    recentJobs: recent,
    served24h,
    probe,
  })
})
