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

// A chat answer is KBs, not MBs. Reject early on content-length, cap stored
// text defensively, and hold worker-supplied error text to the ≤300-char
// single-line column contract (truncateAgyError convention).
const MAX_BODY_BYTES = 2_000_000
const MAX_TEXT_CHARS = 262_144

function flattenError(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/** Worker-supplied usage is reduced to the four known numeric counters —
 *  result_meta outlives the content scrub, so it must never carry free-form
 *  JSON (a content-smuggling channel past the transient-content contract). */
function sanitizeUsage(usage: unknown): Record<string, number> | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined)
  const out: Record<string, number> = {}
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens'] as const) {
    const v = num(u[key])
    if (v !== undefined) out[key] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const secret = process.env.AGY_WORKER_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'dispatch disabled (no worker secret configured)' }, { status: 503 })
  }
  if (!verifyCronSecret(req.headers.get('x-worker-secret'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const contentLength = Number(req.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'body too large' }, { status: 413 })
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
  if (body.status === 'ok' && (typeof body.text !== 'string' || body.text.trim() === '')) {
    // Phase 0 doctrine holds at the wire too: empty output is never success.
    return NextResponse.json({ error: 'status ok requires non-empty text' }, { status: 400 })
  }

  const usage = sanitizeUsage(body.usage)
  try {
    const outcome = await postResult(params.id, {
      status: body.status,
      text: typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT_CHARS) : undefined,
      model: typeof body.model === 'string' ? body.model.slice(0, 100) : undefined,
      usage,
      errorClass: typeof body.errorClass === 'string' ? body.errorClass.slice(0, 60) : undefined,
      error: typeof body.error === 'string' ? flattenError(body.error) : undefined,
      latencyMs: Number.isFinite(body.latencyMs) ? Math.round(body.latencyMs as number) : undefined,
      workerId: body.workerId.slice(0, 100),
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
        model: typeof body.model === 'string' ? body.model.slice(0, 100) : undefined,
        source: 'chat',
        status: body.status === 'ok' ? 'ok' : 'error',
        errorClass: body.status === 'error' ? (body.errorClass ?? 'unknown').slice(0, 60) : undefined,
        latencyMs: body.latencyMs && Number.isFinite(body.latencyMs) ? Math.round(body.latencyMs) : 0,
        prompt: 'prompt' in outcome ? outcome.prompt : undefined,
        usage,
        requestId: 'requestId' in outcome ? outcome.requestId : undefined,
        meta: {
          dispatch: true,
          discarded: true,
          jobId: params.id,
          workerId: body.workerId.slice(0, 100),
          outcome: outcome.outcome,
        },
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
