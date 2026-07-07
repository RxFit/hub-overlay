import { describe, it, expect } from 'vitest'
import { computeOperationalKPIs, filterByRole } from '@/lib/kpi-engine'
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
