import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { getGoals } from '@/lib/paperclip'
import { withFault } from '@/lib/route-fault'

const log = createLogger('paperclip/goals')

export const runtime = 'nodejs'

/**
 * GET /api/paperclip/goals?companyId=<id>
 *
 * Normalized goal list (flat — the client builds the hierarchy from parentId)
 * for the right panel's Goals tab and the create/update goal chat intents.
 * Mutations go through the [...path] proxy. Access scoping matches the
 * issues/agents/routines routes.
 */
export const GET = withFault('paperclip/goals', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }

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

  try {
    const goals = await getGoals(companyId)
    return NextResponse.json(
      { goals },
      { headers: { 'Cache-Control': 'private, max-age=20' } }
    )
  } catch (error: unknown) {
    // Rethrown for withFault to record and answer. The log line stays because
    // it is the only place companyId survives — withFault's own line carries
    // requestId/route/faultId but knows nothing about the workspace, and this
    // is the field that separates "Paperclip is down" from "this one
    // workspace's data is broken". The response the client used to get here
    // echoed error.message verbatim; it now gets the fixed per-code message.
    log.error({ err: error, companyId }, 'Goal list fetch failed')
    throw error
  }
})
