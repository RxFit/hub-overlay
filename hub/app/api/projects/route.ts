import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCompanies, getProjects } from '@/lib/paperclip'
import { withFault } from '@/lib/route-fault'
import type { Project } from '@/types'

export const runtime = 'nodejs'

/**
 * GET /api/projects
 *
 * Returns Paperclip projects across all accessible companies,
 * enriched with companyName for dropdown display.
 *
 * Role scoping:
 *  - superadmin / admin → projects from all companies
 *  - staff              → projects from assignedProjects companies only
 *  - onboarding         → [] (empty)
 */
// withFault, and NO swallowing catch (spec Layer 9 #1): the 200 { projects:
// [], error } shape read as success to React Query, so an outage rendered as
// an empty project list. A throw is now a reported fault and a real error
// status; useProjects already degrades to [] on !res.ok. The PER-COMPANY
// skip below stays — one failing company should not empty the whole list.
export const GET = withFault('projects', async () => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = session.user as Record<string, unknown>
  const role = user.role as string
  const assignedProjects = (user.assignedProjects as string[]) ?? []

  // Onboarding users have no project access
  if (!role || role === 'onboarding') {
    return NextResponse.json({ projects: [] })
  }

  let companies = await getCompanies()

  // Staff: scope to assigned company IDs
  if (role === 'staff' && !assignedProjects.includes('*')) {
    companies = companies.filter(c => assignedProjects.includes(c.id))
  }

  // Fetch projects from all accessible companies in parallel
  const results = await Promise.all(
    companies.map(async (company) => {
      try {
        const projects = await getProjects(company.id)
        // Enrich each project with its parent company name
        return projects.map(p => ({
          ...p,
          companyName: company.name,
        }))
      } catch {
        // If a company's projects endpoint fails, skip it gracefully
        console.warn(`[/api/projects] Failed to fetch projects for ${company.name}`)
        return []
      }
    })
  )

  // Flatten and sort by updatedAt descending (most recent first)
  const allProjects: Project[] = results
    .flat()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

  return NextResponse.json(
    { projects: allProjects },
    { headers: { 'Cache-Control': 'private, max-age=30' } }
  )
})
