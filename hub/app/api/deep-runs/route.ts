import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessStaffRoute } from '@/lib/roles'
import { briefError, DEEP_TOOLS, isDeepToolId } from '@/lib/deep-runs'
import { isMissingTableError } from '@/lib/dispatch-store'
import { listToolRuns } from '@/lib/tool-runs'
import { resolveContextArtifacts, startDeepRun } from '@/lib/deep-run-start'
import { withFault } from '@/lib/route-fault'
import { getTenantId } from '@/lib/tenant-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * /api/deep-runs — start and list deep tool runs
 * (docs/architecture/DEEP_LANE_2026-08-23.md §4, PR B).
 *
 * POST { tool, brief, chatId?, context? } → { run } — validates the request,
 * then hands off to lib/deep-run-start.ts (the ONE start path, shared with
 * the needs-you Retry): dispatch enabled/configured → fresh worker
 * heartbeat (allotment-only, FAIL HONEST: no metered fallback, design §7)
 * → per-tenant-user cap of 1 active run → row first, job second. Returns
 * immediately; the client polls GET /api/deep-runs/:id. Session policy:
 * staff+ (onboarding excluded, same as tool-artifacts).
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
  if (body.context !== undefined) {
    if (
      !Array.isArray(body.context) ||
      body.context.length > 6 ||
      !body.context.every((id): id is string => typeof id === 'string' && id.trim().length > 0)
    ) {
      return NextResponse.json({ error: 'context must be an array of up to 6 non-empty artifact ID strings' }, { status: 400 })
    }
    contextIds = [...new Set(body.context.map(id => id.trim()))]
  }

  const tool = body.tool
  const brief = (body.brief as string).trim()
  const chatId = typeof body.chatId === 'string' && body.chatId.length <= 100 ? body.chatId : null

  try {
    const context = await resolveContextArtifacts(contextIds, tenantId, auth.email)
    if (!context.ok) return NextResponse.json({ error: context.error }, { status: context.status })

    const started = await startDeepRun({
      tool,
      brief,
      tenantId,
      userEmail: auth.email,
      chatId,
      ownedArtifacts: context.ownedArtifacts,
      contextPayload: context.contextPayload,
    })
    if (!started.ok) {
      return NextResponse.json({ error: started.error, reason: started.reason }, { status: started.status })
    }
    return NextResponse.json({ run: started.run })
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
