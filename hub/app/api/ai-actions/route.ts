import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { clampInt } from '@/lib/num'
import { listAiActions } from '@/lib/ai-audit'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * GET /api/ai-actions — read the AI-action audit trail (NS-2).
 *
 * Auth-required (401 when unauthenticated). By default returns the CALLER'S OWN
 * recent actions, newest first. `?limit=` is clamped to 1..200 (default 50).
 *
 * `?user=<email>` scopes the read to another user, but ONLY admins/superadmins
 * may do so (via canAccessAdminRoute). A non-admin asking for someone else's
 * trail is REJECTED with 403 (chosen over silently scoping-to-self so the
 * caller gets an explicit signal rather than misleading data).
 */
export const GET = withFault('ai-actions', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const self = user.email.toLowerCase().trim()
  const { searchParams } = req.nextUrl
  const limit = clampInt(searchParams.get('limit'), 50, 1, 200)

  const requestedUser = searchParams.get('user')?.toLowerCase().trim()
  let targetEmail = self
  if (requestedUser && requestedUser !== self) {
    if (!canAccessAdminRoute(user.role)) {
      return NextResponse.json(
        { error: 'Forbidden — only admins may read another user\'s AI-action history.' },
        { status: 403 }
      )
    }
    targetEmail = requestedUser
  }

  const actions = await listAiActions({ userEmail: targetEmail, limit })
  return NextResponse.json({ actions })
})
