import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import {
  deliverResult,
  enqueueJob,
  getJobDetail,
  isMissingTableError,
  workerFresh,
} from '@/lib/dispatch-store'
import { dispatchFreshMs, isDispatchConfigured, isDispatchEnabled } from '@/lib/agy-dispatch'
import { buildFileProbePrompt, buildProbePrompt, containsFreshTimestamp, DEFAULT_PROBE_URL } from '@/lib/work-probe'
import { emit } from '@/lib/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * /api/admin/work-probe — the deep lane's Phase-0-style gate
 * (docs/architecture/DEEP_LANE_2026-08-23.md §8, PR A).
 *
 * Everything else in the deep-lane design is verified against shipped code;
 * the ONE unproven assumption is that headless `agy -p` on the desktop worker
 * actually exercises tools (web fetch). This probe settles it for a few
 * tokens before any UI is built:
 *
 *   POST  enqueues a marker work_item that requires a LIVE web fetch of a
 *         dynamic URL (default: a current-time API), then returns {jobId}.
 *         Needs the desktop worker running with WORKER_WORK_SLOTS >= 1.
 *   GET   ?jobId= polls it. On success it delivers the text (read-once CAS)
 *         and reports two independent verdicts:
 *           markerVerified    — the reply round-tripped the random marker
 *           freshnessVerified — the reply contains a timestamp within
 *                               ±20 min of now, which a model cannot
 *                               hallucinate reliably (it has no wall clock);
 *                               only a live fetch produces it.
 *         PASS = both true. The verdict prints ONCE — delivery scrubs the
 *         text, so re-polling a delivered probe reports only that fact.
 *
 * The GET refuses to touch non-probe jobs: deliverResult is a read-once CAS,
 * and delivering someone's chat job here would steal the waiting reader's
 * answer.
 */

const DEFAULT_DEADLINE_MS = 5 * 60_000
const FRESHNESS_WINDOW_MS = 20 * 60_000

async function requireAdmin(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }
  return null
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  let body: { url?: unknown; deadlineMs?: unknown; mode?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    /* empty body is fine - defaults apply */
  }
  const mode = body.mode === 'file' ? 'file' : 'url'

  let url = DEFAULT_PROBE_URL
  if (mode === 'url' && typeof body.url === 'string') {
    try {
      const parsed = new URL(body.url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme')
      url = parsed.toString()
    } catch {
      return NextResponse.json({ error: 'url must be a valid http(s) URL' }, { status: 400 })
    }
  }
  const deadlineMs = Math.min(
    Math.max(typeof body.deadlineMs === 'number' && Number.isFinite(body.deadlineMs) ? body.deadlineMs : DEFAULT_DEADLINE_MS, 60_000),
    15 * 60_000,
  )

  const marker = `AGY_WORK_PROBE_${crypto.randomUUID().slice(0, 8)}`
  try {
    const isFile = mode === 'file'
    const outcome = await enqueueJob({
      kind: 'work_item',
      prompt: isFile ? buildFileProbePrompt(marker, 'package.json') : buildProbePrompt(url, marker),
      deadlineMs,
      // marker is a random token minted above - provenance, not content, so
      // it may ride payload_meta (which survives the scrub) for the GET.
      meta: isFile ? { probe: true, marker, mode: 'file', addDirs: ['.'] } : { probe: true, marker, url, mode: 'url' },
    })
    if ('refused' in outcome) {
      return NextResponse.json({ error: 'work queue full — drain or cancel queued work items first' }, { status: 503 })
    }
    emit({ type: 'dispatch_enqueued', jobId: outcome.id, kind: 'work_item' })
    // Advisory context, not gates: a probe enqueued against a stale worker is
    // a legitimate way to prove the 'deadline' expiry path end to end.
    const fresh = await workerFresh(dispatchFreshMs()).catch(() => false)
    return NextResponse.json({
      jobId: outcome.id,
      marker,
      url,
      deadlineMs,
      workerFresh: fresh,
      dispatchEnabled: isDispatchEnabled(),
      dispatchConfigured: isDispatchConfigured(),
      note: fresh
        ? 'Poll GET ?jobId=… for the verdict. Remember the worker claims work_items only when WORKER_WORK_SLOTS >= 1.'
        : 'No fresh worker heartbeat — the probe will sit queued until the desktop worker (WORKER_WORK_SLOTS >= 1) claims it, or expire at its deadline.',
    })
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ error: 'dispatch tables missing — run migrations' }, { status: 503 })
    }
    console.error('[work-probe] enqueue failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'enqueue failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin()
  if (denied) return denied

  const jobId = req.nextUrl.searchParams.get('jobId')
  if (!jobId) return NextResponse.json({ error: 'jobId query param required' }, { status: 400 })

  try {
    const job = await getJobDetail(jobId)
    if (!job) return NextResponse.json({ error: 'job not found' }, { status: 404 })
    if (job.payloadMeta?.probe !== true) {
      // deliverResult is read-once; delivering a non-probe job here would
      // steal its waiting reader's answer. Probe jobs only.
      return NextResponse.json({ error: 'not a probe job' }, { status: 400 })
    }

    const base = {
      state: job.state,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      errorClass: job.errorClass,
      error: job.error,
    }
    if (job.state === 'queued') {
      return NextResponse.json({ ...base, deadlineAt: job.deadlineAt.toISOString() })
    }
    if (job.state === 'leased') {
      return NextResponse.json({
        ...base,
        state: 'running',
        leaseFresh: job.leaseExpiresAt !== null && job.leaseExpiresAt.getTime() > Date.now(),
      })
    }
    if (job.state !== 'succeeded') {
      // failed | expired | cancelled — the typed error class IS the verdict.
      return NextResponse.json({ ...base, verdict: 'FAIL' })
    }

    const delivered = await deliverResult(jobId)
    if (!delivered) {
      return NextResponse.json({
        ...base,
        delivered: true,
        note: 'result already delivered (verdict printed on the first successful poll) or scrubbed by the content TTL',
      })
    }
    const marker = typeof job.payloadMeta?.marker === 'string' ? job.payloadMeta.marker : null
    const mode = job.payloadMeta?.mode === 'file' ? 'file' : 'url'
    const markerVerified = marker !== null && delivered.text.includes(marker)
    const noTools = delivered.text.includes('NO_TOOLS')
    
    let freshnessVerified = false
    let fileVerified = false
    let verdict = 'FAIL'
    
    if (mode === 'file') {
      fileVerified = delivered.text.includes('casatrejo-hub')
      verdict = markerVerified && fileVerified && !noTools ? 'PASS' : 'FAIL'
    } else {
      freshnessVerified = containsFreshTimestamp(delivered.text, Date.now(), FRESHNESS_WINDOW_MS)
      verdict = markerVerified && freshnessVerified && !noTools ? 'PASS' : 'FAIL'
    }
    
    const meta = delivered.resultMeta as { model?: string; latencyMs?: number; usage?: Record<string, number> } | null
    return NextResponse.json({
      ...base,
      verdict,
      mode,
      markerVerified,
      ...(mode === 'file' ? { fileVerified } : { freshnessVerified }),
      noToolsReported: noTools,
      sample: delivered.text.slice(0, 400),
      model: meta?.model ?? null,
      latencyMs: meta?.latencyMs ?? null,
      usage: meta?.usage ?? null,
    })
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ error: 'dispatch tables missing — run migrations' }, { status: 503 })
    }
    console.error('[work-probe] read failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'probe read failed' }, { status: 500 })
  }
}
