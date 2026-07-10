import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCompanies, getIssues, getRuns, getAgents } from '@/lib/paperclip'
import { computeOperationalKPIs, computeProjectHealth, filterByRole } from '@/lib/kpi-engine'
import type { LiveKPI, ProjectKPI } from '@/types'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = session.user as Record<string, unknown>
  const role = user.role as string
  const assignedProjects = (user.assignedProjects as string[]) ?? []

  // Onboarding role gets no KPIs
  if (role === 'onboarding') {
    return NextResponse.json({ kpis: [], projects: [] })
  }

  const requestedCompanyId = req.nextUrl.searchParams.get('companyId')
  
  let allKpis: LiveKPI[] = []
  let allProjects: ProjectKPI[] = []

  try {
    // 1. Determine companies to query
    let targetCompanies = await getCompanies()

    if (role === 'staff' && !assignedProjects.includes('*')) {
      targetCompanies = targetCompanies.filter(c => assignedProjects.includes(c.id))
    }

    if (requestedCompanyId && requestedCompanyId !== 'all') {
      targetCompanies = targetCompanies.filter(c => c.id === requestedCompanyId)
    }

    // Limit to 5 for performance if not scoped
    if (!requestedCompanyId || requestedCompanyId === 'all') {
      targetCompanies = targetCompanies.slice(0, 5)
    }

    // 2. Fetch data from Paperclip
    const companyPromises = targetCompanies.map(async (company) => {
      try {
        // Fetch issues + agents once, then hand them to getRuns so it doesn't
        // re-fetch them internally (call-reduction P1). getRuns previously made
        // its OWN getIssues(limit:10) + getAgents per company on top of these —
        // reusing them removes 2 redundant upstream Paperclip calls per company
        // with no change to KPI/health outputs (the runs aggregated are identical:
        // getRuns takes the top-8 updated-desc issues, and the first 8 of the
        // limit-100 list match the first 8 of the old limit-10 list).
        const [issues, agents] = await Promise.all([
          getIssues(company.id, { limit: 100 }).catch(() => []),
          getAgents(company.id).catch(() => []),
        ])
        const runs = await getRuns(company.id, { limit: 50, issues, agents }).catch(() => [])

        const kpis = computeOperationalKPIs(issues, runs, agents, company.id, company.name)
        const health = computeProjectHealth(issues, runs, agents, company)

        return { kpis, health }
      } catch (err) {
        console.error(`Failed to fetch KPI data for company ${company.id}`, err)
        return { kpis: [], health: null }
      }
    })

    const results = await Promise.all(companyPromises)

    for (const res of results) {
      allKpis.push(...res.kpis)
      if (res.health) allProjects.push(res.health)
    }

    // 3. Fetch business KPIs from DB (replaces Google Sheet source)
    if (!requestedCompanyId || requestedCompanyId === 'all') {
      try {
        const { db } = await import('@/lib/db')
        const { kpis: kpisTable } = await import('@/lib/schema')
        const { eq } = await import('drizzle-orm')
        const { getTenantId } = await import('@/lib/tenant-context')
        const tenantId = getTenantId()

        const dbKpis = await db
          .select()
          .from(kpisTable)
          .where(eq(kpisTable.tenantId, tenantId))

        const now = new Date().toISOString()
        const businessKpis: LiveKPI[] = dbKpis.map(row => ({
          id: row.id,
          label: row.label,
          value: row.value,
          trend: row.trend ?? '',
          trendDirection: (row.trendDirection as 'up' | 'down' | 'neutral') ?? 'neutral',
          source: 'business' as const,   // DB-sourced business KPIs (migrated from Google Sheets)
          scope: (row.scope as 'global' | 'project') ?? 'global',
          visibility: (row.visibility as 'public' | 'staff' | 'admin') ?? 'staff',
          updatedAt: row.updatedAt?.toISOString() ?? now,
          companyId: row.companyId ?? undefined,
        }))
        allKpis.push(...businessKpis)
      } catch (err) {
        console.warn('[kpis] Failed to fetch business KPIs from DB:', err)
      }
    }

    // 4. Apply role-based filtering
    const visibleKpis = filterByRole(allKpis, role, assignedProjects)

    return NextResponse.json({
      kpis: visibleKpis,
      projects: allProjects
    })

  } catch (error) {
    console.error('API /api/kpis error:', error)
    return NextResponse.json({ kpis: [], projects: [], error: 'Failed to aggregate KPIs' }, { status: 500 })
  }
}
