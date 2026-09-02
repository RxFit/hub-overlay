import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { resolveGoogleAuth, googleWriteErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { runGA4Report, type GA4ReportRequest } from '@/lib/google/analytics'
import { getEffectivePrefs } from '@/lib/google/prefs-db'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * POST /api/google/analytics/report — run a GA4 report.
 *
 * A READ, so it deliberately skips the interview → confirm-card → gate-token
 * pipeline that guards writes: "how did organic traffic do last month?" should
 * be answered, not negotiated. Available to `staff` and up (per decision 2).
 *
 * The property comes from tenant settings, never from the request body — a
 * caller must not be able to point this at an arbitrary property they happen to
 * have access to and read another tenant's numbers through the Hub.
 *
 * Field names are validated against the property's own metadata before the call
 * (including custom definitions), so a mistyped metric returns a message naming
 * the offending field instead of an opaque Google 400.
 */
export const POST = withFault('google/analytics/report', async (req: NextRequest) => {
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

  let body: Partial<GA4ReportRequest>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { ga4PropertyId } = await getEffectivePrefs()
  if (!ga4PropertyId) {
    return NextResponse.json(
      { error: 'No GA4 property configured. An admin can pick one in Settings.', code: 'NOT_CONFIGURED' },
      { status: 409 },
    )
  }

  const metrics = Array.isArray(body.metrics) ? body.metrics.filter(m => typeof m === 'string') : []
  if (!metrics.length) {
    return NextResponse.json({ error: 'At least one metric is required' }, { status: 400 })
  }
  if (!body.startDate || !body.endDate) {
    return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 })
  }

  try {
    const report = await runGA4Report(auth.accessToken, {
      propertyId: ga4PropertyId,
      startDate: body.startDate,
      endDate: body.endDate,
      metrics,
      dimensions: Array.isArray(body.dimensions)
        ? body.dimensions.filter(d => typeof d === 'string')
        : undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      orderByMetric: typeof body.orderByMetric === 'string' ? body.orderByMetric : undefined,
      orderDescending: body.orderDescending !== false,
    })
    return NextResponse.json({ report })
  } catch (err) {
    // A pre-flight validation failure is the caller's mistake, not Google's —
    // answer 400 with the offending field names so the query can be fixed.
    const message = err instanceof Error ? err.message : ''
    if (message.startsWith('GA4 report rejected before sending')) {
      return NextResponse.json({ error: message, code: 'INVALID_FIELDS' }, { status: 400 })
    }
    return googleWriteErrorResponse(err, 'Google Analytics', googleRouteCtx(req, '/api/google/analytics/report'))
  }
})
