import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessAdminRoute } from '@/lib/roles'
import { withFault } from '@/lib/route-fault'
import { getSemanticSyncStatus } from '@/lib/semantic-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/semantic-sync — is the Stripe/Gmail → Semantic Brain feed
 * wired, and when did it last land?
 *
 * Admin/superadmin ONLY, enforced here (the middleware guards /admin pages,
 * not /api/admin/*) — mirrors /api/admin/semantic-brain-health.
 *
 * Per source: the env vars still missing, the resolved GCS location and data
 * store, and the cursor file (last success, last import operation and how it
 * ended). Also the service account's client id — the exact value the Google
 * Admin domain-wide-delegation form asks for. Never returns key material,
 * tokens, or synced content.
 */
export const GET = withFault('admin/semantic-sync', async () => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!canAccessAdminRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  const status = await getSemanticSyncStatus(AbortSignal.timeout(10_000))
  return NextResponse.json(status, { status: 200 })
})
