import { NextRequest, NextResponse } from 'next/server'
import { resolveGoogleAuth, googleApiErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { listSpaceMembers } from '@/lib/google'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/**
 * GET /api/google/chat/members?spaceId=spaces/XXXX
 * Returns human members of a Google Chat space (for @mention picker).
 */
export const GET = withFault('google/chat/members', async (req: NextRequest) => {
  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  const spaceId = req.nextUrl.searchParams.get('spaceId')
  if (!spaceId) {
    return NextResponse.json(
      { error: 'spaceId query parameter is required' },
      { status: 400 }
    )
  }

  try {
    const memberships = await listSpaceMembers(auth.accessToken, spaceId)

    // Flatten to a simpler structure for the frontend
    const members = memberships.map(m => ({
      name: m.member.name,
      displayName: m.member.displayName,
      email: m.member.email ?? null,
      type: m.member.type,
      role: m.role,
    }))

    return NextResponse.json({ members })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch members'

    // Detect missing scope — keeps its dedicated 403 + MISSING_SCOPE code.
    // Must run BEFORE the generic mapper, which would fold 403 into a 401.
    if (message.includes('403') || message.includes('PERMISSION_DENIED')) {
      return NextResponse.json(
        { error: 'Missing Chat scope', code: 'MISSING_SCOPE', members: [] },
        { status: 403 }
      )
    }

    return googleApiErrorResponse(err, googleRouteCtx(req, '/api/google/chat/members'))
  }
})
