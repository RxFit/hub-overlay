import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { createIssue, getAgents, getIssues, isAgentMemberOfCompany } from '@/lib/paperclip'
import { recordEvent } from '@/lib/event-logger'
import { RXFIT_CEO_COMPANY_ID, RXFIT_CEO_AGENT_ID } from '@/lib/paperclipConfig'
import { CreateIssueRequestSchema } from '@/lib/zod-schemas'
import { verifyGateToken } from '@/lib/gateToken'
import { canWrite } from '@/lib/proxyAuthz'
import type { HubUser } from '@/types'
import { withFault } from '@/lib/route-fault'

const log = createLogger('paperclip/issues')

export const runtime = 'nodejs'

// Default company for issues when no companyId is specified — always the RxFit org.
const DEFAULT_COMPANY_ID = process.env.DEFAULT_PAPERCLIP_COMPANY_ID || RXFIT_CEO_COMPANY_ID

/**
 * GET /api/paperclip/issues?companyId=<id>&limit=<n>&stateGroup=<group>
 *
 * Normalized issue list for the right panel's Issues tab. The [...path] proxy
 * would return Paperclip's raw wire shapes; this route reuses
 * lib/paperclip.getIssues so the client receives the Hub's Linear-style
 * Issue objects (state group, priority vocabulary). Access scoping matches
 * the runs route: non-wildcard users must be assigned to the company.
 */
export const GET = withFault('paperclip/issues', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required' }, { status: 400 })
  }

  const scopedUser = session.user as Record<string, unknown>
  const scopedRole = scopedUser.role as string
  const scopedProjects = (scopedUser.assignedProjects as string[]) ?? []
  if (
    scopedRole !== 'superadmin' &&
    !scopedProjects.includes('*') &&
    !scopedProjects.includes(companyId)
  ) {
    return NextResponse.json(
      { error: 'Access denied: not assigned to this project' },
      { status: 403 }
    )
  }

  const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? '50')
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50
  const stateGroup = req.nextUrl.searchParams.get('stateGroup') ?? undefined

  try {
    const issues = await getIssues(companyId, { limit, stateGroup })
    return NextResponse.json(
      { issues },
      { headers: { 'Cache-Control': 'private, max-age=20' } }
    )
  } catch (error: unknown) {
    // Rethrown for withFault to record and answer. The log line stays because
    // it is the only place companyId survives — withFault's own line carries
    // requestId/route/faultId but knows nothing about the workspace, and this
    // is the field that separates "Paperclip is down" from "this one
    // workspace's data is broken". The response the client used to get here
    // echoed error.message verbatim; it now gets the fixed per-code message.
    log.error({ err: error, companyId }, 'Issue list fetch failed')
    throw error
  }
})

export const POST = withFault('paperclip/issues', async (req: Request) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = session.user as unknown as HubUser
  const userRole = (session.user as unknown as Record<string, unknown>).role as string

  // P0-1: role-tier enforcement. This dedicated route handles POST
  // /api/paperclip/issues and therefore bypasses the [...path] proxy where the
  // role gate lives — so the same guard must be enforced here.
  if (!canWrite(userRole, 'POST', '/api/issues')) {
    return NextResponse.json(
      { error: 'Forbidden — insufficient role for this operation' },
      { status: 403 }
    )
  }

  // P0-2: issue creation briefs/triggers an agent (high-stakes), so it must
  // carry the server-issued, HMAC-signed quality-gate token minted by
  // /api/chat/score-context. The [...path] proxy enforces this for other writes,
  // but POST /api/paperclip/issues is served by THIS route — without the check
  // here the gate is bypassed entirely (the token was sent but never verified).
  // Fail closed: a missing/forged/expired/below-threshold token is rejected.
  // Single-use (jti) + caller-binding: the token is consumed on first use and
  // bound to the minting user, so it cannot be replayed within its 5-min TTL or
  // reused from a different user's session.
  const gate = verifyGateToken(req.headers.get('x-gate-token'), {
    expectedEmail: user.email,
    consume: true,
  })
  if (!gate.valid) {
    log.warn({ reason: gate.reason }, 'Quality-gate token rejected on issue creation')
    return NextResponse.json(
      { error: `Quality gate not satisfied (${gate.reason ?? 'no valid gate token'}). Re-run this action through the assistant so it can be re-validated.` },
      { status: 403 }
    )
  }

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
    // Validate that the user has access to the requested company
    if (
      userRole !== 'superadmin' &&
      !user.assignedProjects?.includes('*') &&
      !user.assignedProjects?.includes(bodyCompanyId)
    ) {
      return NextResponse.json(
        { error: 'Access denied: you are not assigned to this workspace' },
        { status: 403 }
      )
    }
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
    // 1. Use explicit assigneeId from request body if provided (P1-6b: must be
    //    verified to belong to the target company before use)
    // 2. Search for CEO by name in the workspace
    // 3. Fallback to RXFIT_CEO_AGENT_ID from centralized config
    let assigneeId: string | undefined = bodyAssigneeId
    if (assigneeId) {
      // P1-6b: an explicit assignee must be a member of the target company's
      // agents — otherwise a caller could assign an issue to any arbitrary
      // agent id in another workspace. Fail closed if the agent list can't be
      // resolved (the outer catch returns 500) rather than trusting the input.
      const agents = await getAgents(companyId)
      if (!isAgentMemberOfCompany(agents, assigneeId)) {
        return NextResponse.json(
          { error: 'assigneeId does not belong to the target company' },
          { status: 400 }
        )
      }
    } else {
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
    }, user.email)

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
    // The catch stays for its SIDE EFFECT only: the issue.creation_failed
    // ledger entry is the audit trail for a write that did not happen, and it
    // must be written before the error leaves. The response is then withFault's
    // to make — it used to echo error.message verbatim.
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

    throw error
  }
})
