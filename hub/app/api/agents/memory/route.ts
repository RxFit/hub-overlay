import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { StoreMemoryRequestSchema, QueryMemoryRequestSchema } from '@/lib/zod-schemas'
import { storeMemory, queryMemories } from '@/lib/agent-memory'
import { recordEvent } from '@/lib/event-logger'
import { canAccessStaffRoute } from '@/lib/roles'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * Role gate (P1/P2): agent memory is the agent fleet's shared knowledge — any
 * authenticated user (incl. `onboarding`) could previously read ALL tenant
 * memory and POST arbitrary content for any agentId (memory-poisoning). Require
 * `staff` or above. This route has no service/bearer path (it is only ever
 * called from an authenticated Hub session), so gating the session path is
 * sufficient.
 *
 * RESIDUAL SCOPING GAP: agent memory rows are tenant-scoped only — there is no
 * clean agentId→project mapping at this layer — so staff are NOT further
 * restricted to their assignedProjects here. Admins/superadmin already see all;
 * for staff this remains tenant-wide. Tracked as follow-up (see PR body).
 */
function memoryRole(session: { user?: unknown } | null): string | undefined {
  return (session?.user as Record<string, unknown> | undefined)?.role as string | undefined
}

/**
 * GET /api/agents/memory
 * Query agent memories using filters and search.
 */
export const GET = withFault('agents/memory', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessStaffRoute(memoryRole(session))) {
    return NextResponse.json({ error: 'Forbidden — staff access required' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId') || undefined
  const memoryType = searchParams.get('memoryType') || undefined
  const searchQuery = searchParams.get('searchQuery') || undefined
  const limitStr = searchParams.get('limit')
  const limit = limitStr ? parseInt(limitStr, 10) : undefined

  const parsed = QueryMemoryRequestSchema.safeParse({
    agentId,
    memoryType,
    searchQuery,
    limit,
  })

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid parameters', details: parsed.error.issues },
      { status: 400 },
    )
  }

  const results = await queryMemories({
    agentId: parsed.data.agentId,
    memoryType: parsed.data.memoryType,
    searchQuery: parsed.data.searchQuery,
    limit: parsed.data.limit,
  })

  return NextResponse.json({ memories: results })
})

/**
 * POST /api/agents/memory
 * Store a new agent memory entry.
 */
export const POST = withFault('agents/memory', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessStaffRoute(memoryRole(session))) {
    return NextResponse.json({ error: 'Forbidden — staff access required' }, { status: 403 })
  }

  const actorEmail = session.user.email || 'unknown-user'

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = StoreMemoryRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 },
    )
  }

  const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null

  const [stored] = await storeMemory({
    agentId: parsed.data.agentId,
    memoryType: parsed.data.memoryType,
    content: parsed.data.content,
    context: parsed.data.context,
    relevanceScore: parsed.data.relevanceScore,
    expiresAt,
  })

  // Audit log the event
  await recordEvent({
    eventType: 'agent.memory_stored',
    actor: `hub-user:${actorEmail}`,
    resourceType: 'agent',
    resourceId: parsed.data.agentId,
    payload: {
      memoryId: stored.id,
      memoryType: parsed.data.memoryType,
      contextKeys: parsed.data.context ? Object.keys(parsed.data.context) : [],
    },
  })

  return NextResponse.json({ success: true, memory: stored })
})
