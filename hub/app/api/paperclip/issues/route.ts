import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createIssue, getAgents } from '@/lib/paperclip'
import { RXFIT_COMPANY_ID, RXFIT_CEO_AGENT_ID } from '@/lib/paperclipConfig'
import type { HubUser } from '@/types'

export const runtime = 'nodejs'

// Default company for issues when no companyId is specified — always the RxFit org.
const DEFAULT_COMPANY_ID = process.env.DEFAULT_PAPERCLIP_COMPANY_ID || RXFIT_COMPANY_ID

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = session.user as unknown as HubUser
  const userRole = (session.user as unknown as Record<string, unknown>).role as string

  let body: { title?: string; description?: string; priority?: string; companyId?: string; assigneeId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Resolve the target company ID:
  // 1. Explicit companyId from request body (most specific)
  // 2. First assigned project (if not wildcard)
  // 3. Default CEO workspace (for superadmin or wildcard)
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
    // Superadmin/admin: default to CEO workspace
    companyId = DEFAULT_COMPANY_ID
  } else {
    return NextResponse.json({ error: 'No assigned projects' }, { status: 403 })
  }

  const { title, description, priority } = body

  if (!title) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }

  try {
    // Find the CEO agent — all inbound issues go to the CEO first (chain-of-command):
    // 1. Use explicit assigneeId from request body if provided
    // 2. Search for CEO by name in the workspace
    // 3. Fallback to RXFIT_CEO_AGENT_ID from centralized config
    let assigneeId: string | undefined = body.assigneeId
    if (!assigneeId) {
      try {
        const agents = await getAgents(companyId)
        const ceo = agents.find(
          (a) => a.name.toLowerCase().includes('ceo')
        ) || agents.find(
          (a) => a.name.toLowerCase().includes('manager')
        ) || (agents.length > 0 ? agents[0] : undefined)

        if (ceo) {
          assigneeId = ceo.id
        } else {
          // Centralized fallback — CEO 2 in RxFit org
          assigneeId = RXFIT_CEO_AGENT_ID
        }
      } catch (err) {
        console.warn(`[Paperclip] Failed to fetch agents for company ${companyId}, using default CEO ID`, err)
        assigneeId = RXFIT_CEO_AGENT_ID
      }
    }

    const issue = await createIssue(companyId, {
      title,
      description,
      priority: priority || 'medium',
      assigneeId,
    })

    return NextResponse.json({ issue })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create issue'
    console.error('[API] POST /api/paperclip/issues error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
