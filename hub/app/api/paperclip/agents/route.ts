import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { getAgents } from '@/lib/paperclip'
import { withFault } from '@/lib/route-fault'

const log = createLogger('paperclip/agents')

export const runtime = 'nodejs'

/**
 * GET /api/paperclip/agents?companyId=<id>
 *
 * Normalized agent roster for the right panel's Agents tab. Reuses
 * lib/paperclip.getAgents so the client receives the Hub's Agent shape
 * (3-state status plus rawStatus for lifecycle affordances). Access scoping
 * matches the runs/issues routes. Lifecycle mutations (wake/pause/resume/
 * clear-error) do NOT go through here — they go through the [...path] proxy,
 * where the role gate and ownership pre-checks live.
 */
export const GET = withFault('paperclip/agents', async (req: NextRequest) => {
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
    const agents = await getAgents(companyId)
    return NextResponse.json(
      { agents },
      { headers: { 'Cache-Control': 'private, max-age=20' } }
    )
  } catch (error: unknown) {
    // Rethrown for withFault to record and answer. The log line stays because
    // it is the only place companyId survives — withFault's own line carries
    // requestId/route/faultId but knows nothing about the workspace, and this
    // is the field that separates "Paperclip is down" from "this one
    // workspace's data is broken". The response the client used to get here
    // echoed error.message verbatim; it now gets the fixed per-code message.
    log.error({ err: error, companyId }, 'Agent roster fetch failed')
    throw error
  }
})
