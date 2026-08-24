import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessStaffRoute } from '@/lib/roles'
import {
  composeRunPrompt,
  deepToolDeadlineMs,
  briefError,
  DEEP_TOOLS,
  isDeepToolId,
} from '@/lib/deep-runs'
import { loadSkillContent } from '@/lib/skills-loader'
import {
  enqueueJob,
  isMissingTableError,
  workCapableWorkerFresh,
} from '@/lib/dispatch-store'
import { dispatchFreshMs, isDispatchConfigured, isDispatchEnabled } from '@/lib/agy-dispatch'
import {
  attachToolRunJob,
  countActiveToolRuns,
  createToolRun,
  expireStaleToolRuns,
  finishToolRun,
  isActiveRunConflict,
  listToolRuns,
} from '@/lib/tool-runs'
import { db } from '@/lib/db'
import { emit } from '@/lib/observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * /api/deep-runs — start and list deep tool runs
 * (docs/architecture/DEEP_LANE_2026-08-23.md §4, PR B).
 *
 * POST { tool, brief, chatId? } → { run } — writes the durable tool_runs
 * row and enqueues the work_item. Returns immediately; the client polls
 * GET /api/deep-runs/:id. Guardrails, in order:
 *   staff+ session (onboarding excluded, same policy as tool-artifacts) →
 *   valid tool + brief → dispatch enabled/configured → fresh worker
 *   heartbeat (allotment-only, FAIL HONEST: no metered fallback, design §7)
 *   → per-user cap of 1 active run.
 *
 * GET ?tool=&limit= → { runs } — the caller's own runs, newest first.
 * Owner-scoping lives in lib/tool-runs.ts, not here.
 */

interface SessionUser {
  email?: string | null
  role?: string | null
}

async function requireStaff(): Promise<{ email: string; role: string } | NextResponse> {
  const session = await getServerSession(authOptions)
  const user = session?.user as SessionUser | undefined
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canAccessStaffRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — staff access required' }, { status: 403 })
  }
  return { email: user.email, role: user.role as string }
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff()
  if (auth instanceof NextResponse) return auth

  let body: { tool?: unknown; brief?: unknown; chatId?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!isDeepToolId(body.tool)) {
    return NextResponse.json({ error: `tool must be one of: ${Object.keys(DEEP_TOOLS).join(', ')}` }, { status: 400 })
  }
  const briefProblem = briefError(body.brief)
  if (briefProblem) return NextResponse.json({ error: briefProblem }, { status: 400 })
  const tool = body.tool
  const brief = (body.brief as string).trim()
  const chatId = typeof body.chatId === 'string' && body.chatId.length <= 100 ? body.chatId : null

  // Allotment-only, fail honest (design §7): a deep run either gets the
  // engine or reports exactly why not — never a silent metered fallback.
  if (!isDispatchEnabled() || !isDispatchConfigured()) {
    return NextResponse.json(
      { error: 'The deep engine is not enabled on this deployment', reason: 'dispatch_disabled' },
      { status: 503 },
    )
  }
  try {
    const fresh = await workCapableWorkerFresh(dispatchFreshMs())
    if (!fresh) {
      return NextResponse.json(
        { error: 'The desktop worker is offline or running no work slot (WORKER_WORK_SLOTS) — deep runs execute there', reason: 'no_worker' },
        { status: 503 },
      )
    }

    // Retire zombie rows first so the unique cap below can never deadlock a
    // user on a corpse, then a fast advisory check for the friendly 409.
    await expireStaleToolRuns(auth.email)
    if ((await countActiveToolRuns(auth.email)) >= 1) {
      return NextResponse.json(
        { error: 'You already have a deep run in flight — wait for it or cancel it first', reason: 'active_run_exists' },
        { status: 409 },
      )
    }

    // ROW FIRST, job second: a fast worker could otherwise claim and post a
    // result before the product row exists, and the landing CAS would no-op
    // — losing the report. Creating the row first also makes the
    // one-active-run cap atomic: the partial unique index refuses a second
    // 'queued' row for this user, closing the count-check race between
    // overlapping POSTs.
    const runId = crypto.randomUUID()
    const cfg = DEEP_TOOLS[tool]
    try {
      await createToolRun({ id: runId, tool, brief, userEmail: auth.email, chatId })
    } catch (err) {
      if (isActiveRunConflict(err)) {
        return NextResponse.json(
          { error: 'You already have a deep run in flight — wait for it or cancel it first', reason: 'active_run_exists' },
          { status: 409 },
        )
      }
      throw err
    }

    const prompt = composeRunPrompt(tool, brief, await loadSkillContent(tool))
    let outcome: Awaited<ReturnType<typeof enqueueJob>>
    try {
      outcome = await enqueueJob({
        kind: 'work_item',
        prompt,
        deadlineMs: deepToolDeadlineMs(tool),
        meta: {
          toolRunId: runId,
          tool,
          userEmail: auth.email.toLowerCase().trim(),
          ...(cfg.effort ? { effort: cfg.effort } : {}),
        },
      })
    } catch (err) {
      // No job ⇒ the row must not sit 'queued' (it would hold the cap).
      await finishToolRun(db, runId, { status: 'failed', errorClass: 'no_worker', error: 'enqueue failed' }).catch(() => null)
      throw err
    }
    if ('refused' in outcome) {
      await finishToolRun(db, runId, { status: 'failed', errorClass: 'queue_full', error: 'dispatch queue at work capacity' }).catch(() => null)
      return NextResponse.json(
        { error: 'The deep engine is at capacity — try again shortly', reason: 'queue_full' },
        { status: 503 },
      )
    }
    emit({ type: 'dispatch_enqueued', jobId: outcome.id, kind: 'work_item' })
    // Best-effort: landing keys on toolRunId, not job_id; a lost attach only
    // costs the live-state derivation, which then reports by age.
    await attachToolRunJob(runId, outcome.id).catch(() => {})

    return NextResponse.json({
      run: {
        id: runId,
        tool,
        status: 'queued',
        brief,
        chatId,
        jobId: outcome.id,
        createdAt: new Date().toISOString(),
      },
    })
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ error: 'deep-run tables missing — run migrations', reason: 'not_migrated' }, { status: 503 })
    }
    console.error('[deep-runs POST]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to start the deep run' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff()
  if (auth instanceof NextResponse) return auth

  const toolParam = req.nextUrl.searchParams.get('tool')
  if (toolParam !== null && !isDeepToolId(toolParam)) {
    return NextResponse.json({ error: 'unknown tool' }, { status: 400 })
  }
  // Read the raw param before converting: Number(null) is 0, which would
  // silently turn "no limit given" into a limit of 1 after clamping.
  const rawLimit = req.nextUrl.searchParams.get('limit')
  const parsed = rawLimit === null ? NaN : Number(rawLimit)
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), 1), 20) : 10

  try {
    const runs = await listToolRuns(auth.email, { tool: toolParam ?? undefined, limit })
    return NextResponse.json({ runs })
  } catch (err) {
    if (isMissingTableError(err)) return NextResponse.json({ runs: [] })
    console.error('[deep-runs GET]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to list deep runs' }, { status: 500 })
  }
}
