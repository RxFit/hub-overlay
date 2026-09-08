import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessStaffRoute } from '@/lib/roles'
import { cancelJob, getJobDetail, isMissingTableError } from '@/lib/dispatch-store'
import { deriveRunView } from '@/lib/deep-runs'
import { ensureDeepRunArtifact } from '@/lib/deep-artifacts'
import { getTenantId } from '@/lib/tenant-context'
import { cancelToolRun, getToolRunOwned, ACTIVE_WINDOW_MS, type ToolRunRecord } from '@/lib/tool-runs'
import { isDeepToolId } from '@/lib/deep-runs'
import { resolveContextArtifacts, startDeepRun } from '@/lib/deep-run-start'
import { withFault } from '@/lib/route-fault'
import { emptyOn } from '@/lib/swallow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * /api/deep-runs/[id] — watch, cancel, and save one deep run
 * (docs/architecture/DEEP_LANE_2026-08-23.md §4.5, PR B).
 *
 * GET → the owner's run with its LIVE state (deriveRunView joins tool_runs'
 * enqueue/terminal truth with the dispatch job's execution state — state,
 * never a fabricated percentage).
 *
 * POST { action: 'cancel' } → guarded cancel: the run goes terminal
 * immediately (the user's intent is now), then the queue job is stood down —
 * the worker aborts within one heartbeat, which is where allotment stops
 * burning.
 *
 * POST { action: 'save_artifact' } → idempotent: the landed report becomes
 * a tool artifact if it isn't one already (lib/deep-artifacts.ts). The
 * worker landing normally does this first; the panel calls it on adopt as
 * the safety net (older runs, a landing whose save failed) and to learn the
 * artifact id it shows as "Saved to Artifacts". 409 while the run has no
 * finished report — a queued/failed run has nothing to save.
 *
 * POST { action: 'retry' } → the needs-you queue's Retry (Phase 4 PR 2):
 * starts a NEW run with the original's brief and context artifacts through
 * lib/deep-run-start.ts — the same guard sequence as a fresh start — and
 * records `retryOf` on the new row. Only a terminal (failed/cancelled) or
 * orphaned (queued past the active window) run can be retried; a live one is
 * 409 so a double-tap never doubles the work. Returns { run } for the new run.
 */

interface SessionUser {
  email?: string | null
  role?: string | null
}

async function requireStaff(): Promise<{ email: string } | NextResponse> {
  const session = await getServerSession(authOptions)
  const user = session?.user as SessionUser | undefined
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canAccessStaffRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — staff access required' }, { status: 403 })
  }
  return { email: user.email }
}

async function viewOf(run: ToolRunRecord) {
  const job = run.status === 'queued' && run.jobId
    // Lossy read: a failed job-detail lookup degrades the view to "no live
    // state" rather than failing the whole request — emptyOn flags the
    // response partial (x-hub-partial) so the omission is visible.
    ? await getJobDetail(run.jobId).catch((err: unknown) => emptyOn(err, { module: 'deep-runs/[id]', op: 'getJobDetail' }, null))
    : null
  return deriveRunView(run, job, Date.now())
}

export const GET = withFault('deep-runs/[id]', async (_req: NextRequest, { params }: { params: { id: string } }) => {
  const auth = await requireStaff()
  if (auth instanceof NextResponse) return auth
  const tenantId = getTenantId()
  try {
    const run = await getToolRunOwned(params.id, tenantId, auth.email)
    if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 })
    return NextResponse.json({ run: await viewOf(run) })
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ error: 'deep-run tables missing — run migrations' }, { status: 503 })
    }
    console.error('[deep-runs GET id]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to read the deep run' }, { status: 500 })
  }
})

export const POST = withFault('deep-runs/[id]', async (req: NextRequest, { params }: { params: { id: string } }) => {
  const auth = await requireStaff()
  if (auth instanceof NextResponse) return auth
  const tenantId = getTenantId()
  let body: { action?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (body.action !== 'cancel' && body.action !== 'save_artifact' && body.action !== 'retry') {
    return NextResponse.json({ error: "action must be 'cancel', 'save_artifact' or 'retry'" }, { status: 400 })
  }
  if (body.action === 'retry') {
    try {
      const run = await getToolRunOwned(params.id, tenantId, auth.email)
      if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 })
      if (!isDeepToolId(run.tool)) {
        return NextResponse.json({ error: 'this run is not a deep tool run', reason: 'not_retryable' }, { status: 409 })
      }
      // A queued run that is still inside the active window is live: retry
      // would double the work. Past the window it is an orphan; startDeepRun
      // expires it (expireStaleToolRuns) before the cap check, so the retry
      // itself is what retires the corpse.
      const live = run.status === 'queued' && new Date(run.createdAt).getTime() >= Date.now() - ACTIVE_WINDOW_MS
      if (run.status === 'succeeded' || live) {
        return NextResponse.json(
          { error: run.status === 'succeeded' ? 'the run succeeded — nothing to retry' : 'the run is still in flight — cancel it first', reason: 'not_retryable' },
          { status: 409 },
        )
      }
      const contextIds = (run.inputs ?? []).map((i) => i.id)
      const context = await resolveContextArtifacts(contextIds, tenantId, auth.email)
      if (!context.ok) return NextResponse.json({ error: context.error }, { status: context.status })
      const started = await startDeepRun({
        tool: run.tool,
        brief: run.brief,
        tenantId,
        userEmail: auth.email,
        chatId: run.chatId,
        ownedArtifacts: context.ownedArtifacts,
        contextPayload: context.contextPayload,
        retryOf: run.id,
      })
      if (!started.ok) {
        return NextResponse.json({ error: started.error, reason: started.reason }, { status: started.status })
      }
      return NextResponse.json({ run: started.run })
    } catch (err) {
      if (isMissingTableError(err)) {
        return NextResponse.json({ error: 'deep-run tables missing — run migrations' }, { status: 503 })
      }
      throw err
    }
  }
  if (body.action === 'save_artifact') {
    try {
      const run = await getToolRunOwned(params.id, tenantId, auth.email)
      if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 })
      if (run.status !== 'succeeded' || !run.resultMd?.trim()) {
        return NextResponse.json(
          { error: 'the run has no finished report to save', reason: 'not_finished' },
          { status: 409 },
        )
      }
      // Owner recorded the way tool_runs records it (lowercased) so the
      // landing-side and panel-side saves are indistinguishable; reads and
      // ownership checks compare case-insensitively (lib/tool-artifacts.ts).
      const artifact = await ensureDeepRunArtifact(run, { tenantId, createdBy: run.userEmail })
      return NextResponse.json({ artifact })
    } catch (err) {
      if (isMissingTableError(err)) {
        return NextResponse.json({ error: 'deep-run tables missing — run migrations' }, { status: 503 })
      }
      console.error('[deep-runs save_artifact]', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Failed to save the report as an artifact' }, { status: 500 })
    }
  }
  try {
    const jobId = await cancelToolRun(params.id, tenantId, auth.email)
    if (jobId) {
      // Stand the queue job down; the worker learns via its next heartbeat.
      // AWAITED: an unawaited failure would report "cancelled" while the
      // worker burned allotment to the end. If it still fails, the run row
      // is already terminal — the worker's eventual result is discarded by
      // the landing CAS and its spend ledgered — so we log rather than
      // unwind, but we never skip the attempt.
      try {
        await cancelJob(jobId)
      } catch (err) {
        console.warn('[deep-runs cancel] queue cancel failed — worker will run to completion, result will be discarded:', err instanceof Error ? err.message : err)
      }
    }
    const run = await getToolRunOwned(params.id, tenantId, auth.email)
    if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 })
    return NextResponse.json({ run: await viewOf(run) })
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ error: 'deep-run tables missing — run migrations' }, { status: 503 })
    }
    console.error('[deep-runs cancel]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to cancel the deep run' }, { status: 500 })
  }
})
