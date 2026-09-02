import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { getProjects } from '@/lib/paperclip'
import { withFault } from '@/lib/route-fault'

const log = createLogger('paperclip/projects')

export const runtime = 'nodejs'

/**
 * GET /api/paperclip/projects?companyId=<id>
 *
 * Normalized project list for the right panel's Spaces tab. Workspace
 * sub-resources and runtime-service mutations go through the [...path]
 * proxy (admin-gated, ownership pre-checked). Access scoping matches the
 * other dedicated read routes.
 */
export const GET = withFault('paperclip/projects', async (req: NextRequest) => {
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
    const projects = await getProjects(companyId)
    return NextResponse.json(
      { projects },
      { headers: { 'Cache-Control': 'private, max-age=30' } }
    )
  } catch (error: unknown) {
    // Rethrown for withFault to record and answer. The log line stays because
    // it is the only place companyId survives — withFault's own line carries
    // requestId/route/faultId but knows nothing about the workspace, and this
    // is the field that separates "Paperclip is down" from "this one
    // workspace's data is broken". The response the client used to get here
    // echoed error.message verbatim; it now gets the fixed per-code message.
    log.error({ err: error, companyId }, 'Project list fetch failed')
    throw error
  }
})
