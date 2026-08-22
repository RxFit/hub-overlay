import { it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import {
  describeDb,
  migrateTestDb,
  resetDb,
  seedKpi,
  closeDb,
} from '../test/db-harness'
import type { Issue, Run, Agent } from '@/types'

/* ════════════════════════════════════════════════════════════════════════════
   DB-BACKED /api/kpis GET (NS-8).

   tests/kpi-routes.test.ts covers only the pre-DB early exits (401 and the
   onboarding empty response). THIS suite exercises the full aggregation path:
   Paperclip-derived operational KPIs (paperclip lib mocked — no network) MERGED
   with business KPIs read from the real `kpis` table, then role-filtered.

   Gated with describeDb — skips locally without DATABASE_URL, runs in CI.
   ════════════════════════════════════════════════════════════════════════════ */

const { state, paperclip } = vi.hoisted(() => ({
  state: { session: null as unknown },
  paperclip: {
    getCompanies: vi.fn(),
    getIssues: vi.fn(),
    getRuns: vi.fn(),
    getAgents: vi.fn(),
  },
}))

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(async () => state.session),
}))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/paperclip', () => paperclip)

import { GET } from '@/app/api/kpis/route'

const now = new Date().toISOString()

function completedIssue(): Issue {
  return {
    id: `i-${Math.random()}`,
    title: 't',
    identifier: 'X-1',
    state: { id: 's', name: 'Done', group: 'completed', color: '#0f0' },
    priority: 'medium',
    updatedAt: now,
    createdAt: now,
    companyId: 'c1',
  } as unknown as Issue
}

function req(qs = '') {
  return new NextRequest(`http://localhost/api/kpis${qs}`)
}

type KpiOut = { id: string; label: string; source: string; companyId?: string }

describeDb('GET /api/kpis — DB-backed aggregation', () => {
  beforeAll(() => {
    migrateTestDb()
  })

  beforeEach(async () => {
    await resetDb()
    state.session = { user: { email: 'admin@rxfitatx.com', role: 'admin', assignedProjects: [] } }

    paperclip.getCompanies.mockReset().mockResolvedValue([
      { id: 'c1', name: 'Acme', identifier: 'ACM', updatedAt: now },
      { id: 'c2', name: 'Globex', identifier: 'GLX', updatedAt: now },
    ])
    paperclip.getIssues.mockReset().mockResolvedValue([completedIssue()])
    paperclip.getRuns.mockReset().mockResolvedValue([])
    paperclip.getAgents.mockReset().mockResolvedValue([
      { id: 'a1', name: 'bot', adapter: 'x', status: 'active', companyId: 'c1', createdAt: now, description: null, lastHeartbeat: null } as Agent,
    ])
  })

  afterAll(async () => {
    await closeDb()
  })

  it('merges Paperclip operational KPIs with business KPIs from the DB', async () => {
    await seedKpi({
      label: 'Monthly Revenue',
      value: '42000',
      visibility: 'staff',
      scope: 'global',
      trend: '+12%',
      trendDirection: 'up',
    })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const { kpis, projects } = (await res.json()) as { kpis: KpiOut[]; projects: unknown[] }

    // Operational KPIs: 5 per company × 2 companies.
    const operational = kpis.filter((k) => k.source === 'paperclip')
    expect(operational).toHaveLength(10)

    // Business KPI came from the real DB row, fully mapped.
    const business = kpis.filter((k) => k.source === 'business')
    expect(business).toHaveLength(1)
    const rev = business[0] as KpiOut & { value: string; trend: string; trendDirection: string; scope: string; visibility: string; updatedAt: string }
    expect(rev.label).toBe('Monthly Revenue')
    expect(rev.value).toBe('42000')
    expect(rev.trend).toBe('+12%')
    expect(rev.trendDirection).toBe('up')
    expect(rev.scope).toBe('global')
    expect(rev.visibility).toBe('staff')
    expect(Number.isNaN(Date.parse(rev.updatedAt))).toBe(false)

    // Project health computed per company.
    expect(projects).toHaveLength(2)
  })

  it('scopes staff to their assigned companies but still shows global business KPIs', async () => {
    await seedKpi({ label: 'Monthly Revenue', scope: 'global' })
    state.session = {
      user: { email: 'staff@rxfitatx.com', role: 'staff', assignedProjects: ['c1'] },
    }

    const { kpis } = (await (await GET(req())).json()) as { kpis: KpiOut[] }

    // Only c1's operational KPIs survive both the company filter and role filter.
    const operational = kpis.filter((k) => k.source === 'paperclip')
    expect(operational).toHaveLength(5)
    expect(operational.every((k) => k.companyId === 'c1')).toBe(true)
    // getIssues was never called for the unassigned company.
    expect(paperclip.getIssues).toHaveBeenCalledTimes(1)
    expect(paperclip.getIssues).toHaveBeenCalledWith('c1', expect.anything())

    // The global business KPI is visible to staff.
    expect(kpis.filter((k) => k.source === 'business')).toHaveLength(1)
  })

  it('skips DB business KPIs when the request is scoped to one company', async () => {
    await seedKpi({ label: 'Monthly Revenue', scope: 'global' })

    const { kpis, projects } = (await (await GET(req('?companyId=c2'))).json()) as {
      kpis: KpiOut[]
      projects: unknown[]
    }

    expect(kpis.filter((k) => k.source === 'business')).toHaveLength(0)
    const operational = kpis.filter((k) => k.source === 'paperclip')
    expect(operational).toHaveLength(5)
    expect(operational.every((k) => k.companyId === 'c2')).toBe(true)
    expect(projects).toHaveLength(1)
  })

  it('degrades gracefully when a company’s Paperclip fetches fail (catch → empty)', async () => {
    paperclip.getIssues.mockRejectedValue(new Error('paperclip down'))
    paperclip.getRuns.mockRejectedValue(new Error('paperclip down'))
    paperclip.getAgents.mockRejectedValue(new Error('paperclip down'))
    await seedKpi({ label: 'Monthly Revenue', scope: 'global' })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const { kpis } = (await res.json()) as { kpis: KpiOut[] }

    // Operational KPIs still compute from empty inputs; business KPIs intact.
    expect(kpis.filter((k) => k.source === 'business')).toHaveLength(1)
    expect(kpis.filter((k) => k.source === 'paperclip')).toHaveLength(10)
  })

  /* Paperclip is retired, so getCompanies() now fails permanently. This used
     to 500 with an empty payload, which meant a dead upstream also suppressed
     the business KPIs the Hub reads from its OWN table two steps later. The
     contract is now: serve what the Hub owns, and say the response is
     degraded rather than looking healthy while missing half its data. */
  it('still serves Hub-native business KPIs when company discovery fails', async () => {
    paperclip.getCompanies.mockRejectedValue(new Error('total outage'))
    await seedKpi({ label: 'Monthly Revenue', value: '42000', scope: 'global', visibility: 'staff' })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kpis: KpiOut[]; projects: unknown[]; degraded?: boolean }

    // The Hub's own KPI survives the upstream outage — the point of the fix.
    const business = body.kpis.filter((k) => k.source === 'business')
    expect(business).toHaveLength(1)
    expect(business[0].label).toBe('Monthly Revenue')

    // Nothing Paperclip-derived can exist without companies, and the outage
    // is reported rather than swallowed.
    expect(body.kpis.filter((k) => k.source === 'paperclip')).toHaveLength(0)
    expect(body.projects).toEqual([])
    expect(body.degraded).toBe(true)

    // Discovery failed, so no per-company fetch should have been attempted.
    expect(paperclip.getIssues).not.toHaveBeenCalled()
  })

  it('omits the degraded flag entirely when Paperclip is healthy', async () => {
    await seedKpi({ label: 'Monthly Revenue', scope: 'global' })

    const body = (await (await GET(req())).json()) as { degraded?: boolean }

    // Additive-only: a healthy response is unchanged from before the fix.
    expect(body).not.toHaveProperty('degraded')
  })
})
