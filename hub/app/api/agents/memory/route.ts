import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { StoreMemoryRequestSchema, QueryMemoryRequestSchema } from '@/lib/zod-schemas'
import { storeMemory, queryMemories } from '@/lib/agent-memory'
import { recordEvent } from '@/lib/event-logger'

const log = createLogger('api/agents/memory')

export const runtime = 'nodejs'

/**
 * GET /api/agents/memory
 * Query agent memories using filters and search.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

  try {
    const results = await queryMemories({
      agentId: parsed.data.agentId,
      memoryType: parsed.data.memoryType,
      searchQuery: parsed.data.searchQuery,
      limit: parsed.data.limit,
    })

    return NextResponse.json({ memories: results })
  } catch (err) {
    log.error({ err }, 'Failed to query agent memories')
    return NextResponse.json({ error: 'Failed to query memories' }, { status: 500 })
  }
}

/**
 * POST /api/agents/memory
 * Store a new agent memory entry.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

  try {
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
  } catch (err) {
    log.error({ err }, 'Failed to store agent memory')
    return NextResponse.json({ error: 'Failed to store memory' }, { status: 500 })
  }
}
