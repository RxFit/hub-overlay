import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createIssue, getAgents } from '@/lib/paperclip'
import type { HubUser } from '@/types'

export const runtime = 'nodejs'

// Default company for superadmin when no companyId is specified
const DEFAULT_COMPANY_ID = process.env.DEFAULT_PAPERCLIP_COMPANY_ID || '829b2493-97ed-4cb9-8775-ff8298dcf650'

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = session.user as unknown as HubUser
  const userRole = (session.user as unknown as Record<string, unknown>).role as string

  let body: { title?: string; description?: string; priority?: string; companyId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Resolve the target company ID:
  // 1. Explicit companyId from request body (most specific)
  // 2. First assigned project (if not wildcard)
  // 3. Default RxFit company (for superadmin or wildcard)
  let companyId: string
  if (body.companyId) {
    companyId = body.companyId
  } else if (
    user.assignedProjects &&
    user.assignedProjects.length > 0 &&
    !user.assignedProjects.includes('*')
  ) {
    companyId = user.assignedProjects[0]
  } else if (userRole === 'superadmin' || userRole === 'admin') {
    // Superadmin/admin: default to RxFit Enterprise
    companyId = DEFAULT_COMPANY_ID
  } else {
    return NextResponse.json({ error: 'No assigned projects' }, { status: 403 })
  }

  const { title, description, priority } = body

  if (!title) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }

  try {
    // Try to find the CEO agent
    let ceoAgentId: string | undefined
    try {
      const agents = await getAgents(companyId)
      const ceo = agents.find(
        (a) => a.name.toLowerCase().includes('ceo') || a.name.toLowerCase().includes('manager')
      )
      if (ceo) {
        ceoAgentId = ceo.id
      }
    } catch (err) {
      console.warn(`Failed to fetch agents for company ${companyId}`, err)
    }

    const issue = await createIssue(companyId, {
      title,
      description,
      priority: priority || 'medium',
      assigneeId: ceoAgentId,
    })

    return NextResponse.json({ issue })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create issue'
    console.error('[API] POST /api/paperclip/issues error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

