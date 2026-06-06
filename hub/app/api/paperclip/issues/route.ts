import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { createIssue, getAgents } from '@/lib/paperclip'
import { recordEvent } from '@/lib/event-logger'
import { RXFIT_CEO_COMPANY_ID, RXFIT_CEO_AGENT_ID } from '@/lib/paperclipConfig'
import { CreateIssueRequestSchema } from '@/lib/zod-schemas'
import type { HubUser } from '@/types'

const log = createLogger('paperclip/issues')

export const runtime = 'nodejs'

// Default company for issues when no companyId is specified — always the RxFit org.
const DEFAULT_COMPANY_ID = process.env.DEFAULT_PAPERCLIP_COMPANY_ID || RXFIT_CEO_COMPANY_ID

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = session.user as unknown as HubUser
  const userRole = (session.user as unknown as Record<string, unknown>).role as string

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = CreateIssueRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 })
  }

  const { title, description, priority, companyId: bodyCompanyId, assigneeId: bodyAssigneeId } = parsed.data

  // Resolve the target company ID:
  // 1. Explicit companyId from request body (most specific)
  // 2. First assigned project (if not wildcard)
  // 3. Default CEO workspace (for superadmin or wildcard)
  let companyId: string
  if (bodyCompanyId) {
    companyId = bodyCompanyId
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

  try {
    // Find the CEO agent — all inbound issues go to the CEO first (chain-of-command):
    // 1. Use explicit assigneeId from request body if provided
    // 2. Search for CEO by name in the workspace
    // 3. Fallback to RXFIT_CEO_AGENT_ID from centralized config
    let assigneeId: string | undefined = bodyAssigneeId
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
        log.warn({ companyId, err }, 'Failed to fetch agents, using default CEO ID')
        assigneeId = RXFIT_CEO_AGENT_ID
      }
    }

    const issue = await createIssue(companyId, {
      title,
      description,
      priority: priority || 'medium',
      assigneeId,
    })

    await recordEvent({
      eventType: 'issue.created',
      actor: `hub-user:${user.email || 'unknown'}`,
      resourceType: 'issue',
      resourceId: issue.id,
      payload: {
        title: issue.title,
        identifier: issue.identifier,
        companyId,
        assigneeId,
      },
    })

    return NextResponse.json({ issue })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create issue'
    log.error({ err: error }, 'Issue creation failed')

    recordEvent({
      eventType: 'issue.creation_failed',
      actor: `hub-user:${user.email || 'unknown'}`,
      resourceType: 'issue',
      payload: {
        title,
        companyId,
        error: message,
      },
    }).catch(() => {})

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
