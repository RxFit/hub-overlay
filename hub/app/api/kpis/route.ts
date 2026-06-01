import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { getCompanies, getIssues, getRuns, getAgents } from '@/lib/paperclip'
import { computeOperationalKPIs, computeProjectHealth, filterByRole } from '@/lib/kpi-engine'
import { readSheetValues } from '@/lib/google'
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
        const [issues, runs, agents] = await Promise.all([
          getIssues(company.id, { limit: 100 }).catch(() => []),
          getRuns(company.id, { limit: 50 }).catch(() => []),
          getAgents(company.id).catch(() => []),
        ])

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

    // 3. Optionally fetch business KPIs from Google Sheet
    const sheetId = process.env.NEXT_PUBLIC_KPI_SHEET_ID
    if (sheetId && (!requestedCompanyId || requestedCompanyId === 'all')) {
      try {
        const token = await getToken({ req })
        if (token?.accessToken) {
          const sheetData = await readSheetValues(token.accessToken as string, sheetId, 'KPIs!A2:E50')
          
          if (sheetData.values) {
            const now = new Date().toISOString()
            const sheetKpis: LiveKPI[] = sheetData.values
              .filter(row => row[0]) // must have label
              .map((row, i) => {
                const isUp = (row[3] ?? '').toLowerCase() !== 'down'
                return {
                  id: `sheet-kpi-${i}`,
                  label: row[0],
                  value: row[1] ?? '0',
                  trend: row[2] ?? '',
                  trendDirection: isUp ? 'up' : 'down',
                  source: 'sheet',
                  scope: 'global',
                  visibility: 'admin', // Default sheet KPIs to admin visibility
                  updatedAt: now,
                }
              })
            allKpis.push(...sheetKpis)
          }
        }
      } catch (err) {
        console.warn('Failed to fetch business KPIs from Google Sheet', err)
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
