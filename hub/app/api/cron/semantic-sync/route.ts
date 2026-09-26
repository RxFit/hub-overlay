import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyCronSecret } from '@/lib/cron-auth'
import { createLogger } from '@/lib/logger'
import { withFault } from '@/lib/route-fault'
import { SYNC_SOURCES, runSemanticSync } from '@/lib/semantic-sync'
import { MAX_ITEMS_CEILING, MAX_LOOKBACK_HOURS } from '@/lib/semantic-sync/run'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** The Cloud Run request ceiling (deploy.yml --timeout=300); the run's own deadline is shorter. */
export const maxDuration = 300

const log = createLogger('semantic-sync')

/** Wall-clock budget for one run, leaving headroom under maxDuration for the response. */
const RUN_DEADLINE_MS = 240_000

const BodySchema = z
  .object({
    sources: z.array(z.enum(SYNC_SOURCES)).min(1).max(SYNC_SOURCES.length).optional(),
    dryRun: z.boolean().optional(),
    lookbackHours: z.number().int().min(1).max(MAX_LOOKBACK_HOURS).optional(),
    maxItems: z.number().int().min(1).max(MAX_ITEMS_CEILING).optional(),
  })
  .strict()

/**
 * POST /api/cron/semantic-sync — the nightly Stripe + Gmail feed into the
 * Semantic Brain's Cloud Storage data stores (lib/semantic-sync). Fired by
 * .github/workflows/semantic-sync.yml; operated per
 * hub/docs/runbooks/semantic-sync.md.
 *
 * Machine-called: /api/cron/ is excluded from the session middleware (a
 * scheduler holds no NextAuth cookie), so the constant-time x-cron-secret
 * check is the only gate, and 503-when-unset is the kill switch — the same
 * contract as /api/cron/dispatch-alert.
 *
 * Optional body: { sources?: ["stripe"|"gmail"], dryRun?, lookbackHours?, maxItems? }.
 * `dryRun` lists and renders without writing anything; `lookbackHours` is an
 * explicit backfill that ignores the stored cursor.
 *
 * 200 when no source FAILED (not_configured is not a failure — deny by
 * default until the owner steps are done); 502 when any did, with the stage
 * and upstream message per source, so the workflow run fails and GitHub's
 * failure email carries it.
 */
export const POST = withFault('cron/semantic-sync', async (req: NextRequest) => {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (!verifyCronSecret(req.headers.get('x-cron-secret'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // No body / empty body is the scheduled shape: every source, cursor-driven.
  const text = await req.text()
  let raw: unknown = {}
  if (text.trim()) {
    try {
      raw = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
    }
  }
  const parsed = BodySchema.safeParse(raw ?? {})
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    )
  }

  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), RUN_DEADLINE_MS)
  try {
    const results = await runSemanticSync({ ...parsed.data, signal: controller.signal })

    for (const r of results) {
      const fields = {
        source: r.source,
        status: r.status,
        documents: r.documents,
        truncated: r.truncated,
        durationMs: r.durationMs,
        stage: r.failure?.stage,
      }
      if (r.status === 'failed') log.error(fields, `semantic sync ${r.source} failed: ${r.failure?.detail ?? 'unknown'}`)
      else log.info(fields, `semantic sync ${r.source}: ${r.status}`)
    }

    const generatedAt = new Date().toISOString()
    const dryRun = parsed.data.dryRun === true
    if (results.some((r) => r.status === 'failed')) {
      return NextResponse.json({ ok: false, generatedAt, dryRun, sources: results }, { status: 502 })
    }
    return NextResponse.json({ ok: true, generatedAt, dryRun, sources: results }, { status: 200 })
  } finally {
    clearTimeout(deadline)
  }
})
