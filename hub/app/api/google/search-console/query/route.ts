import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleWriteErrorResponse } from '@/lib/google-session'
import { querySearchConsole, GSC_DIMENSIONS, type GSCDimension } from '@/lib/google/search-console'
import { getEffectivePrefs } from '@/lib/google/prefs-db'

export const runtime = 'nodejs'

/**
 * POST /api/google/search-console/query — run a search-analytics query.
 *
 * Read-only, `staff` and up, same posture as the GA4 report route: the site
 * comes from tenant settings rather than the request body, so a caller cannot
 * redirect the query at a property of their choosing.
 *
 * Two Search Console quirks are handled upstream and surfaced in the response
 * rather than silently distorting the answer: the ~16-month retention window
 * (an over-long range is clamped, not zero-filled) and rare-query anonymization
 * (query-dimensioned results carry a warning that their totals under-report).
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  const role = (session?.user as Record<string, unknown>)?.role as string

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!['staff', 'admin', 'superadmin'].includes(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  let body: { startDate?: string; endDate?: string; dimensions?: unknown; rowLimit?: number; searchType?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { gscSiteUrl } = await getEffectivePrefs()
  if (!gscSiteUrl) {
    return NextResponse.json(
      { error: 'No Search Console site configured. An admin can pick one in Settings.', code: 'NOT_CONFIGURED' },
      { status: 409 },
    )
  }

  if (!body.startDate || !body.endDate) {
    return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 })
  }

  // Drop anything that isn't a real dimension — an unknown one is a Google 400.
  const dimensions = Array.isArray(body.dimensions)
    ? (body.dimensions.filter(
        d => typeof d === 'string' && (GSC_DIMENSIONS as readonly string[]).includes(d),
      ) as GSCDimension[])
    : undefined

  try {
    const result = await querySearchConsole(auth.accessToken, {
      siteUrl: gscSiteUrl,
      startDate: body.startDate,
      endDate: body.endDate,
      dimensions,
      rowLimit: typeof body.rowLimit === 'number' ? body.rowLimit : undefined,
      searchType: typeof body.searchType === 'string' ? body.searchType : undefined,
    })
    return NextResponse.json({ result })
  } catch (err) {
    return googleWriteErrorResponse(err, 'Google Search Console')
  }
}
