import { describe, it, expect } from 'vitest'
import {
  normalizeDashboard,
  deriveAttention,
  formatCents,
} from '@/lib/execution-dashboard'

const FULL_SNAPSHOT = {
  companyId: 'company_123',
  agents: { active: 4, running: 1, paused: 0, error: 2 },
  tasks: { open: 12, inProgress: 3, blocked: 2, done: 8 },
  costs: { monthSpendCents: 18450, monthBudgetCents: 50000, monthUtilizationPercent: 36.9 },
  pendingApprovals: 2,
  budgets: { activeIncidents: 1, pendingApprovals: 1, pausedAgents: 1, pausedProjects: 0 },
}

describe('normalizeDashboard', () => {
  it('passes through a complete snapshot', () => {
    const d = normalizeDashboard(FULL_SNAPSHOT, 'fallback')
    expect(d.companyId).toBe('company_123')
    expect(d.agents).toEqual({ active: 4, running: 1, paused: 0, error: 2 })
    expect(d.tasks.blocked).toBe(2)
    expect(d.costs.monthSpendCents).toBe(18450)
    expect(d.pendingApprovals).toBe(2)
    expect(d.budgets.activeIncidents).toBe(1)
  })

  it('zero-fills missing sections and falls back to the caller companyId', () => {
    const d = normalizeDashboard({}, 'company_fallback')
    expect(d.companyId).toBe('company_fallback')
    expect(d.agents).toEqual({ active: 0, running: 0, paused: 0, error: 0 })
    expect(d.tasks).toEqual({ open: 0, inProgress: 0, blocked: 0, done: 0 })
    expect(d.costs.monthBudgetCents).toBe(0)
    expect(d.pendingApprovals).toBe(0)
  })

  it('tolerates non-object and wrong-typed input without throwing', () => {
    for (const raw of [null, undefined, 'nope', 42, [], { agents: 'broken', tasks: null }]) {
      const d = normalizeDashboard(raw, 'c1')
      expect(d.companyId).toBe('c1')
      expect(d.agents.error).toBe(0)
    }
  })

  it('rejects non-finite numbers', () => {
    const d = normalizeDashboard({ tasks: { open: NaN, blocked: Infinity } }, 'c1')
    expect(d.tasks.open).toBe(0)
    expect(d.tasks.blocked).toBe(0)
  })
})

describe('deriveAttention', () => {
  it('returns nothing for a healthy workspace', () => {
    const d = normalizeDashboard({}, 'c1')
    expect(deriveAttention(d)).toEqual([])
  })

  it('orders signals errors → blocked → approvals → budget and sums budget signals', () => {
    const d = normalizeDashboard(FULL_SNAPSHOT, 'c1')
    const items = deriveAttention(d)
    expect(items.map((i) => i.key)).toEqual(['agent_errors', 'blocked', 'approvals', 'budget'])
    // 1 incident + 1 paused agent + 0 paused projects
    expect(items.find((i) => i.key === 'budget')?.count).toBe(2)
  })

  it('uses singular labels for count of one', () => {
    const d = normalizeDashboard({ agents: { error: 1 }, pendingApprovals: 1 }, 'c1')
    const items = deriveAttention(d)
    expect(items.find((i) => i.key === 'agent_errors')?.label).toBe('agent error')
    expect(items.find((i) => i.key === 'approvals')?.label).toBe('approval pending')
  })

  it('every item carries a non-empty assistant prompt', () => {
    const items = deriveAttention(normalizeDashboard(FULL_SNAPSHOT, 'c1'))
    for (const item of items) {
      expect(item.prompt.length).toBeGreaterThan(10)
    }
  })
})

describe('formatCents', () => {
  it('renders whole dollars without decimals', () => {
    expect(formatCents(50000)).toBe('$500')
    expect(formatCents(0)).toBe('$0')
  })

  it('renders fractional dollars with two decimals', () => {
    expect(formatCents(18450)).toBe('$184.50')
  })
})
