import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleWriteErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { listGA4Properties } from '@/lib/google/analytics'

export const runtime = 'nodejs'

/**
 * GET /api/google/analytics/properties — GA4 properties the caller can read.
 *
 * Feeds the Settings picker that replaces the single hardcoded
 * `GA4_PROPERTY_ID`. Read-only and admin-gated: picking the property is a
 * tenant-level decision, so only the roles that can change tenant settings need
 * to enumerate the options.
 *
 * A grant predating `analytics.readonly` surfaces as MISSING_SCOPE so the
 * client can prompt a one-time re-consent rather than showing an empty picker.
 */
export async function GET(req: NextRequest) {
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
    const properties = await listGA4Properties(auth.accessToken)
    return NextResponse.json({ properties })
  } catch (err) {
    return googleWriteErrorResponse(err, 'Google Analytics', googleRouteCtx(req, '/api/google/analytics/properties'))
  }
}
