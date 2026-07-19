import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { getGoals } from '@/lib/paperclip'

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
    const goals = await getGoals(companyId)
    return NextResponse.json(
      { goals },
      { headers: { 'Cache-Control': 'private, max-age=20' } }
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load goals'
    log.error({ err: error, companyId }, 'Goal list fetch failed')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
