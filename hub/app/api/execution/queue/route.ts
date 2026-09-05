import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { readNeedsYou } from '@/lib/needs-you'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/execution/queue — the "Needs you" queue at the top of the Runs
 * tab (Phase 4 PR 2, docs/architecture/PHASE4_AGENTIC_PANEL_2026-09-05.md §5).
 *
 * Derived from the same ledgers as the Execution Layer prompt section, in the
 * same scope: every signed-in user sees their own failed actions and deep
 * runs; failed model runs and dispatch alerts are admin planes. The reader
 * never throws (each source fails open into `notices`), so this route's only
 * failure mode is auth.
 */
export const GET = withFault('execution/queue', async () => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const queue = await readNeedsYou({ userEmail: user.email, isAdmin: canAccessAdminRoute(user.role) })
  return NextResponse.json(queue)
})
