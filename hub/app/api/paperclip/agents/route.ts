import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { getAgents } from '@/lib/paperclip'

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
export async function GET(req: NextRequest) {
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
    const message = error instanceof Error ? error.message : 'Failed to load agents'
    log.error({ err: error, companyId }, 'Agent roster fetch failed')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
