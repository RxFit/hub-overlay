import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { AppError } from '@/lib/errors'
import { createLogger } from '@/lib/logger'
import { getRuns } from '@/lib/paperclip'
import { withFault } from '@/lib/route-fault'

const log = createLogger('paperclip/runs')

export const runtime = 'nodejs'

/**
 * GET /api/paperclip/runs?companyId=<id>&limit=<n>
 *
 * Paperclip has no /api/companies/:id/runs endpoint — runs are per-issue at
 * /api/issues/:id/runs. lib/paperclip.getRuns() aggregates them across the
 * company's recent issues; this route exposes that aggregation to the client
 * (chat intents like "view runs" and the Execution Feed).
 */
export const GET = withFault('paperclip/runs', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }

  // Project-scoped access control (same policy as the proxy route)
  const user = session.user as Record<string, unknown>
  const role = user.role as string
  const assignedProjects = (user.assignedProjects as string[]) ?? []
  if (
    role !== 'superadmin' &&
    !assignedProjects.includes('*') &&
    !assignedProjects.includes(companyId)
  ) {
    return NextResponse.json(
      { error: 'Access denied: not assigned to this project' },
      { status: 403 }
    )
  }

  const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? '20')
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 20

  try {
    const runs = await getRuns(companyId, { limit })
    return NextResponse.json({ runs })
  } catch (error: unknown) {
    // This route answers 502, not 500: the aggregation is a fan-out across
    // Paperclip, so a failure here is upstream's. Naming the code preserves
    // that status through withFault (statusForCode maps upstream_5xx → 502)
    // where a bare `throw` would flatten it to a 500 — and `cause` keeps the
    // original error in the fault's causeChain, so nothing is lost. The
    // response used to echo error.message verbatim.
    log.error({ err: error, companyId }, 'Run aggregation failed')
    throw new AppError('Paperclip run aggregation failed', {
      code: 'upstream_5xx',
      cause: error,
      context: { route: 'paperclip/runs' },
    })
  }
})
