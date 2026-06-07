import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { searchSemanticBrain } from '@/lib/vertex'
import { createLogger } from '@/lib/logger'

const log = createLogger('admin-vertex-test')

export const runtime = 'nodejs'

/**
 * POST /api/admin/vertex-test
 *
 * Runs a test search query against the tenant's Vertex AI engine.
 * Admin-only endpoint for the Knowledge Base "Test Search" button.
 *
 * Body: { query: string }
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const chatUser = session.user as Record<string, unknown>
  const role = chatUser.role as string
  if (role !== 'admin' && role !== 'superadmin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  let body: { query: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.query?.trim()) {
    return NextResponse.json({ error: 'Query is required' }, { status: 400 })
  }

  try {
    const tenantId = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'
    const startTime = Date.now()
    const results = await searchSemanticBrain(body.query.trim(), tenantId)
    const durationMs = Date.now() - startTime

    if (results === null) {
      return NextResponse.json({
        success: false,
        error: 'Vertex AI returned null — engine may be misconfigured or SA key missing',
        durationMs,
      })
    }

    log.info({ query: body.query, resultCount: results.length, durationMs }, 'Admin Vertex AI test search')

    return NextResponse.json({
      success: true,
      query: body.query,
      resultCount: results.length,
      durationMs,
      results: results.map(r => ({
        title: r.title,
        snippet: r.snippet.slice(0, 500),
        uri: r.uri,
        source: r.source,
      })),
    })
  } catch (err) {
    log.error({ err }, 'Admin Vertex AI test search failed')
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
}
