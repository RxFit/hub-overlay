import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/cron-auth'
import { isMissingTableError, postResult } from '@/lib/dispatch-store'
import { recordAiRun } from '@/lib/runs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/worker/jobs/[id]/result — idempotent result posting (Phase 2.5).
 *
 * The store's CAS decides one of five outcomes; the worker never retries into
 * ambiguity because every outcome is HTTP 200 with an explicit name (except
 * not_found → 404). Ledger policy:
 *
 *  - recorded            → the waiting tryAgyChat writes the ai_runs row (it
 *                          owns end-to-end latency). Residual: if the waiting
 *                          Hub instance died, that row is lost — bounded,
 *                          rare, and accepted by the design (§2.4/§6).
 *  - discarded_*         → THIS route writes the row with meta.discarded:true,
 *                          because the allotment was spent and nobody else
 *                          will say so. Same philosophy as Phase 2's
 *                          record-even-on-abort.
 *  - duplicate           → no second row, byte-identical ack.
 */

interface ResultBody {
  workerId?: string
  attempt?: number
  status?: 'ok' | 'error'
  text?: string
  model?: string
  usage?: Record<string, unknown>
  errorClass?: string
  error?: string
  latencyMs?: number
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const secret = process.env.AGY_WORKER_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'dispatch disabled (no worker secret configured)' }, { status: 503 })
  }
  if (!verifyCronSecret(req.headers.get('x-worker-secret'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: ResultBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (
    typeof body.workerId !== 'string' ||
    !Number.isInteger(body.attempt) ||
    (body.status !== 'ok' && body.status !== 'error')
  ) {
    return NextResponse.json({ error: 'workerId, attempt, and status required' }, { status: 400 })
  }

  try {
    const outcome = await postResult(params.id, {
      status: body.status,
      text: typeof body.text === 'string' ? body.text : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      usage: body.usage,
      errorClass: typeof body.errorClass === 'string' ? body.errorClass.slice(0, 60) : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
      latencyMs: Number.isFinite(body.latencyMs) ? Math.round(body.latencyMs as number) : undefined,
      workerId: body.workerId,
      attempt: body.attempt as number,
    })

    if (outcome.outcome === 'not_found') {
      return NextResponse.json({ error: 'job not found' }, { status: 404 })
    }
    if (outcome.outcome === 'discarded_cancelled' || outcome.outcome === 'discarded_lease_lost') {
      // The spend happened even though nobody will read the answer — the
      // ledger's job is to say so. Best-effort by recordAiRun's own contract.
      void recordAiRun({
        engine: 'agy',
        model: body.model,
        source: 'chat',
        status: body.status === 'ok' ? 'ok' : 'error',
        errorClass: body.status === 'error' ? (body.errorClass ?? 'unknown') : undefined,
        latencyMs: body.latencyMs && Number.isFinite(body.latencyMs) ? Math.round(body.latencyMs) : 0,
        prompt: 'prompt' in outcome ? outcome.prompt : undefined,
        usage: body.usage as { inputTokens?: number } | undefined,
        requestId: 'requestId' in outcome ? outcome.requestId : undefined,
        meta: { dispatch: true, discarded: true, jobId: params.id, workerId: body.workerId, outcome: outcome.outcome },
      })
    }
    return NextResponse.json({ outcome: outcome.outcome })
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ error: 'dispatch_unavailable' }, { status: 503 })
    }
    console.error('[worker/result] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'result post failed' }, { status: 500 })
  }
}
