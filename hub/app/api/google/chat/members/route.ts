import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { listSpaceMembers } from '@/lib/google'

export const runtime = 'nodejs'

/**
 * GET /api/google/chat/members?spaceId=spaces/XXXX
 * Returns human members of a Google Chat space (for @mention picker).
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
    const memberships = await listSpaceMembers(
      token.accessToken as string,
      spaceId
    )

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

    // Detect missing scope
    if (message.includes('403') || message.includes('PERMISSION_DENIED')) {
      return NextResponse.json(
        { error: 'Missing Chat scope', code: 'MISSING_SCOPE', members: [] },
        { status: 403 }
      )
    }

    return NextResponse.json({ error: message, members: [] }, { status: 500 })
  }
}
