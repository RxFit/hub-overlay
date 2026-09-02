import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleWriteErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { listGSCSites } from '@/lib/google/search-console'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * GET /api/google/search-console/sites — verified Search Console sites.
 *
 * Counterpart to the GA4 property picker; same admin gating, since the site is
 * a tenant-level setting. Unverified sites are filtered out upstream so the
 * picker cannot offer something that would only 403 later.
 */
export const GET = withFault('google/search-console/sites', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  const role = (session?.user as Record<string, unknown>)?.role as string

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!['admin', 'superadmin'].includes(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  try {
    const sites = await listGSCSites(auth.accessToken)
    return NextResponse.json({ sites })
  } catch (err) {
    return googleWriteErrorResponse(err, 'Google Search Console', googleRouteCtx(req, '/api/google/search-console/sites'))
  }
})
