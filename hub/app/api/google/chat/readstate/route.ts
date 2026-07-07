import { NextRequest, NextResponse } from 'next/server'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { getSpaceReadState } from '@/lib/google'

export const runtime = 'nodejs'

/**
 * GET /api/google/chat/readstate?spaceId=spaces/XXXX
 * Returns the authenticated user's lastReadTime for a space.
 */
export async function GET(req: NextRequest) {
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
    const readState = await getSpaceReadState(auth.accessToken, spaceId)

    return NextResponse.json({
      spaceId,
      lastReadTime: readState.lastReadTime ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch read state'

    // Read state scope not yet granted — degrade gracefully. Must run BEFORE
    // the generic mapper, which would fold 403 into a reauth 401.
    if (message.includes('403') || message.includes('PERMISSION_DENIED')) {
      return NextResponse.json(
        { spaceId, lastReadTime: null, code: 'MISSING_SCOPE' },
        { status: 200 } // 200 so the client read hook doesn’t error — just returns null
      )
    }

    return googleApiErrorResponse(err)
  }
}
