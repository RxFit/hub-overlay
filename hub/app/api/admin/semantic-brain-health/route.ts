import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { checkSemanticBrainHealth } from '@/lib/vertex-health'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * GET /api/admin/semantic-brain-health — is the Vertex AI Search connection up?
 *
 * Admin/superadmin ONLY, enforced here: the middleware guards /admin PAGES but
 * not /api/admin/*, so this route checks the role itself (mirrors
 * /api/admin/ai-health).
 *
 * Answers the question `searchSemanticBrain()` structurally cannot. That
 * function is fail-soft by design — a missing credential, a rejected JWT, a 403
 * on the engine and a genuinely empty index all come back as `null`/`[]`, and
 * the chat turn renders the same "no matching documents" note for all of them.
 * This walks the same path and reports WHICH stage broke, with the upstream
 * status and Google's own message.
 *
 * `?q=` overrides the probe query. Note that a probe matching zero documents is
 * still reported as HEALTHY — reaching the engine is the thing being tested.
 *
 * Returns 200 when healthy and 503 when not, so an uptime check can watch it
 * directly. The body is identical either way.
 */
export const GET = withFault('admin/semantic-brain-health', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  const probe = req.nextUrl.searchParams.get('q')?.trim()
  const report = await checkSemanticBrainHealth(probe || undefined)

  return NextResponse.json(report, { status: report.healthy ? 200 : 503 })
})
