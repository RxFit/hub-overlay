import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { getCompanies, getAgents, getIssues, getRuns } from '@/lib/paperclip'
import type { CEOPulseRecord, DepartmentPulse, DepartmentHealth, AgentRoleKey, Agent, Run } from '@/types'

const log = createLogger('paperclip/ceo-pulse')

export const runtime = 'nodejs'

/* ══════════════════════════════════════════════════════════════════════════════
   CEO PULSE API
   GET /api/paperclip/ceo-pulse?orgId=[optional]
   
   Aggregates Paperclip data to generate a CEO Pulse record:
   - Fetches all accessible companies (orgs)
   - For each org, fetches agents + recent issues/runs
   - Scores each department: ON_TRACK / DRIFTING / CRITICAL
   - Returns CEOPulseRecord with globalHealthPct
   ══════════════════════════════════════════════════════════════════════════════ */

// Role keyword matching — used to classify agents into C-Suite roles
const ROLE_KEYWORDS: Record<AgentRoleKey, string[]> = {
  ceo:       ['ceo', 'chief executive', 'board'],
  cmo:       ['cmo', 'marketing', 'content', 'seo', 'brand'],
  cto:       ['cto', 'technical', 'engineer', 'dev', 'tech'],
  cfo:       ['cfo', 'finance', 'revenue', 'billing', 'stripe'],
  coo:       ['coo', 'operations', 'ops', 'comms'],
  marketing: ['marketing', 'content', 'seo', 'brand', 'cmo'],
  technical: ['technical', 'engineer', 'dev', 'tech', 'cto'],
  revenue:   ['revenue', 'finance', 'billing', 'stripe', 'cfo'],
}

function classifyAgentRole(agentName: string): AgentRoleKey {
  const lower = agentName.toLowerCase()
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) {
      return role as AgentRoleKey
    }
  }
  return 'ceo'
}

function scoreFromRuns(
  runCount: number,
  failedCount: number,
  recentCount: number
): DepartmentHealth {
  if (runCount === 0) return 'DRIFTING'
  const failRate = failedCount / Math.max(runCount, 1)
  if (failRate > 0.5 || (recentCount === 0 && runCount > 0)) return 'CRITICAL'
  if (failRate > 0.2 || recentCount < 2) return 'DRIFTING'
  return 'ON_TRACK'
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const orgId = searchParams.get('orgId')

  try {
    // Fetch all companies or filter to specific org
    const allCompanies = await getCompanies()
    const companies = orgId
      ? allCompanies.filter(c => c.id === orgId || c.identifier === orgId)
      : allCompanies.slice(0, 1) // Default to first org if no orgId specified

    if (companies.length === 0) {
      // Return a graceful empty pulse rather than erroring
      const emptyPulse: CEOPulseRecord = {
        pulseId: new Date().toISOString(),
        org: 'Unknown',
        orgId: orgId ?? '',
        globalHealthPct: 0,
        departments: [],
        escalations: [],
        lastPulseAt: new Date().toISOString(),
      }
      return NextResponse.json(emptyPulse)
    }

    const company = companies[0]
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago

    // Fetch agents, issues, and runs in parallel
    const [agents, issues, runs] = await Promise.all([
      getAgents(company.id).catch(() => []),
      getIssues(company.id, { limit: 50 }).catch(() => []),
      getRuns(company.id, { limit: 50 }).catch(() => []),
    ])

    // Build per-role pulse data
    const roleGroups = new Map<AgentRoleKey, Agent[]>()
    for (const agent of agents) {
      const role = classifyAgentRole(agent.name)
      if (!roleGroups.has(role)) roleGroups.set(role, [])
      roleGroups.get(role)!.push(agent)
    }

    const departments: DepartmentPulse[] = []
    
    for (const [role, roleAgents] of Array.from(roleGroups.entries())) {
      if (role === 'ceo') continue // CEO is the auditor, not audited

      // Count runs for this role's agents
      const agentIds = new Set(roleAgents.map(a => a.id))
      const roleRuns = runs.filter(r => agentIds.has(r.agentId))
      const recentRuns = roleRuns.filter(r => {
        try { return new Date(r.startedAt ?? '') >= cutoffDate } catch { return false }
      })
      const failedRuns = roleRuns.filter(r => r.status === 'failed')

      const status = scoreFromRuns(roleRuns.length, failedRuns.length, recentRuns.length)
      
      // Find last completed task (run)
      const lastRun = recentRuns.sort((a: Run, b: Run) => {
        const ta = a.completedAt ? new Date(a.completedAt).getTime() : 0
        const tb = b.completedAt ? new Date(b.completedAt).getTime() : 0
        return tb - ta
      })[0]

      departments.push({
        role,
        status,
        lastTask: lastRun ? `Run ${lastRun.issueIdentifier}` : 'No recent tasks',
        lastTaskTime: lastRun?.completedAt ?? undefined,
        blockedTasks: issues.filter(i =>
          i.state?.group === 'started' &&
          agentIds.has(i.assigneeId ?? '')
        ).length,
        correctiveAction: null,
      })
    }

    // If no role groups found, create fallback department entries from raw agent names
    if (departments.length === 0 && agents.length > 0) {
      const seenRoles = new Set<string>()
      for (const agent of agents) {
        const role = classifyAgentRole(agent.name)
        if (role === 'ceo' || seenRoles.has(role)) continue
        seenRoles.add(role)
        departments.push({
          role,
          status: agent.status === 'active' ? 'ON_TRACK' : agent.status === 'error' ? 'CRITICAL' : 'DRIFTING',
          lastTask: 'Fetching...',
          lastTaskTime: agent.lastHeartbeat ?? undefined,
          blockedTasks: 0,
          correctiveAction: null,
        })
      }
    }

    // Compute global health percentage
    const onTrackCount = departments.filter(d => d.status === 'ON_TRACK').length
    const globalHealthPct = departments.length > 0
      ? Math.round((onTrackCount / departments.length) * 100)
      : 100

    // Identify escalations (CRITICAL departments)
    const escalations = departments
      .filter(d => d.status === 'CRITICAL')
      .map(d => `${d.role.toUpperCase()} is CRITICAL — immediate attention required`)

    const pulse: CEOPulseRecord = {
      pulseId: new Date().toISOString(),
      org: company.name,
      orgId: company.id,
      globalHealthPct,
      departments,
      escalations,
      lastPulseAt: new Date().toISOString(),
      nextPulseAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    }

    return NextResponse.json(pulse, {
      headers: {
        // Cache for 4 minutes (pulse cadence is 5 min, slight buffer)
        'Cache-Control': 'private, max-age=240',
      },
    })

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to generate CEO pulse'
    log.error({ err: error }, 'CEO pulse generation failed')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
