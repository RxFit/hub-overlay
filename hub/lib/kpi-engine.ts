import type { Issue, Run, Agent, LiveKPI, ProjectKPI, KPISource, KPIScope, KPIVisibility } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('kpi-engine')

/**
 * Derives operational KPIs from raw Paperclip data.
 *
 * HARDENING:
 * - Null-safe access on issue.state.group, run.startedAt, run.completedAt
 * - Try/catch wrapper — returns empty array on failure instead of throwing
 * - Structured logging
 */
export function computeOperationalKPIs(
  issues: Issue[],
  runs: Run[],
  agents: Agent[],
  companyId: string,
  companyName: string
): LiveKPI[] {
  try {
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    // -- Issues logic --
    let openIssues = 0
    let completedThisWeek = 0
    let totalCompleted = 0

    for (const issue of issues) {
      const group = issue.state?.group
      const isCompleted = group === 'completed'
      if (!isCompleted && group !== 'cancelled') {
        openIssues++
      }
      if (isCompleted) {
        totalCompleted++
        const updated = new Date(issue.updatedAt)
        if (!isNaN(updated.getTime()) && updated >= sevenDaysAgo) {
          completedThisWeek++
        }
      }
    }

    const completionRate = (totalCompleted + openIssues) > 0
      ? Math.round((totalCompleted / (totalCompleted + openIssues)) * 100)
      : 0

    // -- Runs logic --
    let runsLast24h = 0
    let failedThisWeek = 0
    let totalDurationMs = 0
    let completedRunsCount = 0

    for (const run of runs) {
      if (run.startedAt) {
        const started = new Date(run.startedAt)
        if (!isNaN(started.getTime()) && started >= oneDayAgo) {
          runsLast24h++
        }
      }
      if (run.status === 'failed') {
        const completedOrStarted = new Date(run.completedAt || run.startedAt || now.toISOString())
        if (!isNaN(completedOrStarted.getTime()) && completedOrStarted >= sevenDaysAgo) {
          failedThisWeek++
        }
      }
      if (run.status === 'completed' && run.durationMs != null) {
        totalDurationMs += run.durationMs
        completedRunsCount++
      }
    }

    // -- Agents logic --
    const activeAgents = agents.filter(a => a.status === 'active').length

    // -- Build LiveKPI array --
    const kpis: LiveKPI[] = []

    const base: Partial<LiveKPI> = {
      source: 'paperclip',
      scope: 'project',
      companyId,
      visibility: 'staff',
      updatedAt: now.toISOString(),
    }

    kpis.push({
      ...base,
      id: `kpi-open-issues-${companyId}`,
      label: `Open Issues (${companyName})`,
      value: openIssues,
      trend: 'active',
      trendDirection: 'neutral',
    } as LiveKPI)

    kpis.push({
      ...base,
      id: `kpi-completed-week-${companyId}`,
      label: `Completed This Week (${companyName})`,
      value: completedThisWeek,
      trend: completedThisWeek > 0 ? 'up' : 'flat',
      trendDirection: completedThisWeek > 0 ? 'up' : 'neutral',
    } as LiveKPI)

    kpis.push({
      ...base,
      id: `kpi-completion-rate-${companyId}`,
      label: `Completion Rate (${companyName})`,
      value: completionRate,
      unit: '%',
      trend: 'lifetime',
      trendDirection: completionRate >= 50 ? 'up' : 'down',
    } as LiveKPI)

    kpis.push({
      ...base,
      id: `kpi-active-agents-${companyId}`,
      label: `Active Agents (${companyName})`,
      value: activeAgents,
      trend: 'online',
      trendDirection: activeAgents > 0 ? 'up' : 'neutral',
    } as LiveKPI)

    kpis.push({
      ...base,
      id: `kpi-runs-24h-${companyId}`,
      label: `Agent Runs (24h) (${companyName})`,
      value: runsLast24h,
      trend: 'last 24h',
      trendDirection: runsLast24h > 0 ? 'up' : 'neutral',
    } as LiveKPI)

    return kpis
  } catch (err) {
    log.error({ err, companyId, companyName }, 'Failed to compute operational KPIs')
    return []
  }
}

/**
 * Computes a project's overall health score based on operational data.
 *
 * HARDENING:
 * - Null-safe access on issue.state.group
 * - Date validation before comparison
 * - Try/catch wrapper with default return
 */
export function computeProjectHealth(
  issues: Issue[],
  runs: Run[],
  agents: Agent[],
  company: { id: string; name: string; identifier: string; updatedAt: string }
): ProjectKPI {
  try {
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    let openIssues = 0
    let totalCompleted = 0
    let completedThisWeek = 0

    for (const issue of issues) {
      const group = issue.state?.group
      const isCompleted = group === 'completed'
      if (!isCompleted && group !== 'cancelled') {
        openIssues++
      }
      if (isCompleted) {
        totalCompleted++
        const updated = new Date(issue.updatedAt)
        if (!isNaN(updated.getTime()) && updated >= sevenDaysAgo) {
          completedThisWeek++
        }
      }
    }

    const completionRate = (totalCompleted + openIssues) > 0
      ? Math.round((totalCompleted / (totalCompleted + openIssues)) * 100)
      : 0

    let failedRuns = 0
    for (const run of runs) {
      if (run.status === 'failed') {
        const ts = new Date(run.completedAt || run.startedAt || now.toISOString())
        if (!isNaN(ts.getTime()) && ts >= sevenDaysAgo) {
          failedRuns++
        }
      }
    }

    const activeAgents = agents.filter(a => a.status === 'active').length

    // Find most recent activity timestamp across issues/runs
    let lastActivity = company.updatedAt || new Date(0).toISOString()
    if (issues.length > 0) {
      const latestIssue = [...issues].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
      if (new Date(latestIssue.updatedAt) > new Date(lastActivity)) lastActivity = latestIssue.updatedAt
    }
    if (runs.length > 0) {
      const latestRun = [...runs].sort((a, b) => {
        const aTime = new Date(a.completedAt || a.startedAt || '0').getTime()
        const bTime = new Date(b.completedAt || b.startedAt || '0').getTime()
        return bTime - aTime
      })[0]
      const latestRunTime = latestRun.completedAt || latestRun.startedAt
      if (latestRunTime && new Date(latestRunTime) > new Date(lastActivity)) lastActivity = latestRunTime
    }

    // Health logic
    let health: 'healthy' | 'at-risk' | 'critical' = 'healthy'
    if (completionRate < 30 || failedRuns > 5) {
      health = 'critical'
    } else if (completionRate <= 60 || failedRuns >= 3) {
      health = 'at-risk'
    }

    return {
      companyId: company.id,
      companyName: company.name,
      identifier: company.identifier,
      health,
      openIssues,
      completedThisWeek,
      completionRate,
      activeAgents,
      failedRuns,
      lastActivity,
    }
  } catch (err) {
    log.error({ err, companyId: company.id }, 'Failed to compute project health')
    return {
      companyId: company.id,
      companyName: company.name,
      identifier: company.identifier,
      health: 'critical',
      openIssues: 0,
      completedThisWeek: 0,
      completionRate: 0,
      activeAgents: 0,
      failedRuns: 0,
      lastActivity: new Date().toISOString(),
    }
  }
}

/**
 * Filters the list of KPIs based on user role and project assignments.
 */
export function filterByRole(
  kpis: LiveKPI[],
  role: string,
  assignedProjects: string[]
): LiveKPI[] {
  if (role === 'onboarding') return []
  if (role === 'superadmin' || role === 'admin') return kpis

  // Below admin (staff and any lower/unknown role): enforce BOTH visibility and
  // scope. A caller below admin must never receive an `admin`-visibility KPI —
  // mirrors the tiering in app/api/settings/kpis (non-admins see only
  // 'staff'/'public' visibility). `public`/`staff` KPIs (and legacy rows with
  // no visibility set) stay visible, gated only by scope/assignment.
  return kpis.filter(kpi => {
    if (kpi.visibility === 'admin') return false
    if (kpi.scope === 'global') return true
    if (kpi.companyId && assignedProjects.includes(kpi.companyId)) return true
    if (assignedProjects.includes('*')) return true
    return false
  })
}
