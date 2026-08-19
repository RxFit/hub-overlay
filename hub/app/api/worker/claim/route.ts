import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/cron-auth'
import {
  claimNext,
  isMissingTableError,
  reapExpired,
  upsertWorker,
  type DispatchKind,
} from '@/lib/dispatch-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Long-poll ceiling: 25s poll ≪ 60 ≪ the real 120s Cloud Run request ceiling.
export const maxDuration = 60

/**
 * POST /api/worker/claim — the desktop worker's long-poll (Phase 2.5).
 *
 * Machine auth only (x-worker-secret, constant-time, 503-when-unset — the
 * unset case doubles as a kill switch). This route is in the middleware
 * matcher EXCLUSION list; the handler owns its auth entirely. It also serves
 * as the worker's heartbeat-of-record (dispatch_workers.last_seen_at) and
 * runs the lazy lease reaper — the worker is the party that benefits from
 * reclaimed jobs, so it pays for the reap.
 *
 * Body: { workerId, kinds?, waitMs?, version?, agyVersion? }
 * 200 { job, hubSha } when a job was claimed; 204 when the wait expired empty.
 */

const MAX_WAIT_MS = 25_000
const POLL_INTERVAL_MS = 1_000
const VALID_KINDS: DispatchKind[] = ['chat_turn', 'work_item']

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(req: NextRequest) {
  const secret = process.env.AGY_WORKER_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'dispatch disabled (no worker secret configured)' }, { status: 503 })
  }
  if (!verifyCronSecret(req.headers.get('x-worker-secret'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    workerId?: string
    kinds?: string[]
    waitMs?: number
    version?: string
    agyVersion?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const workerId = typeof body.workerId === 'string' ? body.workerId.slice(0, 100) : ''
  if (!workerId) {
    return NextResponse.json({ error: 'workerId required' }, { status: 400 })
  }
  const kinds = (Array.isArray(body.kinds) ? body.kinds : ['chat_turn']).filter((k): k is DispatchKind =>
    VALID_KINDS.includes(k as DispatchKind),
  )
  if (kinds.length === 0) {
    return NextResponse.json({ error: 'no valid kinds' }, { status: 400 })
  }
  const waitMs = Math.min(Math.max(Number(body.waitMs) || 0, 0), MAX_WAIT_MS)

  // Version strings are git SHAs / semvers; the row has no scrub or TTL and
  // is echoed to dispatch-health, so bound what an authenticated caller can
  // park there.
  const version = typeof body.version === 'string' ? body.version.slice(0, 64) : undefined
  const agyVersion = typeof body.agyVersion === 'string' ? body.agyVersion.slice(0, 64) : undefined

  try {
    await upsertWorker(workerId, { version, agyVersion })
    await reapExpired()

    const deadline = Date.now() + waitMs
    for (;;) {
      const job = await claimNext(workerId, kinds)
      if (job) {
        return NextResponse.json({ job, hubSha: process.env.GIT_SHA ?? null })
      }
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        return new NextResponse(null, { status: 204 })
      }
      await sleep(POLL_INTERVAL_MS)
    }
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ error: 'dispatch_unavailable' }, { status: 503 })
    }
    console.error('[worker/claim] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'claim failed' }, { status: 500 })
  }
}
