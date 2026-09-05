import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { readExecutionSnapshot } from '@/lib/execution-context'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/execution/pulse — the right panel's Pulse tab
 * (Phase 4 PR 1, docs/architecture/PHASE4_AGENTIC_PANEL_2026-09-05.md §3).
 *
 * Serves the SAME snapshot the chat route injects as the "Execution Layer"
 * prompt section, so what the panel shows and what the assistant knows can
 * never disagree. Scoped exactly like that injection: every signed-in user
 * sees their own AI actions and deep runs; the ai_runs ledger and the
 * dispatch rail are admin planes (null for staff — the client renders the
 * quiet admin-only tiles without calling for them).
 *
 * The snapshot never throws — a plane that fails reads as a `notices` entry
 * — so this route's only failure mode is auth.
 */
export const GET = withFault('execution/pulse', async () => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const snapshot = await readExecutionSnapshot({
    userEmail: user.email,
    isAdmin: canAccessAdminRoute(user.role),
  })
  return NextResponse.json({ snapshot })
})
