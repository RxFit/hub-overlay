import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCompanies, getDashboard } from '@/lib/paperclip'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/* ══════════════════════════════════════════════════════════════════════════════
   EXECUTION DASHBOARD API
   GET /api/paperclip/dashboard?orgId=[optional]

   Thin, read-only wrapper over Paperclip's company health snapshot
   (GET /api/companies/{id}/dashboard) for the right panel's Pulse header and
   Attention strip. Workspace scoping mirrors ceo-pulse: non-wildcard users
   only see companies in their assignedProjects, and asking for an existing
   company outside that set is a 403 (not a silent empty response).
   ══════════════════════════════════════════════════════════════════════════════ */

export const GET = withFault('paperclip/dashboard', async (req: Request) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const orgId = searchParams.get('orgId')

  const user = session.user as Record<string, unknown>
  const role = user.role as string
  const assignedProjects = (user.assignedProjects as string[]) ?? []

  const rawCompanies = await getCompanies()
  const hasWildcard = assignedProjects.includes('*') || role === 'superadmin'

  let allCompanies = [...rawCompanies]
  if (!hasWildcard) {
    allCompanies = allCompanies.filter(c => assignedProjects.includes(c.id))
  }

  if (orgId) {
    const existsGlobally = rawCompanies.some(c => c.id === orgId || c.identifier === orgId)
    const hasAccess = allCompanies.some(c => c.id === orgId || c.identifier === orgId)
    if (existsGlobally && !hasAccess) {
      return NextResponse.json(
        { error: 'Access denied: you are not assigned to this workspace' },
        { status: 403 }
      )
    }
  }

  const companies = orgId
    ? allCompanies.filter(c => c.id === orgId || c.identifier === orgId)
    : allCompanies
        .sort((a, b) => (a.identifier ?? a.name).localeCompare(b.identifier ?? b.name))
        .slice(0, 1) // Deterministic: alphabetical fallback from scoped set (same rule as ceo-pulse)

  if (companies.length === 0) {
    return NextResponse.json({ error: 'No accessible workspace found' }, { status: 404 })
  }

  const dashboard = await getDashboard(companies[0].id)

  return NextResponse.json(dashboard, {
    headers: {
      // The client polls at 60s; a 45s private cache absorbs tab-switch refetches.
      'Cache-Control': 'private, max-age=45',
    },
  })
})
