import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyCronSecret } from '@/lib/cron-auth'
import { scrubFreeText, type FaultDraft } from '@/lib/fault'
import { reportFault } from '@/lib/fault-report'
import { createLogger } from '@/lib/logger'
import { withFault } from '@/lib/route-fault'
import { claimFaultId } from '@/lib/worker-fault-dedupe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/worker/faults — the desktop worker's crash-record sink
 * (ERROR_REPORTING §3 Layer 10).
 *
 * The worker runs in Docker on the operator's desktop and speaks to the Hub
 * only over HTTPS, so a crash record on its stderr reaches `docker logs` and
 * nothing else — the Hub could previously observe a lease expiring but never
 * why. The worker spools crash records synchronously (lib/fault-spool.ts) and
 * uploads them on its NEXT boot, which is the first moment an HTTP call is
 * safe; this route ingests that batch and re-reports each record so it lands
 * in Cloud Logging and event_log like any server fault.
 *
 * Machine auth only: constant-time `x-worker-secret`, 503 when unset (the
 * unset case doubles as a kill switch), exactly matching /api/worker/claim.
 * This path is in the middleware matcher EXCLUSION list, so the handler owns
 * its auth entirely.
 *
 * TRUST POSTURE. The secret authenticates the sender; it does not make the
 * PAYLOAD trustworthy. Records are re-scrubbed here rather than trusted to
 * have been scrubbed at the source, `code` is constrained to a bounded shape
 * because it is the one field used as a metric dimension, and every free-text
 * field is length-capped. A compromised or simply buggy worker must not be
 * able to inject unbounded cardinality or unredacted secrets into the Hub's
 * telemetry.
 */

const MAX_FAULTS_PER_BATCH = 50
const MAX_BODY_BYTES = 512 * 1024
const MAX_TEXT = 2_000
/** One bad batch must not produce an unbounded error body. */
const MAX_REPORTED_ISSUES = 10

const text = (max = MAX_TEXT) => z.string().max(max)

/** Deliberately permissive about unknown keys and strict about the fields
 *  that carry meaning, cardinality or PII. */
const FaultShape = z.object({
  faultId: z.string().regex(/^HUB-[A-Z2-7]{8}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{1,32}$/),
  // `code` is the ONLY field used as a metric/alert dimension, so it is
  // bounded by shape, not merely by length.
  code: z.string().regex(/^[a-z0-9_]{1,40}$/),
  severity: z.enum(['fatal', 'error', 'degraded', 'expected']),
  message: text(),
  // `ts` is the one field that does NOT travel in the rebuilt draft — it
  // leaves via reportFault's options bag as `occurredAt` and is spliced
  // straight into the record, so it reaches Cloud Logging and event_log
  // without passing scrubFreeText. Left as a bare string it was a hole big
  // enough to post a refresh token through. A strict ISO-8601 datetime is
  // both the correct type AND a shape no secret can hide inside.
  ts: z.string().max(40).datetime().optional(),
  errName: text(64).nullable().optional(),
  stack: text(8_000).nullable().optional(),
})

const BatchSchema = z.object({
  workerId: z.string().min(1).max(100),
  faults: z
    .array(z.object({ fault: FaultShape.passthrough(), origin: text(40).optional() }))
    .min(1)
    .max(MAX_FAULTS_PER_BATCH),
})

/**
 * Read the request body with a hard byte ceiling, cancelling the stream the
 * moment it is exceeded. Returns the text or a tooLarge marker; never buffers
 * more than `max` bytes, so a multi-megabyte chunked upload costs one chunk
 * rather than the whole payload.
 */
async function readBodyCapped(req: NextRequest, max: number): Promise<{ text: string; tooLarge: false } | { text: ''; tooLarge: true }> {
  const reader = req.body?.getReader()
  if (!reader) return { text: '', tooLarge: false }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => {})
        return { text: '', tooLarge: true }
      }
      chunks.push(value)
    }
  } catch {
    // A truncated or aborted upload reads as invalid JSON below, which is the
    // honest outcome — we never saw a complete batch.
    return { text: '', tooLarge: false }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), tooLarge: false }
}

const log = createLogger('worker-faults')

export const POST = withFault('worker/faults', async (req: NextRequest) => {
  const secret = process.env.AGY_WORKER_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'dispatch disabled (no worker secret configured)' }, { status: 503 })
  }
  if (!verifyCronSecret(req.headers.get('x-worker-secret'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The cap is enforced while READING, never from the caller's header. A
  // chunked request simply omits content-length, and Number(null) is 0 — not
  // NaN — so a header-only check passes it straight through and req.json()
  // then buffers the whole payload. The header is a hint from the very party
  // this route does not trust.
  const read = await readBodyCapped(req, MAX_BODY_BYTES)
  if (read.tooLarge) {
    return NextResponse.json({ error: 'body too large' }, { status: 413 })
  }

  let body: unknown
  try {
    body = JSON.parse(read.text)
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  // Reject an oversized batch BEFORE handing it to zod: zod v3 records the
  // .max() violation but still parses every element, so a 200k-entry array
  // would be fully walked (and its issues fully materialized) just to be
  // rejected. Cheap length check first, real validation second.
  const batchLength = (body as { faults?: unknown })?.faults
  if (Array.isArray(batchLength) && batchLength.length > MAX_FAULTS_PER_BATCH) {
    return NextResponse.json(
      { error: 'Validation failed', issues: [{ path: 'faults' }] },
      { status: 422 },
    )
  }

  const parsed = BatchSchema.safeParse(body)
  if (!parsed.success) {
    // Paths only — never echo the values, which are exactly the free text this
    // route exists to keep out of the logs.
    return NextResponse.json(
      // Capped: one malformed batch must not turn into a multi-MB response.
      { error: 'Validation failed', issues: parsed.error.issues.slice(0, MAX_REPORTED_ISSUES).map((i) => ({ path: i.path.join('.') })) },
      { status: 422 },
    )
  }

  const workerId = parsed.data.workerId.slice(0, 100)
  const accepted: string[] = []
  const duplicate: string[] = []

  for (const entry of parsed.data.faults) {
    const f = entry.fault
    if (!claimFaultId(f.faultId)) {
      duplicate.push(f.faultId)
      continue
    }

    // Re-scrub rather than trusting the source, and rebuild the draft from
    // validated fields only — anything the schema did not name is discarded.
    const draft = {
      faultId: f.faultId,
      fingerprint: f.fingerprint,
      fingerprintStrategy: 'explicit',
      requestId: null,
      jobId: null,
      runId: null,
      layer: 'process',
      route: null,
      method: null,
      module: 'dispatch-worker',
      code: f.code,
      errName: f.errName ? scrubFreeText(String(f.errName)).slice(0, 64) : null,
      message: scrubFreeText(f.message),
      userMessage: 'Something went wrong. Please try again.',
      stack: f.stack ? scrubFreeText(String(f.stack)) : null,
      causeChain: [],
      outcome: 'error',
      severity: f.severity,
      blame: 'server',
      isExpected: false,
      isRetryable: false,
      retryCount: 0,
      partial: false,
      httpStatus: null,
      userHash: null,
      release: 'worker',
      revision: null,
      env: process.env.NODE_ENV ?? 'development',
      context: { kind: entry.origin ? scrubFreeText(entry.origin).slice(0, 40) : 'worker_crash' },
      droppedReason: null,
    } as unknown as FaultDraft

    reportFault(draft, {
      // Preserve when the crash actually happened; a spooled record uploaded
      // on the next boot can be much older than its ingest time.
      occurredAt: f.ts,
      // Never 'hub': merging desktop-worker crashes into the server's Error
      // Reporting groups would make both harder to read.
      service: 'hub-worker',
    })
    accepted.push(f.faultId)
  }

  log.warn(
    { workerId, accepted: accepted.length, duplicate: duplicate.length },
    'ingested worker crash records',
  )
  return NextResponse.json({ accepted, duplicate })
})
