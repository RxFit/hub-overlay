import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { paperclipFetch } from '@/lib/paperclip'
import { recordEvent } from '@/lib/event-logger'


// Standard C-Suite agent template — seeded for every new workspace
const AGENT_TEMPLATES = [
  {
    role: 'CEO',
    name: (companyName: string) => `${companyName} CEO`,
    canCreateAgents: true,
    instructions: (companyName: string) => `You are the CEO of ${companyName}. You are the primary orchestrator for this company within Paperclip. You receive issues, delegate to your C-Suite, and ensure all company objectives are met. Always assign new issues to the most relevant C-Suite agent after reviewing them. Escalate to the board (Danny Trejo / Antigravity) only for: external communications, budget decisions over $500, and strategic pivots.`,
    reportingRole: null as string | null,
  },
  {
    role: 'CMO',
    name: (companyName: string) => `${companyName} CMO`,
    canCreateAgents: false,
    instructions: (companyName: string) => `You are the Chief Marketing Officer of ${companyName}. You own all marketing, growth, brand, and customer acquisition initiatives. Report to the CEO. Use web research (exa_search) for competitor intelligence and market trends. Your weekly heartbeat: audit all marketing KPIs and surface the top 3 actions needed.`,
    reportingRole: 'CEO',
  },
  {
    role: 'CTO',
    name: (companyName: string) => `${companyName} CTO`,
    canCreateAgents: false,
    instructions: (companyName: string) => `You are the Chief Technology Officer of ${companyName}. You own all technical architecture, engineering quality, DevOps, and security. Report to the CEO. Your daily heartbeat: check system health, audit open GitHub issues/PRs, and flag any technical blockers. Use exa_search for relevant technology updates.`,
    reportingRole: 'CEO',
  },
  {
    role: 'CFO',
    name: (companyName: string) => `${companyName} CFO`,
    canCreateAgents: false,
    instructions: (companyName: string) => `You are the Chief Financial Officer of ${companyName}. You own all financial tracking, revenue analysis, and billing oversight. Report to the CEO. Your weekly heartbeat: audit Stripe data, track revenue vs. projections, flag variances >15%. Never execute charges — prepare for human (Danny) approval.`,
    reportingRole: 'CEO',
  },
  {
    role: 'COO',
    name: (companyName: string) => `${companyName} COO`,
    canCreateAgents: false,
    instructions: (companyName: string) => `You are the Chief Operating Officer of ${companyName}. You own operational workflows, team coordination, and process efficiency. Report to the CEO. Route all external-facing communications through Antigravity (board) before sending. Your weekly heartbeat: check all operational workflows and identify bottlenecks.`,
    reportingRole: 'CEO',
  },
]

// Custom paperclipPost deprecated in favor of shared hardened paperclipFetch


export async function POST(req: NextRequest) {
  // Auth guard — admin or superadmin. Workspace provisioning is an
  // admin-level action (matches INTENT_PERMISSIONS.create_workspace = 'admin'
  // in lib/interview.ts). Staff and onboarding are rejected.
  const session = await getServerSession(authOptions)
  const userRole = (session?.user as Record<string, unknown>)?.role as string
  if (userRole !== 'superadmin' && userRole !== 'admin') {
    return NextResponse.json({ error: 'Forbidden — admin or superadmin required' }, { status: 403 })
  }

  let body: {
    companyName: string
    issuePrefix: string
    brandColor?: string
    agentTemplate?: 'csuite' | 'ceo-only'
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { companyName, issuePrefix, brandColor = '#C5A059', agentTemplate = 'csuite' } = body

  if (!companyName?.trim() || !issuePrefix?.trim()) {
    return NextResponse.json({ error: 'companyName and issuePrefix are required' }, { status: 400 })
  }

  if (!/^[A-Z]{2,5}$/.test(issuePrefix.trim().toUpperCase())) {
    return NextResponse.json({ error: 'issuePrefix must be 2–5 uppercase letters' }, { status: 400 })
  }

  const results: {
    company: object | null
    agents: object[]
    errors: string[]
  } = { company: null, agents: [], errors: [] }

  // 1. Create company in Paperclip
  try {
    const companyRes = await paperclipFetch<any>('/api/companies', {
      method: 'POST',
      body: JSON.stringify({
        name: companyName.trim(),
        identifier: issuePrefix.trim().toUpperCase(),
        description: `${companyName} workspace — provisioned via Hub Admin Panel`,
      }),
    }, undefined, session?.user?.email ?? undefined)
    results.company = companyRes.company ?? companyRes
    const companyId = (results.company as Record<string, string>).id

    // 2. Seed agents
    const templatesToSeed = agentTemplate === 'ceo-only'
      ? AGENT_TEMPLATES.filter(t => t.role === 'CEO')
      : AGENT_TEMPLATES

    const createdAgents: Record<string, string> = {}  // role → agentId

    for (const template of templatesToSeed) {
      try {
        // Find reporting agent ID if needed
        const reportsToId = template.reportingRole
          ? createdAgents[template.reportingRole] ?? null
          : null

        const agentRes = await paperclipFetch<any>(`/api/companies/${companyId}/agents`, {
          method: 'POST',
          body: JSON.stringify({
            name: template.name(companyName.trim()),
            role: template.role,
            instructions: template.instructions(companyName.trim()),
            canCreateAgents: template.canCreateAgents,
            status: 'active',
            adapterType: 'gemini_local',
            adapterConfig: {
              baseUrl: 'https://rxfit-llm-proxy-6r2wdzwkoq-uc.a.run.app',
              model: 'auto',
            },
            runtimeConfig: {
              heartbeat: {
                intervalSec: 86400,
                enabled: true,
              },
            },
            reportsTo: reportsToId,
          }),
        }, undefined, session?.user?.email ?? undefined)
        const agent = agentRes.agent ?? agentRes
        createdAgents[template.role] = agent.id
        results.agents.push(agent)
      } catch (err) {
        const msg = `Failed to create ${template.role}: ${err instanceof Error ? err.message : String(err)}`
        results.errors.push(msg)
      }
    }

    await recordEvent({
      eventType: 'workspace.provisioned',
      actor: `hub-user:${session?.user?.email || 'admin'}`,
      resourceType: 'company',
      resourceId: companyId,
      payload: {
        companyName,
        issuePrefix,
        agentsSeededCount: results.agents.length,
      },
    })

    return NextResponse.json({
      success: true,
      companyName: companyName.trim(),
      issuePrefix: issuePrefix.trim().toUpperCase(),
      brandColor,
      company: results.company,
      agents: results.agents,
      agentsCreated: results.agents.length,
      errors: results.errors,
      message: results.errors.length === 0
        ? `Workspace "${companyName}" provisioned with ${results.agents.length} agents.`
        : `Workspace created but ${results.errors.length} agent(s) failed. Check errors.`,
    })
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: `Failed to create company: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
}
