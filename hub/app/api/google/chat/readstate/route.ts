import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { getSpaceReadState } from '@/lib/google'

export const runtime = 'nodejs'

/**
 * GET /api/google/chat/readstate?spaceId=spaces/XXXX
 * Returns the authenticated user's lastReadTime for a space.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req })
  if (!token?.accessToken) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'NO_TOKEN' },
      { status: 401 }
    )
  }

  const spaceId = req.nextUrl.searchParams.get('spaceId')
  if (!spaceId) {
    return NextResponse.json(
      { error: 'spaceId query parameter is required' },
      { status: 400 }
    )
  }

  try {
    const readState = await getSpaceReadState(
      token.accessToken as string,
      spaceId
    )

    return NextResponse.json({
      spaceId,
      lastReadTime: readState.lastReadTime ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch read state'

    // Read state scope not yet granted — degrade gracefully
    if (message.includes('403') || message.includes('PERMISSION_DENIED')) {
      return NextResponse.json(
        { spaceId, lastReadTime: null, code: 'MISSING_SCOPE' },
        { status: 200 } // 200 so SWR doesn't error — just returns null
      )
    }

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
