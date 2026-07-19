import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { getRoutines } from '@/lib/paperclip'

const log = createLogger('paperclip/routines')

export const runtime = 'nodejs'

/**
 * GET /api/paperclip/routines?companyId=<id>
 *
 * Normalized routine list for the right panel's Routines tab and the
 * update/run routine chat intents. Mutations (pause/resume/run-now/trigger
 * CRUD) go through the [...path] proxy where the role gate and ownership
 * pre-checks live. Access scoping matches the issues/agents routes.
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
    const routines = await getRoutines(companyId)
    return NextResponse.json(
      { routines },
      { headers: { 'Cache-Control': 'private, max-age=20' } }
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load routines'
    log.error({ err: error, companyId }, 'Routine list fetch failed')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
