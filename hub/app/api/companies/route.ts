import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getCompanies } from '@/lib/paperclip'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * GET /api/companies
 *
 * Returns the list of Paperclip companies the current user is authorized to see.
 *
 * Role scoping:
 *  - superadmin / admin → all companies
 *  - staff              → only companies in session.user.assignedProjects
 *                         (if assignedProjects includes '*', returns all)
 *  - onboarding         → [] (empty — no access yet)
 *  - unauthenticated    → 401
 */
// withFault, and NO swallowing catch (spec Layer 9 #1): this route used to
// answer a live backend failure with 200 { companies: [], error } — React
// Query treated it as success and the UI rendered a confident empty state
// over an outage. A getCompanies() throw is now a logged, reported fault and
// a real error status; useCompanies already degrades to [] on !res.ok.
export const GET = withFault('companies', async () => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = session.user as Record<string, unknown>
  const role = user.role as string
  const assignedProjects = (user.assignedProjects as string[]) ?? []

  // Onboarding users have no company access
  if (!role || role === 'onboarding') {
    return NextResponse.json({ companies: [] })
  }

  const allCompanies = await getCompanies()

  // superadmin and admin see everything
  if (role === 'superadmin' || role === 'admin') {
    return NextResponse.json(
      { companies: allCompanies },
      { headers: { 'Cache-Control': 'private, max-age=60' } }
    )
  }

  // staff: filter to assigned project IDs
  if (assignedProjects.includes('*')) {
    return NextResponse.json(
      { companies: allCompanies },
      { headers: { 'Cache-Control': 'private, max-age=60' } }
    )
  }

  const scoped = allCompanies.filter(c => assignedProjects.includes(c.id))
  return NextResponse.json(
    { companies: scoped },
    { headers: { 'Cache-Control': 'private, max-age=60' } }
  )
})
