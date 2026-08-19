import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/cron-auth'
import { heartbeatJob, isMissingTableError } from '@/lib/dispatch-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/worker/jobs/[id]/heartbeat — lease extension + cancel delivery
 * (Phase 2.5). The response IS the cancellation channel: the desktop cannot
 * be pushed to, so a Hub-side cancel rides back on the worker's own beat and
 * the worker SIGTERMs its agy child. A failed lease guard tells the worker to
 * abort the run — the job was reclaimed or expired out from under it.
 */

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const secret = process.env.AGY_WORKER_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'dispatch disabled (no worker secret configured)' }, { status: 503 })
  }
  if (!verifyCronSecret(req.headers.get('x-worker-secret'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { workerId?: string; attempt?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (typeof body.workerId !== 'string' || !Number.isInteger(body.attempt)) {
    return NextResponse.json({ error: 'workerId and attempt required' }, { status: 400 })
  }

  try {
    const outcome = await heartbeatJob(params.id, body.workerId.slice(0, 100), body.attempt as number)
    return NextResponse.json(outcome)
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ error: 'dispatch_unavailable' }, { status: 503 })
    }
    console.error('[worker/heartbeat] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'heartbeat failed' }, { status: 500 })
  }
}
