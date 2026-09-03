import { NextRequest, NextResponse } from 'next/server'
import { toolArtifacts } from '@/lib/schema'
import { eq, inArray, and, sql } from 'drizzle-orm'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessStaffRoute } from '@/lib/roles'
import {
  composeRunPrompt,
  contextPayloadError,
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
import { withFault } from '@/lib/route-fault'
import { getTenantId } from '@/lib/tenant-context'
import { normalizeArtifactOwner } from '@/lib/tool-artifacts'
import { swallow, emptyOn } from '@/lib/swallow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function resolveArtifact(artifact: { title: string; toolId: string; content: unknown }): string {
  const out: string[] = []
  out.push(`--- Tool Artifact (${artifact.toolId}): ${artifact.title} ---`)
  const walk = (sections: unknown, depth: number) => {
    if (!Array.isArray(sections) || depth > 8) return
    for (const raw of sections) {
      if (!raw || typeof raw !== 'object') continue
      const s = raw as Record<string, unknown>
      const title = typeof s.title === 'string' && s.title.trim() ? s.title : 'Untitled section'
      const body = typeof s.content === 'string' ? s.content.trim() : ''
      const heading = '#'.repeat(Math.min(2 + depth, 6))
      if (title !== 'Untitled section' || body) {
        out.push(body ? `${heading} ${title}\n${body}` : `${heading} ${title}`)
      }
      walk(s.children, depth + 1)
    }
  }
  const sections = artifact.content && typeof artifact.content === 'object'
    ? (artifact.content as { sections?: unknown }).sections
    : undefined
  if (sections) {
    walk(sections, 0)
  } else {
    out.push(typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content))
  }
  return out.join('\n\n')
}

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
 *   → per-tenant-user cap of 1 active run.
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

export const POST = withFault('deep-runs', async (req: NextRequest) => {
  const auth = await requireStaff()
  if (auth instanceof NextResponse) return auth
  const tenantId = getTenantId()

  let body: { tool?: unknown; brief?: unknown; chatId?: unknown; context?: unknown }
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
  
  let contextIds: string[] = []
  let contextPayload: string | undefined
  let ownedArtifacts: { id: string; title: string; toolId: string }[] | undefined
  if (body.context !== undefined) {
    if (
      !Array.isArray(body.context) ||
      body.context.length > 6 ||
      !body.context.every((id): id is string => typeof id === 'string' && id.trim().length > 0)
    ) {
      return NextResponse.json({ error: 'context must be an array of up to 6 non-empty artifact ID strings' }, { status: 400 })
    }
    contextIds = [...new Set(body.context.map(id => id.trim()))]
    if (contextIds.length > 0) {
      const owned = await db
        .select({ id: toolArtifacts.id, content: toolArtifacts.content, title: toolArtifacts.title, toolId: toolArtifacts.toolId })
        .from(toolArtifacts)
        .where(and(
          inArray(toolArtifacts.id, contextIds),
          eq(toolArtifacts.tenantId, tenantId),
          eq(toolArtifacts.status, 'active'),
          sql`lower(${toolArtifacts.createdBy}) = ${normalizeArtifactOwner(auth.email)}`,
        ))
      if (owned.length !== contextIds.length) {
        return NextResponse.json({ error: 'one or more context artifacts do not exist or are not owned by you' }, { status: 403 })
      }
      contextPayload = owned.map(resolveArtifact).join('\n\n')
      const contextProblem = contextPayloadError(contextPayload)
      if (contextProblem) return NextResponse.json({ error: contextProblem }, { status: 400 })
      ownedArtifacts = owned.map(o => ({ id: o.id, title: o.title, toolId: o.toolId }))
    }
  }

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
    await expireStaleToolRuns(tenantId, auth.email)
    if ((await countActiveToolRuns(tenantId, auth.email)) >= 1) {
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
      await createToolRun({ id: runId, tool, brief, inputs: ownedArtifacts, tenantId, userEmail: auth.email, chatId })
    } catch (err) {
      if (isActiveRunConflict(err)) {
        return NextResponse.json(
          { error: 'You already have a deep run in flight — wait for it or cancel it first', reason: 'active_run_exists' },
          { status: 409 },
        )
      }
      throw err
    }

    const prompt = composeRunPrompt(tool, brief, await loadSkillContent(tool), contextPayload)
    let outcome: Awaited<ReturnType<typeof enqueueJob>>
    try {
      outcome = await enqueueJob({
        kind: 'work_item',
        prompt,
        deadlineMs: deepToolDeadlineMs(tool),
        meta: {
          toolRunId: runId,
          tool,
          tenantId,
          userEmail: auth.email.toLowerCase().trim(),
          ...(cfg.effort ? { effort: cfg.effort } : {}),
        },
      })
    } catch (err) {
      // No job ⇒ the row must not sit 'queued' (it would hold the cap).
      await finishToolRun(db, runId, { status: 'failed', errorClass: 'no_worker', error: 'enqueue failed' }).catch((err: unknown) => emptyOn(err, { module: 'api/deep-runs', op: 'finishToolRunAfterEnqueueFailure' }, null))
      throw err
    }
    if ('refused' in outcome) {
      await finishToolRun(db, runId, { status: 'failed', errorClass: 'queue_full', error: 'dispatch queue at work capacity' }).catch((err: unknown) => emptyOn(err, { module: 'api/deep-runs', op: 'finishToolRunAfterQueueRefusal' }, null))
      return NextResponse.json(
        { error: 'The deep engine is at capacity — try again shortly', reason: 'queue_full' },
        { status: 503 },
      )
    }
    emit({ type: 'dispatch_enqueued', jobId: outcome.id, kind: 'work_item' })
    // Best-effort: landing keys on toolRunId, not job_id; a lost attach only
    // costs the live-state derivation, which then reports by age.
    await attachToolRunJob(runId, outcome.id).catch((err: unknown) => swallow(err, { module: 'api/deep-runs', op: 'attachToolRunJob' }))

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
    // The guard above is the only classification this catch makes. Everything
    // else is withFault's to record and answer — it used to become an opaque
    // 500 with nothing written down.
    throw err
  }
})

export const GET = withFault('deep-runs', async (req: NextRequest) => {
  const auth = await requireStaff()
  if (auth instanceof NextResponse) return auth
  const tenantId = getTenantId()

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
    const runs = await listToolRuns(tenantId, auth.email, { tool: toolParam ?? undefined, limit })
    return NextResponse.json({ runs })
  } catch (err) {
    // Pre-migration is not a failure to report: an empty list is the honest
    // answer for a table that does not exist yet, and the panel renders it.
    if (isMissingTableError(err)) return NextResponse.json({ runs: [] })
    // The guard above is the only classification this catch makes. Everything
    // else is withFault's to record and answer — it used to become an opaque
    // 500 with nothing written down.
    throw err
  }
})
