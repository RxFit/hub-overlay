import { describe, it, expect } from 'vitest'
import { computeOperationalKPIs, computeProjectHealth, filterByRole } from '@/lib/kpi-engine'
import type { Issue, Run, Agent, LiveKPI } from '@/types'

const now = new Date().toISOString()

function issue(group: string): Issue {
  return {
    id: `i-${Math.random()}`,
    title: 't',
    identifier: 'X-1',
    state: { group },
    priority: 'medium',
    updatedAt: now,
  } as unknown as Issue
}

describe('computeOperationalKPIs', () => {
  it('counts open issues, excluding completed and cancelled', () => {
    const issues = [issue('started'), issue('unstarted'), issue('completed'), issue('cancelled')]
    const agents = [{ id: 'a1', status: 'active' }] as unknown as Agent[]
    const runs: Run[] = []

    const kpis = computeOperationalKPIs(issues, runs, agents, 'c1', 'Acme')
    expect(kpis).toHaveLength(5)

    const open = kpis.find(k => k.id.startsWith('kpi-open-issues'))
    expect(open?.value).toBe(2) // started + unstarted

    const activeAgents = kpis.find(k => k.id.startsWith('kpi-active-agents'))
    expect(activeAgents?.value).toBe(1)
  })

  it('returns an empty array (never throws) on malformed input', () => {
    // null state on an issue must not crash the reducer
    const bad = [{ id: 'x', updatedAt: now } as unknown as Issue]
    const kpis = computeOperationalKPIs(bad, [], [], 'c1', 'Acme')
    expect(Array.isArray(kpis)).toBe(true)
  })
})

describe('computeProjectHealth', () => {
  const company = { id: 'c1', name: 'Acme', identifier: 'ACM', updatedAt: now }

  function run(status: Run['status'], completedAt: string | null = now): Run {
    return {
      id: `r-${Math.random()}`,
      status,
      startedAt: completedAt,
      completedAt,
      durationMs: 1000,
    } as unknown as Run
  }

  it('reports healthy when completion is strong and failures are low', () => {
    // 7 completed / 3 open → 70% completion, 0 failed runs → healthy
    const issues = [
      ...Array.from({ length: 7 }, () => issue('completed')),
      ...Array.from({ length: 3 }, () => issue('started')),
    ]
    const health = computeProjectHealth(issues, [run('completed')], [], company)
    expect(health.health).toBe('healthy')
    expect(health.completionRate).toBe(70)
    expect(health.openIssues).toBe(3)
    expect(health.completedThisWeek).toBe(7)
    expect(health.failedRuns).toBe(0)
  })

  it('degrades to at-risk when completion drops to 60% or below', () => {
    // 6 completed / 4 open → 60% → at-risk (boundary is inclusive)
    const issues = [
      ...Array.from({ length: 6 }, () => issue('completed')),
      ...Array.from({ length: 4 }, () => issue('started')),
    ]
    const health = computeProjectHealth(issues, [], [], company)
    expect(health.completionRate).toBe(60)
    expect(health.health).toBe('at-risk')
  })

  it('degrades to at-risk at 3+ failed runs this week even with strong completion', () => {
    const issues = Array.from({ length: 9 }, () => issue('completed')).concat([issue('started')])
    const runs = [run('failed'), run('failed'), run('failed')]
    const health = computeProjectHealth(issues, runs, [], company)
    expect(health.completionRate).toBe(90)
    expect(health.failedRuns).toBe(3)
    expect(health.health).toBe('at-risk')
  })

  it('goes critical below 30% completion or above 5 failed runs', () => {
    const lowCompletion = computeProjectHealth(
      [issue('completed'), ...Array.from({ length: 4 }, () => issue('started'))],
      [],
      [],
      company,
    )
    expect(lowCompletion.completionRate).toBe(20)
    expect(lowCompletion.health).toBe('critical')

    const manyFailures = computeProjectHealth(
      Array.from({ length: 10 }, () => issue('completed')),
      Array.from({ length: 6 }, () => run('failed')),
      [],
      company,
    )
    expect(manyFailures.failedRuns).toBe(6)
    expect(manyFailures.health).toBe('critical')
  })

  it('ignores failed runs OLDER than seven days', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const runs = Array.from({ length: 6 }, () => run('failed', tenDaysAgo))
    const health = computeProjectHealth(
      Array.from({ length: 10 }, () => issue('completed')),
      runs,
      [],
      company,
    )
    expect(health.failedRuns).toBe(0)
    expect(health.health).toBe('healthy')
  })

  it('picks the most recent activity across company, issues, and runs', () => {
    const older = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const newest = new Date().toISOString()
    const staleCompany = { ...company, updatedAt: older }

    const i = issue('completed')
    ;(i as unknown as { updatedAt: string }).updatedAt = older
    const latestRun = run('completed', newest)

    const health = computeProjectHealth([i], [latestRun], [], staleCompany)
    expect(health.lastActivity).toBe(newest)
  })

  it('counts active agents and an empty project defaults to critical (0% completion)', () => {
    const agents = [
      { id: 'a1', status: 'active' },
      { id: 'a2', status: 'inactive' },
    ] as unknown as Agent[]
    const health = computeProjectHealth([], [], agents, company)
    expect(health.activeAgents).toBe(1)
    expect(health.completionRate).toBe(0)
    expect(health.health).toBe('critical')
  })

  it('never throws on malformed input — returns a critical default instead', () => {
    // issues = null would crash the loop; the guard must catch it.
    const health = computeProjectHealth(
      null as unknown as Issue[],
      null as unknown as Run[],
      [],
      company,
    )
    expect(health.health).toBe('critical')
    expect(health.companyId).toBe('c1')
    expect(health.companyName).toBe('Acme')
  })
})

describe('filterByRole', () => {
  const kpis = [
    { id: 'g', scope: 'global' },
    { id: 'p1', scope: 'project', companyId: 'c1' },
    { id: 'p2', scope: 'project', companyId: 'c2' },
  ] as unknown as LiveKPI[]

  it('returns nothing for onboarding', () => {
    expect(filterByRole(kpis, 'onboarding', [])).toHaveLength(0)
  })

  it('returns everything for admins/superadmins', () => {
    expect(filterByRole(kpis, 'admin', [])).toHaveLength(3)
    expect(filterByRole(kpis, 'superadmin', [])).toHaveLength(3)
  })

  it('scopes staff to global + assigned-project KPIs', () => {
    const visible = filterByRole(kpis, 'staff', ['c1'])
    const ids = visible.map(k => k.id).sort()
    expect(ids).toEqual(['g', 'p1'])
  })

  it('gives staff with the wildcard assignment every KPI', () => {
    const visible = filterByRole(kpis, 'staff', ['*'])
    expect(visible.map(k => k.id).sort()).toEqual(['g', 'p1', 'p2'])
  })

  it('gives staff with no assignments only global KPIs', () => {
    const visible = filterByRole(kpis, 'staff', [])
    expect(visible.map(k => k.id)).toEqual(['g'])
  })

  it('denies an unknown role any project-scoped KPI (only global passes)', () => {
    const visible = filterByRole(kpis, 'contractor', [])
    expect(visible.map(k => k.id)).toEqual(['g'])
  })
})
