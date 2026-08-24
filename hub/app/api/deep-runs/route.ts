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
  cancelJob,
  enqueueJob,
  isMissingTableError,
  workerFresh,
} from '@/lib/dispatch-store'
import { dispatchFreshMs, isDispatchConfigured, isDispatchEnabled } from '@/lib/agy-dispatch'
import { countActiveToolRuns, createToolRun, listToolRuns } from '@/lib/tool-runs'
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
    const fresh = await workerFresh(dispatchFreshMs())
    if (!fresh) {
      return NextResponse.json(
        { error: 'The desktop worker is offline — deep runs execute on your desktop allotment', reason: 'no_worker' },
        { status: 503 },
      )
    }

    if ((await countActiveToolRuns(auth.email)) >= 1) {
      return NextResponse.json(
        { error: 'You already have a deep run in flight — wait for it or cancel it first', reason: 'active_run_exists' },
        { status: 409 },
      )
    }

    // Mint the run id BEFORE the enqueue so the job's payload_meta and the
    // tool_runs row agree even if the second write fails (lib/tool-runs.ts).
    const runId = crypto.randomUUID()
    const cfg = DEEP_TOOLS[tool]
    const prompt = composeRunPrompt(tool, brief, await loadSkillContent(tool))
    const outcome = await enqueueJob({
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
    if ('refused' in outcome) {
      return NextResponse.json(
        { error: 'The deep engine is at capacity — try again shortly', reason: 'queue_full' },
        { status: 503 },
      )
    }
    emit({ type: 'dispatch_enqueued', jobId: outcome.id, kind: 'work_item' })

    try {
      await createToolRun({ id: runId, tool, brief, userEmail: auth.email, chatId, jobId: outcome.id })
    } catch (err) {
      // The product record is the point — without it the run would be
      // unwatchable. Stand the job down and fail the request honestly.
      void cancelJob(outcome.id).catch(() => {})
      throw err
    }

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
  const rawLimit = Number(req.nextUrl.searchParams.get('limit'))
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.round(rawLimit), 1), 20) : 10

  try {
    const runs = await listToolRuns(auth.email, { tool: toolParam ?? undefined, limit })
    return NextResponse.json({ runs })
  } catch (err) {
    if (isMissingTableError(err)) return NextResponse.json({ runs: [] })
    console.error('[deep-runs GET]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to list deep runs' }, { status: 500 })
  }
}
